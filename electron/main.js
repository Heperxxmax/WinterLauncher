const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { loadSettings, saveSettings } = require('./store');
const { queryServer } = require('../lib/aseQuery');
const { downloadFile, getContentLength } = require('../lib/downloader');
const discordRpc = require('./discordRpc');
const updater = require('./updater');

let mainWindow = null;
let splashWindow = null;

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const ICON_PATH = path.join(__dirname, '..', 'src', 'assets', 'icon.ico');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

// fs.renameSync can't move across drives (EXDEV) — fall back to copy+delete
// when the staging folder (always on the OS temp drive) and the player's
// chosen install drive differ.
function moveDirSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
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

app.whenReady().then(() => {
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
    console.error('Startup init failed:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

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

ipcMain.handle('app:reinstall-game', () => {
  const installPath = getInstallPath();
  try {
    fs.rmSync(installPath, { recursive: true, force: true });
  } catch (err) {
    // Most likely the game (or an antivirus scan) still has a file open —
    // rmSync throws EBUSY/EPERM in that case. Surface a message the player
    // can act on instead of leaving the button silently doing nothing.
    throw new Error('Не вдалося видалити попередню версію гри. Закрийте гру, якщо вона запущена, і спробуйте ще раз.');
  }
  saveSettings({ installedVersion: null });
  return true;
});

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

async function runDownload(event) {
  const config = loadConfig();
  const sender = event.sender;
  const installBase = getInstallBase();
  const installPath = getInstallPath();

  const downloadUrls = resolveDownloadUrls(config);
  if (!downloadUrls.length) {
    throw new Error('Не вказано посилання для завантаження гри (config.json -> game.downloadUrl).');
  }

  // Staging area lives next to the install folder, on the same drive the
  // player picked in settings, so the download never touches the OS drive
  // and the final move is a same-drive rename instead of a cross-drive copy.
  const tempDir = path.join(installBase, '.wgta-tmp');
  const tempFile = path.join(tempDir, `wintergta-setup-${Date.now()}.tmp`);

  // `onProgress` fires on every TCP chunk — for a multi-GB file that's up to
  // thousands of calls per second. Forwarding each one straight to an IPC
  // send and an async Discord RPC call saturates the event loop and visibly
  // slows the download itself, so only forward at most a few times a second.
  const PROGRESS_INTERVAL_MS = 200;
  let lastProgressAt = 0;

  downloadCancelled = false;
  let downloadedUrl = null;
  let lastError = null;

  for (const url of downloadUrls) {
    let expectedSize = 0;
    try {
      expectedSize = await getContentLength(url);
    } catch (_) {
      expectedSize = 0;
    }

    if (expectedSize > 0) {
      // Zip installs need room for both the downloaded archive and its
      // extracted copy at the same time; installer .exe only needs the
      // download itself plus whatever it unpacks internally.
      const multiplier = url.toLowerCase().endsWith('.zip') ? 2.2 : 1.3;
      const safetyMargin = 200 * 1024 * 1024;
      const required = expectedSize * multiplier + safetyMargin;
      const free = await getFreeSpaceBytes(installBase);
      if (free !== null && free < required) {
        const toGb = (bytes) => (bytes / (1024 ** 3)).toFixed(1);
        // Not a mirror problem: every mirror serves the same file, so the
        // next one would fail this same check. Abort the whole install.
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
    fs.mkdirSync(tempDir, { recursive: true });

    fs.mkdirSync(installPath, { recursive: true });

    try {
      await downloadFile(
        url,
        tempFile,
        (fraction) => {
          const now = Date.now();
          if (fraction < 1 && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          sender.send('download:progress', { phase: 'downloading', fraction });
          discordRpc.setDownloading(fraction);
        },
        (req) => {
          currentDownloadRequest = req;
        }
      );
      downloadedUrl = url;
    } catch (err) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (downloadCancelled) {
        sender.send('download:progress', { phase: 'cancelled', fraction: 0 });
        return false;
      }
      lastError = err;
    } finally {
      currentDownloadRequest = null;
    }

    if (downloadedUrl) break;
    // The failed mirror may have moved the bar; let the next attempt's first
    // progress event through immediately instead of waiting out the throttle.
    lastProgressAt = 0;
  }

  if (!downloadedUrl) {
    throw describeDownloadError(lastError, config) || new Error('Не вдалося завантажити гру.');
  }

  const isZip = downloadedUrl.toLowerCase().endsWith('.zip');

  sender.send('download:progress', { phase: 'installing', fraction: 1 });

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
      await extractZip(tempFile, { dir: stagingDir });

      fs.rmSync(installPath, { recursive: true, force: true });
      moveDirSync(path.join(stagingDir, 'game'), installPath);
    } else {
      // Installer executable: run it and wait for completion.
      await new Promise((resolve, reject) => {
        const child = spawn(tempFile, ['/S'], { detached: false });
        child.on('exit', () => resolve());
        child.on('error', reject);
      });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  saveSettings({ installedVersion: config.game.version || null });
  sender.send('download:progress', { phase: 'done', fraction: 1 });
  discordRpc.setIdle();
  return true;
}

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
