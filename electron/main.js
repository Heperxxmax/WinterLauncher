const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { loadSettings, saveSettings } = require('./store');
const { queryServer } = require('../lib/aseQuery');
const { downloadFile, getContentLength, hashFile } = require('../lib/downloader');
const { syncFromManifest, fetchManifest, verifyAgainstManifest } = require('../lib/manifest');
const log = require('../lib/logger');
const discordRpc = require('./discordRpc');
const updater = require('./updater');

let mainWindow = null;
let splashWindow = null;

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const ICON_PATH = path.join(__dirname, '..', 'src', 'assets', 'icon.ico');

// config.json never changes while the launcher runs in production, but it is
// read by almost every IPC handler — including the server poll that fires every
// 15 seconds. Cache it against the file's mtime so editing it during
// development still takes effect without a restart, while the steady state
// costs one stat() instead of a full read + JSON.parse.
let configCache = null;
let configCacheMtime = 0;

function loadConfig() {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch (_) {
    // Unreadable stat — fall through to a real read so the error surfaces there.
  }
  if (configCache && mtime && mtime === configCacheMtime) return configCache;

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  configCache = JSON.parse(raw);
  configCacheMtime = mtime;
  return configCache;
}

// fs.rename can't move across drives (EXDEV) — fall back to copy+delete when
// the staging folder and the player's chosen install drive differ.
//
// Async on purpose: the sync variants block the main process, and for a
// multi-gigabyte game folder that means the window stops repainting long
// enough for Windows to grey it out and label it "Не відповідає".
async function moveDir(src, dest) {
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.promises.cp(src, dest, { recursive: true });
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

// Smoothed transfer rate for the progress UI. A raw "bytes since the last
// sample" figure swings wildly on a chunked TCP stream, which makes the
// remaining-time estimate jump between 3 and 40 minutes and stop being worth
// showing. An exponential moving average stays readable while still following
// a genuine slowdown.
function createSpeedMeter() {
  let lastAt = 0;
  let lastBytes = 0;
  let average = 0;

  return {
    sample(received, total) {
      const now = Date.now();
      // First call after a (re)start, including a resume, only establishes the
      // baseline — otherwise already-downloaded bytes would register as an
      // impossible burst of speed.
      if (!lastAt) {
        lastAt = now;
        lastBytes = received;
        return { bytesPerSecond: 0, secondsLeft: null };
      }

      const elapsed = (now - lastAt) / 1000;
      if (elapsed <= 0) return { bytesPerSecond: Math.round(average), secondsLeft: null };

      const instant = (received - lastBytes) / elapsed;
      lastAt = now;
      lastBytes = received;
      average = average ? average * 0.7 + instant * 0.3 : instant;

      const secondsLeft = average > 0 && total
        ? Math.round(Math.max(0, total - received) / average)
        : null;
      return { bytesPerSecond: Math.round(average), secondsLeft };
    },
  };
}

// Free space on the drive holding `targetPath`, in bytes. Returns null if it
// can't be determined (older Node/OS quirk) so callers can skip the check
// rather than block the install on an unrelated failure.
async function getFreeSpaceBytes(targetPath) {
  try {
    const stats = await fs.promises.statfs(targetPath);
    return stats.bfree * stats.bsize;
  } catch (_) {
    return null;
  }
}

// Suggested base folder shown the first time the player is asked where to
// install the game. Never defaults to the launcher's own install directory
// (e.g. Program Files) since that requires admin rights to write into.
function suggestedInstallBase(config) {
  return path.join(app.getPath('documents'), config.game.installDirName);
}

function getInstallBase() {
  const settings = loadSettings();
  const config = loadConfig();
  if (settings.installPath && !isInsideLauncherDir(settings.installPath)) {
    return settings.installPath;
  }
  return suggestedInstallBase(config);
}

function getInstallPath() {
  return path.join(getInstallBase(), 'game');
}

// The game folder must never live inside the launcher's own install
// directory: launcher self-updates wipe and recreate that entire directory
// (standard NSIS "uninstall old version" step before laying down the new
// one), which would silently delete a nested game install along with it.
function isInsideLauncherDir(candidate) {
  if (!app.isPackaged) return false;
  const launcherDir = path.dirname(app.getPath('exe'));
  const rel = path.relative(launcherDir, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 300,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, '..', 'src', 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 1024,
    minHeight: 620,
    resizable: true,
    frame: false,
    backgroundColor: '#04060c',
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  const splashShownAt = Date.now();
  const MIN_SPLASH_MS = 1400;

  mainWindow.once('ready-to-show', () => {
    const elapsed = Date.now() - splashShownAt;
    const remaining = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(() => {
      closeSplashWindow();
      mainWindow.show();
    }, remaining);
  });

  if (process.env.LAUNCHER_DEBUG) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`[did-fail-load] ${code} ${desc}`);
    });
  }

  mainWindow.on('restore', () => {
    mainWindow.webContents.send('window:after-restore');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.wintergta.launcher');
}

// A second copy of the launcher must never run. Downloads resume through a
// fixed-name partial file inside the install folder, so two instances would
// append to the same .part and produce a corrupt archive that only reveals
// itself minutes later, when extraction fails. Refuse the second instance and
// surface the window that already exists instead.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  // A rejected promise or a throw outside a handler tears the main process down
  // with no window, no message and nothing written anywhere — the player just
  // sees the launcher vanish. Log it and keep running; anything genuinely fatal
  // will fail again visibly at the next user action.
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason instanceof Error ? reason : String(reason));
  });

  app.whenReady().then(() => {
    log.init(app.getPath('userData'));
    log.info(`version ${app.getVersion()}, electron ${process.versions.electron}`);

    createSplashWindow();
    createMainWindow();
    updater.setSender(mainWindow.webContents);

    // Wrapped so a malformed config.json / settings.json can't turn into an
    // unhandled promise rejection during startup — the window is already up and
    // the renderer surfaces its own load error through app:get-config.
    try {
      const config = loadConfig();
      const settings = loadSettings();
      discordRpc.setEnabled(settings.toggles.discord);
      if (settings.toggles.discord) discordRpc.connect(config.discord && config.discord.clientId);

      if (settings.toggles.autoUpdate) {
        mainWindow.webContents.once('did-finish-load', () => updater.checkForUpdates());
      }
    } catch (err) {
      log.error('Startup init failed', err);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: window controls ----
const WINDOW_ANIM_MS = 160;

ipcMain.on('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  event.sender.send('window:before-minimize');
  setTimeout(() => {
    if (!win.isDestroyed()) win.minimize();
  }, WINDOW_ANIM_MS);
});
ipcMain.on('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  event.sender.send('window:before-close');
  setTimeout(() => {
    if (!win.isDestroyed()) win.close();
  }, WINDOW_ANIM_MS);
});

// ---- IPC: config / data ----
ipcMain.handle('app:get-config', () => {
  const config = loadConfig();
  const settings = loadSettings();
  return { config, settings, version: app.getVersion() };
});

ipcMain.handle('app:query-servers', async () => {
  const config = loadConfig();
  const results = await Promise.all(
    config.servers.map(async (server) => {
      const queryPort = server.port + (server.queryPortOffset || 123);
      const result = await queryServer(server.host, queryPort);
      return {
        id: server.id,
        label: server.label,
        name: server.name,
        mode: server.mode || null,
        status: server.status || null,
        statusLabel: server.statusLabel || null,
        players: result ? result.players : null,
        maxPlayers: result ? result.maxPlayers : null,
        ping: result ? result.ping : null,
        online: !!result,
      };
    })
  );
  return results;
});

ipcMain.handle('app:get-install-state', () => {
  const config = loadConfig();
  const settings = loadSettings();
  const installPath = getInstallPath();
  const exePath = path.join(installPath, config.game.exeName);
  const installed = fs.existsSync(exePath);
  const latestVersion = config.game.version || null;
  const installedVersion = installed ? settings.installedVersion : null;
  const updateAvailable = installed && !!latestVersion && installedVersion !== latestVersion;
  return { installed, updateAvailable, installedVersion, latestVersion };
});

ipcMain.handle('app:get-install-path', () => getInstallPath());

ipcMain.handle('app:has-install-path', () => !!loadSettings().installPath);

ipcMain.handle('app:get-suggested-install-path', () => {
  const config = loadConfig();
  return suggestedInstallBase(config);
});

ipcMain.handle('app:use-default-install-path', () => {
  const config = loadConfig();
  const base = suggestedInstallBase(config);
  saveSettings({ installPath: base });
  return path.join(base, 'game');
});

ipcMain.handle('app:choose-install-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Оберіть теку для встановлення гри',
    defaultPath: getInstallBase(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  // Use exactly the folder the player picked — don't nest a branded
  // subfolder inside it, otherwise re-picking the same folder on a later
  // "Змінити" click would nest it again (…/WINTER GTA/WINTER GTA/game).
  const base = result.filePaths[0];

  if (isInsideLauncherDir(base)) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Непідходяща тека',
      message: 'Цю теку обрати не можна.',
      detail: 'Гру не можна встановлювати в теку самого лаунчера — під час оновлення лаунчера ця тека повністю очищується, і гра буде видалена разом з нею. Оберіть іншу теку.',
    });
    return null;
  }

  saveSettings({ installPath: base });
  return path.join(base, 'game');
});

