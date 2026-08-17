const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  queryServers: () => ipcRenderer.invoke('app:query-servers'),
  getInstallState: () => ipcRenderer.invoke('app:get-install-state'),
  getInstallPath: () => ipcRenderer.invoke('app:get-install-path'),
  hasInstallPath: () => ipcRenderer.invoke('app:has-install-path'),
  getSuggestedInstallPath: () => ipcRenderer.invoke('app:get-suggested-install-path'),
  useDefaultInstallPath: () => ipcRenderer.invoke('app:use-default-install-path'),
  chooseInstallPath: () => ipcRenderer.invoke('app:choose-install-path'),
  downloadGame: () => ipcRenderer.invoke('app:download-game'),
  reinstallGame: () => ipcRenderer.invoke('app:reinstall-game'),
  cancelDownload: () => ipcRenderer.send('app:cancel-download'),
  launchGame: (serverId) => ipcRenderer.invoke('app:launch-game', serverId),
  saveSelectedServer: (serverId) => ipcRenderer.invoke('app:save-selected-server', serverId),
  saveVolume: (volume) => ipcRenderer.invoke('app:save-volume', volume),
  saveToggle: (key, value) => ipcRenderer.invoke('app:save-toggle', key, value),
  onDownloadProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  },
  onGameExited: (callback) => ipcRenderer.on('game:exited', callback),
  onGameLaunchError: (callback) => ipcRenderer.on('game:launch-error', (_e, message) => callback(message)),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  onBeforeMinimize: (callback) => ipcRenderer.on('window:before-minimize', callback),
  onBeforeClose: (callback) => ipcRenderer.on('window:before-close', callback),
  onAfterRestore: (callback) => ipcRenderer.on('window:after-restore', callback),
  getLauncherVersion: () => ipcRenderer.invoke('app:get-launcher-version'),
  checkLauncherUpdate: () => ipcRenderer.invoke('app:check-launcher-update'),
  downloadLauncherUpdate: () => ipcRenderer.invoke('app:download-launcher-update'),
  installLauncherUpdate: () => ipcRenderer.send('app:install-launcher-update'),
  onLauncherUpdateStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('launcher-update:status', listener);
    return () => ipcRenderer.removeListener('launcher-update:status', listener);
  },
});
