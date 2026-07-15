const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  selectedServerId: null,
  installedVersion: null,
  installPath: null,
  volume: 70,
  toggles: {
    fullscreen: true,
    autoUpdate: true,
    sound: false,
    discord: true,
  },
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  const merged = { ...loadSettings(), ...settings };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { loadSettings, saveSettings };
