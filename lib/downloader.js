const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');
const { version: LAUNCHER_VERSION } = require('../package.json');

// No bytes received for this long *during* transfer → abort. Without it a
// connection that goes silent mid-download (dead proxy, dropped Wi-Fi) just
// freezes the progress bar forever, which players read as "the launcher is
// slow" when it's actually stuck.
const STALL_TIMEOUT_MS = 30000;

// No response headers within this long after the request is sent → abort.
// The stall timer above only exists once the response has started, so
// without this a server that accepts the connection but never replies would
// hang the whole download at 0% indefinitely.
const CONNECT_TIMEOUT_MS = 20000;

// Node's http/https modules send no User-Agent header at all, and "no user
// agent" is exactly what CDN and WAF bot filters reject before they ever look
// up the file — a 403 that has nothing to do with the file's permissions.
// Identify the launcher explicitly so the download host can allow-list it and
// so its access log shows who is asking.
const REQUEST_HEADERS = {
  'User-Agent': `WinterGTALauncher/${LAUNCHER_VERSION} (Windows; Electron)`,
  Accept: '*/*',
};

function clientFor(parsedUrl) {
  return parsedUrl.protocol === 'https:' ? https : http;
}

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

// A 403/503 answered with an HTML anti-bot interstitial (Cloudflare's "Just a
// moment...", flagged by `cf-mitigated`) is not a permissions problem with the
// file: the host is challenging the client before serving anything. No HTTP
// client can answer a browser JS challenge, so mark it separately — the fix
// belongs on the hosting side, and the message shown to the player has to say
// that rather than "forbidden".
function isBotChallenge(res) {
  if (res.headers['cf-mitigated']) return true;
  const type = String(res.headers['content-type'] || '');
  return (res.statusCode === 403 || res.statusCode === 503) && type.toLowerCase().includes('text/html');
}

// Carries the status alongside the message so callers can turn it into
// something the player can act on instead of a bare "HTTP 403".
function httpError(res, url) {
  const err = new Error(`Download failed: HTTP ${res.statusCode}`);
  err.statusCode = res.statusCode;
  err.url = url;
  err.botChallenge = isBotChallenge(res);
  return err;
}

function downloadFile(url, destPath, onProgress, onRequest) {
  return new Promise((resolve, reject) => {
    // Guards the *overall* promise: only the first hop to finish/fail wins.
    let finished = false;
    const settle = (fn, arg) => {
      if (finished) return;
      finished = true;
      fn(arg);
    };

    const request = (targetUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (_) {
        return settle(reject, new Error('Некоректне посилання для завантаження.'));
      }

      // Per-hop state. `hopClosed` makes every handler for this hop a no-op
      // once the hop has finished, failed, or been abandoned for a redirect —
      // so a late socket 'error' after we've already moved on can't reject
      // the promise or double-clean the temp file.
      let file = null;
      let timer = null;
      let hopClosed = false;

      const closeFileThenUnlink = (cb) => {
        if (file) file.close(() => fs.unlink(destPath, () => cb()));
        else cb();
      };

      const failHop = (err) => {
        if (hopClosed) return;
        hopClosed = true;
        clearTimeout(timer);
        closeFileThenUnlink(() => settle(reject, err));
      };

      const req = clientFor(parsed).get(targetUrl, { headers: REQUEST_HEADERS }, (res) => {
        if (hopClosed) {
          res.resume();
          return;
        }

        if (isRedirect(res.statusCode) && res.headers.location) {
          hopClosed = true;
          clearTimeout(timer);
          res.resume();
          if (redirectsLeft <= 0) {
            return settle(reject, new Error('Забагато перенаправлень.'));
          }
          // Location may be relative ("/files/game.zip") and the protocol may
          // change across the hop (https→http); resolving against the current
          // URL and re-picking the client per hop handles both.
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, targetUrl).toString();
          } catch (_) {
            return settle(reject, new Error('Сервер повернув некоректне перенаправлення.'));
          }
          request(nextUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode !== 200) {
          hopClosed = true;
          clearTimeout(timer);
          res.resume();
          return settle(reject, httpError(res, targetUrl));
        }

        const total = parseInt(res.headers['content-length'], 10) || 0;
        let received = 0;
        file = fs.createWriteStream(destPath);

        const armStall = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (hopClosed) return;
            try { res.destroy(); } catch (_) {}
            failHop(new Error('Завантаження зупинилося: немає даних від сервера.'));
          }, STALL_TIMEOUT_MS);
        };
        armStall();

        res.on('data', (chunk) => {
          if (hopClosed) return;
          armStall();
          received += chunk.length;
          if (onProgress) onProgress(total ? received / total : 0, received, total);
        });

        res.on('aborted', () => {
          failHop(new Error('З’єднання розірвано під час завантаження.'));
        });

        res.pipe(file);

        file.on('finish', () => {
          if (hopClosed) return;
          clearTimeout(timer);
          // A connection can close cleanly, with no error emitted, even though
          // fewer bytes arrived than Content-Length promised — leaving a
          // truncated file on disk that looks "downloaded" but is corrupt.
          // That is exactly what produces broken installs downstream (a zip
          // that only extracts partially, an installer that fails). Treat a
          // size mismatch as a failed download.
          if (total && received !== total) {
            failHop(new Error(
              `Файл завантажено не повністю (${received} з ${total} байт). Спробуйте ще раз.`
            ));
            return;
          }
          hopClosed = true;
          file.close(() => settle(resolve, destPath));
        });

        file.on('error', (err) => {
          try { res.destroy(); } catch (_) {}
          failHop(err);
        });
      });

      // Connection / TTFB guard, cleared as soon as the response arrives and
      // replaced by the per-chunk stall timer.
      timer = setTimeout(() => {
        if (hopClosed) return;
        hopClosed = true;
        try { req.destroy(); } catch (_) {}
        settle(reject, new Error('Час очікування відповіді від сервера вичерпано.'));
      }, CONNECT_TIMEOUT_MS);

      req.on('error', (err) => failHop(err));

      if (onRequest) onRequest(req);
    };

    request(url, 5);
  });
}

function getContentLength(url) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const settle = (fn, arg) => {
      if (finished) return;
      finished = true;
      fn(arg);
    };

    const request = (targetUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (_) {
        return settle(reject, new Error('Некоректне посилання.'));
      }

      const req = clientFor(parsed).request(targetUrl, { method: 'HEAD', headers: REQUEST_HEADERS }, (res) => {
        res.resume();
        if (isRedirect(res.statusCode) && res.headers.location) {
          if (redirectsLeft <= 0) return settle(reject, new Error('Забагато перенаправлень.'));
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, targetUrl).toString();
          } catch (_) {
            return settle(reject, new Error('Сервер повернув некоректне перенаправлення.'));
          }
          return request(nextUrl, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          return settle(reject, httpError(res, targetUrl));
        }
        settle(resolve, parseInt(res.headers['content-length'], 10) || 0);
      });

      // Without a timeout a hung HEAD would block the download from even
      // starting (progress frozen at 0% before the first byte). The caller
      // treats any failure here as "size unknown" and proceeds, so failing
      // fast is strictly better than hanging.
      req.setTimeout(CONNECT_TIMEOUT_MS, () => {
        req.destroy(new Error('Час очікування відповіді від сервера вичерпано.'));
      });
      req.on('error', (err) => settle(reject, err));
      req.end();
    };

    request(url, 5);
  });
}

module.exports = { downloadFile, getContentLength };
