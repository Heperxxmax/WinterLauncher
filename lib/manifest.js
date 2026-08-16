// Differential game updates.
//
// Shipping a new build as "download the archive again" costs every player
// another ~7 GB for what is usually a few megabytes of changed files. A
// manifest lists every file with its size and sha256; the launcher hashes what
// is already on disk, fetches only the entries that differ, and (optionally)
// removes files the manifest no longer lists.
//
// Manifest format:
//   {
//     "version": "1.0.2",
//     "baseUrl": "https://winter.nukshn.com/game/",   // optional
//     "pruneExtras": false,                            // optional
//     "files": [ { "path": "MTA/x.dll", "size": 123, "sha256": "abc..." } ]
//   }

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const { downloadFile, hashFile } = require('./downloader');
const log = require('./logger');

const FETCH_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

function fetchJson(url) {
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
        return settle(reject, new Error('Некоректне посилання на маніфест.'));
      }

      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(targetUrl, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return settle(reject, new Error('Забагато перенаправлень.'));
          let next;
          try {
            next = new URL(res.headers.location, targetUrl).toString();
          } catch (_) {
            return settle(reject, new Error('Некоректне перенаправлення.'));
          }
          return request(next, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return settle(reject, new Error(`Маніфест недоступний: HTTP ${res.statusCode}`));
        }

        let body = '';
        let size = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          size += chunk.length;
          // A manifest is a few MB at most. Without a cap, a wrong URL pointing
          // at the game archive itself would buffer gigabytes into memory.
          if (size > MAX_MANIFEST_BYTES) {
            res.destroy();
            return settle(reject, new Error('Маніфест завеликий.'));
          }
          body += chunk;
        });
        res.on('end', () => {
          try {
            settle(resolve, JSON.parse(body));
          } catch (_) {
            settle(reject, new Error('Маніфест пошкоджено.'));
          }
        });
      });

      req.setTimeout(FETCH_TIMEOUT_MS, () => {
        req.destroy(new Error('Час очікування маніфесту вичерпано.'));
      });
      req.on('error', (err) => settle(reject, err));
    };

    request(url, MAX_REDIRECTS);
  });
}

// The manifest arrives over the network, so every path in it is untrusted
// input. An entry like "../../Windows/System32/x.dll" would otherwise let a
// compromised or misconfigured manifest write anywhere on the player's disk.
// Accept only plain relative paths that stay inside the install folder.
function safeRelativePath(entryPath) {
  if (typeof entryPath !== 'string' || !entryPath) return null;
  if (path.isAbsolute(entryPath) || /^[A-Za-z]:/.test(entryPath)) return null;
  const normalized = path.normalize(entryPath).replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) return null;
  return normalized;
}

function normalizeManifest(raw, manifestUrl) {
  if (!raw || !Array.isArray(raw.files)) {
    throw new Error('Маніфест не містить списку файлів.');
  }

  const files = [];
  for (const entry of raw.files) {
    const relPath = safeRelativePath(entry && entry.path);
    if (!relPath) {
      log.warn('manifest: rejected unsafe path', entry && entry.path);
      continue;
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      log.warn('manifest: entry without a valid sha256', relPath);
      continue;
    }
    files.push({
      path: relPath,
      size: Number(entry.size) || 0,
      sha256: entry.sha256.toLowerCase(),
    });
  }

  if (files.length === 0) throw new Error('Маніфест порожній або пошкоджений.');

  // Relative baseUrl resolves against the manifest's own location, so moving
  // the whole set to another host only means changing one URL.
  const baseUrl = new URL(raw.baseUrl || '.', manifestUrl).toString();

  return {
    version: raw.version ? String(raw.version) : null,
    baseUrl,
    pruneExtras: raw.pruneExtras === true,
    files,
  };
}

async function fetchManifest(manifestUrl) {
  const raw = await fetchJson(manifestUrl);
  return normalizeManifest(raw, manifestUrl);
}

// ---- local hash cache ----
//
// Hashing the whole install (several GB) on every check would take minutes of
// disk I/O. Files whose size and mtime are unchanged since the last hash are
// taken on trust, which turns the usual "nothing changed" case into a walk of
// stat() calls.

