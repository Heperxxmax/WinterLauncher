const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let sender = null;

function send(channel, payload) {
  if (sender && !sender.isDestroyed()) sender.send(channel, payload);
}

autoUpdater.on('update-available', (info) => send('launcher-update:status', { phase: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => send('launcher-update:status', { phase: 'not-available' }));
autoUpdater.on('error', (err) => send('launcher-update:status', { phase: 'error', message: err.message }));
autoUpdater.on('download-progress', (progress) => send('launcher-update:status', { phase: 'downloading', fraction: progress.percent / 100 }));
autoUpdater.on('update-downloaded', () => send('launcher-update:status', { phase: 'downloaded' }));

function setSender(webContents) {
  sender = webContents;
}

async function checkForUpdates() {
  if (!require('electron').app.isPackaged) {
    send('launcher-update:status', { phase: 'not-available' });
    return null;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return result ? result.updateInfo : null;
  } catch (err) {
    send('launcher-update:status', { phase: 'error', message: err.message });
    return null;
  }
}

async function downloadUpdate() {
  await autoUpdater.downloadUpdate();
}

function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

module.exports = { setSender, checkForUpdates, downloadUpdate, quitAndInstall };
