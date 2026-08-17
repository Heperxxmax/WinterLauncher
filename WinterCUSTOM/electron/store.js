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
    const parsed = JSON.parse(raw);
    // Deep-merge `toggles`: a plain top-level spread would replace the whole
    // toggles object, so a settings.json written by an older build (missing a
    // toggle key added later, e.g. `discord`) would leave that key undefined
    // and silently disable the feature. Merge sub-keys against the defaults.
    return {
      ...DEFAULTS,
      ...parsed,
      toggles: { ...DEFAULTS.toggles, ...(parsed && parsed.toggles) },
    };
  } catch (_) {
    return { ...DEFAULTS, toggles: { ...DEFAULTS.toggles } };
  }
}

function saveSettings(settings) {
  const merged = { ...loadSettings(), ...settings };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { loadSettings, saveSettings };
