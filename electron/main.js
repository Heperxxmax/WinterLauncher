const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { loadSettings, saveSettings } = require('./store');
const { queryServer } = require('../lib/aseQuery');
const { downloadFile } = require('../lib/downloader');
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

// Suggested base folder shown the first time the player is asked where to
// install the game. Never defaults to the launcher's own install directory
// (e.g. Program Files) since that requires admin rights to write into.
function suggestedInstallBase(config) {
  return path.join(app.getPath('documents'), config.game.installDirName);
}

function getInstallBase() {
  const settings = loadSettings();
  const config = loadConfig();
  return settings.installPath || suggestedInstallBase(config);
}

function getInstallPath() {
  return path.join(getInstallBase(), 'game');
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

  const config = loadConfig();
  const settings = loadSettings();
  discordRpc.setEnabled(settings.toggles.discord);
  if (settings.toggles.discord) discordRpc.connect(config.discord && config.discord.clientId);

  if (settings.toggles.autoUpdate) {
    mainWindow.webContents.once('did-finish-load', () => updater.checkForUpdates());
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
  const config = loadConfig();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Оберіть теку для встановлення гри',
    defaultPath: getInstallBase(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const base = path.join(result.filePaths[0], config.game.installDirName);
  saveSettings({ installPath: base });
  return path.join(base, 'game');
});

ipcMain.handle('app:reinstall-game', () => {
  const installPath = getInstallPath();
  fs.rmSync(installPath, { recursive: true, force: true });
  saveSettings({ installedVersion: null });
  return true;
});

let currentDownloadRequest = null;
let downloadCancelled = false;

ipcMain.handle('app:download-game', async (event) => {
  const config = loadConfig();
  const sender = event.sender;
  const installPath = getInstallPath();

  if (!config.game.downloadUrl) {
    throw new Error('Не вказано посилання для завантаження гри (config.json -> game.downloadUrl).');
  }

  fs.mkdirSync(installPath, { recursive: true });
  const tempFile = path.join(os.tmpdir(), `wintergta-setup-${Date.now()}.tmp`);
  downloadCancelled = false;

  try {
    await downloadFile(
      config.game.downloadUrl,
      tempFile,
      (fraction) => {
        sender.send('download:progress', { phase: 'downloading', fraction });
        discordRpc.setDownloading(fraction);
      },
      (req) => {
        currentDownloadRequest = req;
      }
    );
  } catch (err) {
    fs.unlink(tempFile, () => {});
    if (downloadCancelled) {
      sender.send('download:progress', { phase: 'cancelled', fraction: 0 });
      return false;
    }
    throw err;
  } finally {
    currentDownloadRequest = null;
  }

  sender.send('download:progress', { phase: 'installing', fraction: 1 });

  const isZip = config.game.downloadUrl.toLowerCase().endsWith('.zip');
  if (isZip) {
    const extractZip = require('extract-zip');
    // The archive's own top-level entry is "game/", which already matches the
    // "<installDir>/game" install path — extract one level up so we don't end
    // up with a doubled "game/game" nesting.
    await extractZip(tempFile, { dir: path.dirname(installPath) });
    fs.unlink(tempFile, () => {});
  } else {
    // Installer executable: run it and wait for completion.
    await new Promise((resolve, reject) => {
      const child = spawn(tempFile, ['/S'], { detached: false });
      child.on('exit', () => resolve());
      child.on('error', reject);
    });
    fs.unlink(tempFile, () => {});
  }

  saveSettings({ installedVersion: config.game.version || null });
  sender.send('download:progress', { phase: 'done', fraction: 1 });
  discordRpc.setIdle();
  return true;
});

ipcMain.on('app:cancel-download', () => {
  downloadCancelled = true;
  if (currentDownloadRequest) {
    currentDownloadRequest.destroy();
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