function loadHashCache(cacheFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveHashCache(cacheFile, cache) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tempFile = `${cacheFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(cache), 'utf8');
    fs.renameSync(tempFile, cacheFile);
  } catch (err) {
    log.warn('manifest: could not persist hash cache', err.message);
  }
}

async function hashLocalFile(absPath, relPath, cache) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (_) {
    return null;
  }
  if (!stat.isFile()) return null;

  const cached = cache[relPath];
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.sha256;
  }

  const sha256 = await hashFile(absPath);
  cache[relPath] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256 };
  return sha256;
}

function walkFiles(root, prefix = '') {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return found;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walkFiles(path.join(root, entry.name), rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

// Compares the install folder against the manifest. `onProgress(fraction)` is
// driven by how many entries have been checked, not bytes, so it advances
// smoothly through the many-small-files case too.
async function verifyAgainstManifest(installPath, manifest, cacheFile, { onProgress, isCancelled } = {}) {
  const cache = loadHashCache(cacheFile);
  const missing = [];
  const changed = [];
  let checked = 0;

  for (const entry of manifest.files) {
    if (isCancelled && isCancelled()) throw new Error('Перевірку скасовано.');

    const absPath = path.join(installPath, entry.path);
    const actual = await hashLocalFile(absPath, entry.path, cache);
    if (actual === null) missing.push(entry);
    else if (actual !== entry.sha256) changed.push(entry);

    checked += 1;
    if (onProgress) onProgress(checked / manifest.files.length);
  }

  const expected = new Set(manifest.files.map((f) => f.path));
  const extra = walkFiles(installPath).filter((rel) => !expected.has(rel));

  saveHashCache(cacheFile, cache);
  return { missing, changed, extra, okCount: manifest.files.length - missing.length - changed.length };
}

// Downloads every file that is missing or differs, then optionally prunes
// files the manifest no longer lists. Each file lands on a .part next to its
// final location and is renamed into place only once its hash checks out, so an
// interrupted sync never leaves a half-written game file behind.
async function syncFromManifest(installPath, manifest, cacheFile, options = {}) {
  const { onProgress, isCancelled, onFile } = options;

  const report = await verifyAgainstManifest(installPath, manifest, cacheFile, {
    onProgress: (fraction) => onProgress && onProgress({ phase: 'checking', fraction }),
    isCancelled,
  });

  const queue = [...report.missing, ...report.changed];
  const totalBytes = queue.reduce((sum, entry) => sum + entry.size, 0);
  log.info(`manifest: ${queue.length} file(s) to fetch, ${totalBytes} byte(s); ${report.extra.length} extra`);

  const cache = loadHashCache(cacheFile);
  let doneBytes = 0;

  for (const entry of queue) {
    if (isCancelled && isCancelled()) throw new Error('Оновлення скасовано.');

    const absPath = path.join(installPath, entry.path);
    const partPath = `${absPath}.part`;
    const fileUrl = new URL(entry.path, manifest.baseUrl).toString();
    if (onFile) onFile(entry.path);

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    await downloadFile(fileUrl, partPath, {
      isCancelled,
      onProgress: (_fraction, received) => {
        if (!onProgress) return;
        onProgress({
          phase: 'downloading',
          fraction: totalBytes ? (doneBytes + received) / totalBytes : 0,
          file: entry.path,
        });
      },
    });

    const actual = await hashFile(partPath);
    if (actual !== entry.sha256) {
      try { fs.unlinkSync(partPath); } catch (_) {}
      throw new Error(`Файл ${entry.path} завантажено з помилкою. Спробуйте ще раз.`);
    }

    fs.rmSync(absPath, { force: true });
    fs.renameSync(partPath, absPath);

    const stat = fs.statSync(absPath);
    cache[entry.path] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256: entry.sha256 };
    doneBytes += entry.size;
  }

  // Off by default: the game folder also accumulates things the player owns —
  // screenshots, custom settings — and deleting those would be its own bug
  // report. Builds that genuinely need stale files gone opt in per manifest.
  if (manifest.pruneExtras) {
    for (const rel of report.extra) {
      try {
        fs.rmSync(path.join(installPath, rel), { force: true });
        delete cache[rel];
      } catch (err) {
        log.warn('manifest: could not remove extra file', rel, err.message);
      }
    }
  }

  saveHashCache(cacheFile, cache);
  return { fetched: queue.length, pruned: manifest.pruneExtras ? report.extra.length : 0 };
}

module.exports = {
  fetchManifest,
  verifyAgainstManifest,
  syncFromManifest,
  safeRelativePath,
  normalizeManifest,
};
