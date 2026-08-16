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

// This process is the only writer, so the cache only ever has to be dropped in
// saveSettings below. Without it every IPC handler re-reads and re-parses the
// file — including the server poll that runs every 15 seconds for the whole
// time the launcher is open.
let cache = null;

function loadSettings() {
  if (cache) return cache;

  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    // Deep-merge `toggles`: a plain top-level spread would replace the whole
    // toggles object, so a settings.json written by an older build (missing a
    // toggle key added later, e.g. `discord`) would leave that key undefined
    // and silently disable the feature. Merge sub-keys against the defaults.
    cache = {
      ...DEFAULTS,
      ...parsed,
      toggles: { ...DEFAULTS.toggles, ...(parsed && parsed.toggles) },
    };
  } catch (_) {
    cache = { ...DEFAULTS, toggles: { ...DEFAULTS.toggles } };
  }
  return cache;
}

// Written via a temp file + rename rather than straight over the real one.
// A plain writeFileSync truncates the target first, so a crash or a power cut
// mid-write leaves a half-written settings.json — which loadSettings can only
// treat as corrupt and silently replace with DEFAULTS. That loses installPath
// and installedVersion, so the launcher decides the game isn't installed and
// asks the player to re-download several gigabytes. rename() is atomic, so the
// file on disk is always either the old complete version or the new one.
function saveSettings(settings) {
  const merged = { ...loadSettings(), ...settings };
  const file = SETTINGS_FILE();
  const tempFile = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tempFile, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tempFile, file);
  // Publish only after the rename succeeded: if the write throws, callers must
  // keep seeing the values that are actually on disk.
  cache = merged;
  return merged;
}

module.exports = { loadSettings, saveSettings };