ipcMain.handle('app:reinstall-game', async () => {
  const installPath = getInstallPath();
  try {
    await fs.promises.rm(installPath, { recursive: true, force: true });
  } catch (err) {
    // Most likely the game (or an antivirus scan) still has a file open —
    // rmSync throws EBUSY/EPERM in that case. Surface a message the player
    // can act on instead of leaving the button silently doing nothing.
    throw new Error('Не вдалося видалити попередню версію гри. Закрийте гру, якщо вона запущена, і спробуйте ще раз.');
  }
  saveSettings({ installedVersion: null });
  return true;
});

let currentDownloadRequest = null;
let downloadCancelled = false;
let downloadInProgress = false;

ipcMain.handle('app:download-game', async (event) => {
  if (downloadInProgress) {
    throw new Error('Завантаження вже триває.');
  }
  downloadInProgress = true;

  try {
    return await runDownload(event);
  } finally {
    downloadInProgress = false;
  }
});

// The launcher hands this URL to an HTTP client and then either unpacks or
// executes whatever comes back, so plain http would let anyone on the path
// swap several gigabytes of game for something else. Refuse it outright rather
// than trusting whoever edits config.json to remember.
function assertSecureUrl(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error(`Некоректне посилання (${label}).`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Посилання ${label} має використовувати https.`);
  }
}

// `game.downloadUrl` takes either a single URL or a list of mirrors. Falling
// through to the next entry when a host fails lets a blocked or dead mirror be
// routed around by editing config.json, with no new launcher build.
function resolveDownloadUrls(config) {
  const raw = config.game.downloadUrl;
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((url) => typeof url === 'string' && url.trim())
    .map((url) => url.trim());
}

// The download host answers with an HTTP status; the player sees a status
// line. A raw "Download failed: HTTP 403" gives them nothing to act on and
// hides the fact that the failure is on the hosting side, not on their PC —
// so translate the statuses that have a real, actionable cause.
function describeDownloadError(err, config) {
  if (!err || !err.statusCode) return err;
  const site = config.siteUrl ? ` Завантажте гру з сайту: ${config.siteUrl}` : '';
  if (err.botChallenge) {
    return new Error(
      `Сервер завантаження блокує лаунчер (захист від ботів на стороні хостингу).${site}`
    );
  }
  if (err.statusCode === 404 || err.statusCode === 410) {
    return new Error(
      'Файл гри не знайдено на сервері завантаження. Зачекайте, поки адміністрація оновить посилання.'
    );
  }
  if (err.statusCode === 401 || err.statusCode === 403) {
    return new Error(`Сервер завантаження відхилив запит (HTTP ${err.statusCode}).${site}`);
  }
  if (err.statusCode === 429) {
    return new Error('Забагато запитів до сервера завантаження. Спробуйте за кілька хвилин.');
  }
  if (err.statusCode >= 500) {
    return new Error(
      `Сервер завантаження тимчасово недоступний (HTTP ${err.statusCode}). Спробуйте пізніше.`
    );
  }
  return err;
}

async function runDownload(event) {
  const config = loadConfig();
  const sender = event.sender;
  const installBase = getInstallBase();
  const installPath = getInstallPath();

  // Preferred path when the build publishes a manifest: fetch only the files
  // that actually changed instead of the whole archive.
  if (config.game.manifestUrl) {
    return runManifestSync(event, config);
  }

  const downloadUrls = resolveDownloadUrls(config);
  if (!downloadUrls.length) {
    throw new Error('Не вказано посилання для завантаження гри (config.json -> game.downloadUrl).');
  }
  downloadUrls.forEach((url) => assertSecureUrl(url, 'game.downloadUrl'));

  const isZip = downloadUrls[0].toLowerCase().endsWith('.zip');

  // Staging area lives next to the install folder, on the same drive the
  // player picked in settings, so the download never touches the OS drive
  // and the final move is a same-drive rename instead of a cross-drive copy.
  const tempDir = path.join(installBase, '.wgta-tmp');

  let expectedSize = 0;
  for (const url of downloadUrls) {
    try {
      expectedSize = await getContentLength(url);
      break;
    } catch (_) {
      expectedSize = 0;
    }
  }

  if (expectedSize > 0) {
    // Zip installs need room for both the downloaded archive and its
    // extracted copy at the same time; installer .exe only needs the
    // download itself plus whatever it unpacks internally.
    const multiplier = isZip ? 2.2 : 1.3;
    const safetyMargin = 200 * 1024 * 1024;
    const required = expectedSize * multiplier + safetyMargin;
    const free = await getFreeSpaceBytes(installBase);
    if (free !== null && free < required) {
      const toGb = (bytes) => (bytes / (1024 ** 3)).toFixed(1);
      throw new Error(
        `Недостатньо вільного місця на диску для встановлення гри. ` +
        `Потрібно приблизно ${toGb(required)} ГБ, доступно ${toGb(free)} ГБ.`
      );
    }
  }

  // Don't mkdir installBase directly: if the player picked a bare drive
  // root ("F:\"), Windows returns EPERM for mkdir on an existing root even
  // though it's already there. Creating tempDir instead makes installBase
  // an intermediate directory in the recursive walk, never the mkdir target.
  // Created only once the space check has passed, so a failed check never
  // leaves an orphaned .wgta-tmp folder behind.
  await fs.promises.mkdir(tempDir, { recursive: true });
  await fs.promises.mkdir(installPath, { recursive: true });

  // Stable name, deliberately not timestamped: it is the resume point. A
  // download interrupted by a crash, a reboot or "Скасувати… ні, все ж таки
  // качаємо" picks up these bytes on the next run instead of re-fetching
  // several gigabytes. downloadFile discards it by itself if it belongs to a
  // different URL.
  const tempFile = path.join(tempDir, 'wintergta-download.part');
  downloadCancelled = false;

  // `onProgress` fires on every TCP chunk — for a multi-GB file that's up to
  // thousands of calls per second. Forwarding each one straight to an IPC
  // send saturates the event loop and visibly slows the download itself, so
  // only forward at most a few times a second.
  const PROGRESS_INTERVAL_MS = 200;
  let lastProgressAt = 0;
  const speed = createSpeedMeter();

  let downloaded = false;
  let lastError = null;

  for (const url of downloadUrls) {
    log.info(`download starting: ${url}`);

    try {
      await downloadFile(url, tempFile, {
        onProgress: (fraction, received, total) => {
          const now = Date.now();
          if (fraction < 1 && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          const { bytesPerSecond, secondsLeft } = speed.sample(received, total);
          sender.send('download:progress', {
            phase: 'downloading',
            fraction,
            received,
            total,
            bytesPerSecond,
            secondsLeft,
          });
          discordRpc.setDownloading(fraction);
        },
        onRequest: (req) => {
          currentDownloadRequest = req;
        },
        isCancelled: () => downloadCancelled,
        onRetry: ({ attempt, retries, delayMs }) => {
          // Tell the player the launcher is retrying rather than leaving the bar
          // frozen — a silent pause reads as a freeze and gets it killed.
          sender.send('download:progress', {
            phase: 'retrying',
            attempt,
            retries,
            delayMs,
          });
        },
      });
      downloaded = true;
    } catch (err) {
      if (downloadCancelled) {
        // An explicit cancel is the one case where the partial file is useless:
        // the player asked for it gone.
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        sender.send('download:progress', { phase: 'cancelled', fraction: 0 });
        return false;
      }
      // Any other failure keeps .wgta-tmp intact so the next attempt resumes.
      // downloadFile drops the partial by itself when the next mirror is a
      // different URL, so a half-file from a dead host is never appended to.
      lastError = err;
      log.warn(`download failed from ${url}: ${err && err.message}`);
    } finally {
      currentDownloadRequest = null;
    }

    if (downloaded) break;
    // Let the next mirror's first progress event through immediately instead
    // of waiting out the throttle left over from the failed one.
    lastProgressAt = 0;
  }

  if (!downloaded) {
    throw describeDownloadError(lastError, config) || new Error('Не вдалося завантажити гру.');
  }

  // Content-Length only proves the right *number* of bytes arrived, not the
  // right bytes — a flaky disk, bad RAM or a mangling proxy still yields a
  // corrupt archive that passes the size check and fails minutes later during
  // extraction. When the build publishes a hash, check it before unpacking and
  // throw the bad copy away so the retry actually re-fetches.
  if (config.game.sha256) {
    sender.send('download:progress', { phase: 'verifying', fraction: 0 });
    const expected = String(config.game.sha256).toLowerCase();
    let lastHashAt = 0;
    const actual = await hashFile(tempFile, {
      onProgress: (read) => {
        const now = Date.now();
        if (now - lastHashAt < PROGRESS_INTERVAL_MS) return;
        lastHashAt = now;
        const total = expectedSize || read;
        sender.send('download:progress', { phase: 'verifying', fraction: total ? read / total : 0 });
      },
    });

    if (actual !== expected) {
      log.error(`archive hash mismatch: expected ${expected}, got ${actual}`);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      throw new Error('Завантажений архів пошкоджено. Спробуйте завантажити ще раз.');
    }
    log.info('archive hash verified');
  }

  sender.send('download:progress', { phase: 'installing', fraction: 0 });

  try {
    if (isZip) {
      const extractZip = require('extract-zip');
      // Extracting straight into path.dirname(installPath) (relying on the
      // archive's own top-level "game/" entry to land in the right place)
      // breaks whenever the player's chosen base folder is a bare drive root
      // ("F:\"): extract-zip unconditionally mkdir's its target dir first,
      // and Windows refuses mkdir on a drive root (EPERM) even though it
      // already exists — unrelated to actual permissions. Extract into a
      // scratch staging folder instead, then move the archive's "game"
      // folder into place, so the extraction target is never a drive root.
      const stagingDir = path.join(tempDir, `wintergta-extract-${Date.now()}`);

      // Unpacking several gigabytes takes minutes. Without per-entry progress
      // the UI sits on a motionless "Встановлення..." the whole time, which is
      // indistinguishable from a hang.
      let entriesDone = 0;
      let lastExtractAt = 0;
      await extractZip(tempFile, {
        dir: stagingDir,
        onEntry: (_entry, zipfile) => {
          entriesDone += 1;
          const totalEntries = zipfile.entryCount || 0;
          if (!totalEntries) return;
          const now = Date.now();
          if (now - lastExtractAt < PROGRESS_INTERVAL_MS) return;
          lastExtractAt = now;
          sender.send('download:progress', {
            phase: 'installing',
            fraction: entriesDone / totalEntries,
          });
        },
      });

      sender.send('download:progress', { phase: 'installing', fraction: 1 });

      // An archive whose layout changed (no top-level "game/") would otherwise
      // surface as a bare ENOENT from rename, after the old install has already
      // been deleted. Check first, while there is still something to keep.
      const extractedGameDir = path.join(stagingDir, 'game');
      if (!fs.existsSync(extractedGameDir)) {
        throw new Error('Архів гри має неочікувану структуру: у ньому немає теки "game".');
      }

      await fs.promises.rm(installPath, { recursive: true, force: true });
      await moveDir(extractedGameDir, installPath);
    } else {
      // Installer executable: run it and wait for completion. A non-zero exit
      // code means the install failed — treating it as success would save
      // installedVersion, show "ГРАТИ", and break only at launch.
      await new Promise((resolve, reject) => {
        const child = spawn(tempFile, ['/S'], { detached: false });
        child.on('exit', (code) => {
          if (code === 0 || code === null) resolve();
          else reject(new Error(`Інсталятор завершився з помилкою (код ${code}).`));
        });
        child.on('error', reject);
      });
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }

  // Nothing above proves the game is actually usable: the archive may have
  // unpacked into an unexpected shape, or the silent installer may have exited
  // 0 without writing anything. Confirm the executable the launcher will try to
  // run really exists before recording the install as successful.
  const installedExe = path.join(installPath, config.game.exeName);
  if (!fs.existsSync(installedExe)) {
    log.error(`install finished but ${config.game.exeName} is missing in ${installPath}`);
    throw new Error(
      `Встановлення завершилось, але файл ${config.game.exeName} не знайдено. Спробуйте перевстановити гру.`
    );
  }

  saveSettings({ installedVersion: config.game.version || null });
  log.info(`install complete: version ${config.game.version || 'n/a'}`);
  sender.send('download:progress', { phase: 'done', fraction: 1 });
  discordRpc.setIdle();
  return true;
}

function hashCacheFile() {
  return path.join(app.getPath('userData'), 'filehashes.json');
}

// Manifest-driven install/update. Same entry points as the archive path, but
// only the files whose hash differs are fetched — a patch costs megabytes
// instead of the whole multi-gigabyte archive.
async function runManifestSync(event, config) {
  const sender = event.sender;
  const installPath = getInstallPath();
  assertSecureUrl(config.game.manifestUrl, 'game.manifestUrl');

  downloadCancelled = false;
  sender.send('download:progress', { phase: 'checking', fraction: 0 });
  log.info(`manifest sync starting: ${config.game.manifestUrl}`);

  const manifest = await fetchManifest(config.game.manifestUrl);
  assertSecureUrl(manifest.baseUrl, 'manifest baseUrl');
  await fs.promises.mkdir(installPath, { recursive: true });

  const speed = createSpeedMeter();
  let lastProgressAt = 0;

  try {
    const result = await syncFromManifest(installPath, manifest, hashCacheFile(), {
      isCancelled: () => downloadCancelled,
      onProgress: ({ phase, fraction, file }) => {
        const now = Date.now();
        if (fraction < 1 && now - lastProgressAt < 200) return;
        lastProgressAt = now;
        if (phase === 'downloading') discordRpc.setDownloading(fraction);
        sender.send('download:progress', { phase, fraction, file });
      },
    });
    log.info(`manifest sync done: ${result.fetched} fetched, ${result.pruned} pruned`);
  } catch (err) {
    if (downloadCancelled) {
      sender.send('download:progress', { phase: 'cancelled', fraction: 0 });
      return false;
    }
    log.error('manifest sync failed', err);
    throw err;
  } finally {
    currentDownloadRequest = null;
  }

  const installedExe = path.join(installPath, config.game.exeName);
  if (!fs.existsSync(installedExe)) {
    throw new Error(
      `Оновлення завершилось, але файл ${config.game.exeName} не знайдено. Спробуйте перевстановити гру.`
    );
  }

  saveSettings({ installedVersion: manifest.version || config.game.version || null });
  sender.send('download:progress', { phase: 'done', fraction: 1 });
  discordRpc.setIdle();
  return true;
}

// Re-checks every installed file against the manifest without reinstalling —
// the cheap answer to "гра не запускається" that used to mean re-downloading
// everything. Repairing reuses the same sync path, so only broken files move.
ipcMain.handle('app:verify-game', async (event) => {
  const config = loadConfig();
  if (!config.game.manifestUrl) {
    throw new Error('Перевірка цілісності доступна лише коли налаштовано manifestUrl.');
  }
  if (downloadInProgress) throw new Error('Завантаження вже триває.');

  const sender = event.sender;
  assertSecureUrl(config.game.manifestUrl, 'game.manifestUrl');
  const manifest = await fetchManifest(config.game.manifestUrl);

  let lastAt = 0;
  const report = await verifyAgainstManifest(getInstallPath(), manifest, hashCacheFile(), {
    onProgress: (fraction) => {
      const now = Date.now();
      if (fraction < 1 && now - lastAt < 200) return;
      lastAt = now;
      sender.send('download:progress', { phase: 'checking', fraction });
    },
  });

  sender.send('download:progress', { phase: 'done', fraction: 1 });
  log.info(`verify: ${report.okCount} ok, ${report.missing.length} missing, ${report.changed.length} changed`);
  return {
    ok: report.missing.length === 0 && report.changed.length === 0,
    okCount: report.okCount,
    missing: report.missing.length,
    changed: report.changed.length,
    extra: report.extra.length,
  };
});

ipcMain.handle('app:open-logs', () => {
  const file = log.getLogFile();
  if (!file) return false;
  shell.showItemInFolder(file);
  return true;
});

ipcMain.on('app:cancel-download', () => {
  downloadCancelled = true;
  if (currentDownloadRequest) {
    // destroy() with no argument doesn't reliably emit 'error' on the
    // request, so the download promise never settles and the UI is stuck
    // showing "downloading" forever — pass an error so it always does.
    currentDownloadRequest.destroy(new Error('Завантаження скасовано користувачем.'));
  }
});

ipcMain.handle('app:launch-game', async (event, serverId) => {
  const config = loadConfig();
  const installPath = getInstallPath();
  const exePath = path.join(installPath, config.game.exeName);

  if (!fs.existsSync(exePath)) {
    throw new Error('Гру не встановлено.');
  }

  const server = config.servers.find((s) => s.id === serverId) || config.servers[0];
  const args = server ? [`mtasa://${server.host}:${server.port}/`] : [];
  const sender = event.sender;

  const child = spawn(exePath, args, {
    cwd: installPath,
    detached: true,
    stdio: 'ignore',
  });
  discordRpc.setPlaying(server ? server.name : null);
  child.on('exit', () => {
    discordRpc.setIdle();
    if (!sender.isDestroyed()) sender.send('game:exited');
  });
  // A ChildProcess that emits 'error' with no listener throws and crashes the
  // whole main process. This fires if the exe can't actually start (deleted or
  // locked between the existsSync check and spawn, EACCES, etc.) — handle it so
  // the launcher survives and the UI is released from the "running" state.
  child.on('error', () => {
    discordRpc.setIdle();
    if (!sender.isDestroyed()) {
      sender.send('game:launch-error', 'Не вдалося запустити гру. Спробуйте перевстановити її.');
      sender.send('game:exited');
    }
  });
  child.unref();
  return true;
});

ipcMain.on('app:open-external', (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

// ---- IPC: settings panel state ----
ipcMain.handle('app:save-selected-server', (event, serverId) => {
  saveSettings({ selectedServerId: serverId });
  return true;
});

ipcMain.handle('app:save-volume', (event, volume) => {
  saveSettings({ volume: Number(volume) });
  return true;
});

ipcMain.handle('app:save-toggle', (event, key, value) => {
  const settings = loadSettings();
  const toggles = { ...settings.toggles, [key]: !!value };
  saveSettings({ toggles });
  if (key === 'discord') {
    discordRpc.setEnabled(!!value);
    if (value) {
      const config = loadConfig();
      discordRpc.connect(config.discord && config.discord.clientId);
    }
  }
  return toggles;
});

// ---- IPC: launcher self-update ----
ipcMain.handle('app:get-launcher-version', () => app.getVersion());
ipcMain.handle('app:check-launcher-update', () => updater.checkForUpdates());
ipcMain.handle('app:download-launcher-update', () => updater.downloadUpdate());
ipcMain.on('app:install-launcher-update', () => updater.quitAndInstall());
