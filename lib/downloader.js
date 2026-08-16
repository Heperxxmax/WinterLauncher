const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
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

const MAX_REDIRECTS = 5;

// The game archive is multiple gigabytes, so on a typical home connection a
// full download runs for 20+ minutes — long enough that a transient network
// drop is close to guaranteed. Retrying from a resumed byte range turns what
// used to be "start the whole 6.9 GB over" into a few seconds of delay.
const DEFAULT_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 30000;

// Node's http/https modules send no User-Agent header at all, and "no user
// agent" is by itself enough for many CDN and WAF bot filters to answer 403
// before they ever look up the file. Identify the launcher explicitly so the
// download host can allow-list it and so its access log shows who is asking.
const REQUEST_HEADERS = {
  'User-Agent': `WinterGTALauncher/${LAUNCHER_VERSION} (Windows; Electron)`,
  Accept: '*/*',
};

class DownloadError extends Error {
  constructor(
    message,
    { retryable = true, resetPartial = false, statusCode = null, botChallenge = false } = {}
  ) {
    super(message);
    this.retryable = retryable;
    this.resetPartial = resetPartial;
    // Carried so the caller can turn the failure into something the player can
    // act on instead of a bare "HTTP 403".
    this.statusCode = statusCode;
    this.botChallenge = botChallenge;
  }
}

// A 403/503 answered with an HTML anti-bot interstitial (Cloudflare's "Just a
// moment...", flagged by `cf-mitigated`) is not a permissions problem with the
// file: the host is challenging the client before serving anything. No HTTP
// client can answer a browser JS challenge, so it has to be told apart from a
// genuine "forbidden" — the fix belongs on the hosting side.
function isBotChallenge(res) {
  if (res.headers['cf-mitigated']) return true;
  const type = String(res.headers['content-type'] || '');
  return (res.statusCode === 403 || res.statusCode === 503)
    && type.toLowerCase().includes('text/html');
}

// Woken in short slices instead of one long timer so a cancel lands within a
// fraction of a second. Sleeping the full backoff in one go would leave the
// player staring at an unresponsive "Скасувати" for up to 30 seconds.
async function sleep(ms, isCancelled) {
  const STEP_MS = 200;
  for (let waited = 0; waited < ms; waited += STEP_MS) {
    if (isCancelled && isCancelled()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(STEP_MS, ms - waited)));
  }
}

function clientFor(parsedUrl) {
  return parsedUrl.protocol === 'https:' ? https : http;
}

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function metaPath(destPath) {
  return `${destPath}.meta`;
}

function partialSize(destPath) {
  try {
    return fs.statSync(destPath).size;
  } catch (_) {
    return 0;
  }
}

function readMeta(destPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(destPath), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeMeta(destPath, meta) {
  try {
    fs.writeFileSync(metaPath(destPath), JSON.stringify(meta), 'utf8');
  } catch (_) {
    // Losing the sidecar only costs the ability to resume — never fail the
    // download over it.
  }
}

function clearPartial(destPath) {
  try { fs.unlinkSync(destPath); } catch (_) {}
  try { fs.unlinkSync(metaPath(destPath)); } catch (_) {}
}

// One network attempt. Appends to `destPath` starting at `startAt` bytes and
// resolves once the file is complete. On failure the partial file is
// deliberately left on disk — the retry loop resumes from it.
function attemptDownload(startUrl, destPath, startAt, onProgress, onRequest) {
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
        return settle(reject, new DownloadError(
          'Некоректне посилання для завантаження.', { retryable: false }
        ));
      }

      // Per-hop state. `hopClosed` makes every handler for this hop a no-op
      // once the hop has finished, failed, or been abandoned for a redirect —
      // so a late socket 'error' after we've already moved on can't reject
      // the promise twice.
      let file = null;
      let timer = null;
      let hopClosed = false;

      const failHop = (err) => {
        if (hopClosed) return;
        hopClosed = true;
        clearTimeout(timer);
        // Close the stream but keep the bytes: they are the resume point.
        if (file) file.close(() => settle(reject, err));
        else settle(reject, err);
      };

      const headers = { ...REQUEST_HEADERS };
      if (startAt > 0) headers.Range = `bytes=${startAt}-`;

      const req = clientFor(parsed).get(targetUrl, { headers }, (res) => {
        if (hopClosed) {
          res.resume();
          return;
        }

        if (isRedirect(res.statusCode) && res.headers.location) {
          hopClosed = true;
          clearTimeout(timer);
          res.resume();
          if (redirectsLeft <= 0) {
            return settle(reject, new DownloadError('Забагато перенаправлень.', { retryable: false }));
          }
          // Location may be relative ("/files/game.zip") and the protocol may
          // change across the hop (https→http); resolving against the current
          // URL and re-picking the client per hop handles both.
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, targetUrl).toString();
          } catch (_) {
            return settle(reject, new DownloadError(
              'Сервер повернув некоректне перенаправлення.', { retryable: false }
            ));
          }
          request(nextUrl, redirectsLeft - 1);
          return;
        }

        // Our partial is at least as large as the file the server is now
        // offering — the archive was replaced mid-download. Start clean.
        if (res.statusCode === 416) {
          hopClosed = true;
          clearTimeout(timer);
          res.resume();
          return settle(reject, new DownloadError(
            'Файл на сервері змінився. Завантаження почнеться спочатку.',
            { resetPartial: true }
          ));
        }

        const resumed = res.statusCode === 206;
        if (res.statusCode !== 200 && !resumed) {
          hopClosed = true;
          clearTimeout(timer);
          res.resume();
          // 4xx means the request itself is wrong (bad URL, blocked by a WAF,
          // expired link) and will fail identically on every retry. Only
          // overload/outage codes are worth trying again — except a bot
          // challenge, which answers every retry the same way and would
          // otherwise burn the full backoff before reporting the failure.
          const botChallenge = isBotChallenge(res);
          const retryable = !botChallenge && (
            res.statusCode === 408
            || res.statusCode === 429
            || res.statusCode >= 500
          );
          return settle(reject, new DownloadError(
            `Download failed: HTTP ${res.statusCode}`,
            { retryable, statusCode: res.statusCode, botChallenge }
          ));
        }

        // A server that ignores Range answers 200 with the whole file, so the
        // bytes already on disk are worthless — rewind and overwrite.
        const baseOffset = resumed ? startAt : 0;
        const contentLength = parseInt(res.headers['content-length'], 10) || 0;
        let total = 0;
        if (resumed) {
          // "bytes 1024-6861652664/6861652665" — the figure after the slash is
          // the real full size, which is what the progress bar needs.
          const match = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
          total = match ? parseInt(match[1], 10) : baseOffset + contentLength;
        } else {
          total = contentLength;
        }

        writeMeta(destPath, { url: startUrl, total });

        let received = 0;
        file = fs.createWriteStream(destPath, { flags: resumed ? 'a' : 'w' });

        const armStall = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (hopClosed) return;
            try { res.destroy(); } catch (_) {}
            failHop(new DownloadError('Завантаження зупинилося: немає даних від сервера.'));
          }, STALL_TIMEOUT_MS);
        };
        armStall();

        res.on('data', (chunk) => {
          if (hopClosed) return;
          armStall();
          received += chunk.length;
          const done = baseOffset + received;
          if (onProgress) onProgress(total ? done / total : 0, done, total);
        });

        res.on('aborted', () => {
          failHop(new DownloadError('З’єднання розірвано під час завантаження.'));
        });

        res.pipe(file);

        file.on('finish', () => {
          if (hopClosed) return;
          clearTimeout(timer);
          const done = baseOffset + received;
          // A connection can close cleanly, with no error emitted, even though
          // fewer bytes arrived than Content-Length promised — leaving a
          // truncated file on disk that looks "downloaded" but is corrupt.
          // That is exactly what produces broken installs downstream (a zip
          // that only extracts partially, an installer that fails). Retry from
          // where it stopped rather than accepting the short file.
          if (total && done !== total) {
            failHop(new DownloadError(
              `Файл завантажено не повністю (${done} з ${total} байт).`,
              { resetPartial: done > total }
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
        settle(reject, new DownloadError('Час очікування відповіді від сервера вичерпано.'));
      }, CONNECT_TIMEOUT_MS);

      req.on('error', (err) => failHop(err));

      if (onRequest) onRequest(req);
    };

    request(startUrl, MAX_REDIRECTS);
  });
}

// Downloads `url` to `destPath`, resuming an interrupted partial file and
// retrying transient failures automatically.
//
// options:
//   onProgress(fraction, received, total)
//   onRequest(req)   — exposed so the caller can destroy() it to cancel
//   isCancelled()    — checked between attempts; stops the retry loop
//   onRetry({ attempt, retries, delayMs, message })
//   retries          — network attempts beyond the first
async function downloadFile(url, destPath, options = {}) {
  const {
    onProgress,
    onRequest,
    isCancelled = () => false,
    onRetry = () => {},
    retries = DEFAULT_RETRIES,
  } = options;

  // A leftover partial from a different URL (new game version, changed CDN)
  // must never be appended to — that silently produces a corrupt archive. A
  // partial with no sidecar has unknown provenance, so it goes too.
  const meta = readMeta(destPath);
  if (meta ? meta.url !== url : partialSize(destPath) > 0) {
    clearPartial(destPath);
  }

  for (let attempt = 0; ; attempt += 1) {
    if (isCancelled()) {
      throw new DownloadError('Завантаження скасовано користувачем.', { retryable: false });
    }

    try {
      await attemptDownload(url, destPath, partialSize(destPath), onProgress, onRequest);
      try { fs.unlinkSync(metaPath(destPath)); } catch (_) {}
      return destPath;
    } catch (err) {
      // A cancel destroys the request, which surfaces here as a socket error.
      // It must not be mistaken for a flaky network and retried.
      if (isCancelled()) throw err;

      if (err && err.resetPartial) clearPartial(destPath);

      const retryable = !err || err.retryable !== false;
      if (!retryable || attempt >= retries) throw err;

      // Exponential backoff: a router that just dropped its connection needs a
      // moment, and hammering the CDN immediately risks a 429 on top.
      const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      onRetry({
        attempt: attempt + 1,
        retries,
        delayMs,
        message: err ? err.message : '',
      });
      await sleep(delayMs, isCancelled);
    }
  }
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
          return settle(reject, new DownloadError(`HEAD failed: HTTP ${res.statusCode}`, {
            statusCode: res.statusCode,
            botChallenge: isBotChallenge(res),
          }));
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

    request(url, MAX_REDIRECTS);
  });
}

// Streamed, never buffered: the game archive is several gigabytes, which is far
// past what a single Buffer can hold. `onProgress(bytesRead)` lets long hashes
// drive a progress bar instead of looking like a freeze.
function hashFile(filePath, { algorithm = 'sha256', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    let read = 0;
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      read += chunk.length;
      if (onProgress) onProgress(read);
    });
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { downloadFile, getContentLength, hashFile, DownloadError };
