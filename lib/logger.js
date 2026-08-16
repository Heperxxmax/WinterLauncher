const fs = require('fs');
const path = require('path');

// Kept small: this exists so a player can zip one file and send it to support,
// not for archaeology. One rotation keeps the previous session around, which is
// usually where the interesting failure is.
const MAX_BYTES = 512 * 1024;

let logFile = null;

// Every function here swallows its own errors. A launcher that fails to start
// because it could not write a log line would be worse than no logging at all.
function rotateIfNeeded() {
  try {
    if (fs.statSync(logFile).size < MAX_BYTES) return;
    fs.renameSync(logFile, `${logFile}.1`);
  } catch (_) {
    // Missing file (first run) or a locked rename — nothing to rotate.
  }
}

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'launcher.log');
    rotateIfNeeded();
    write('INFO', `--- launcher started (pid ${process.pid}) ---`);
  } catch (_) {
    logFile = null;
  }
}

function getLogFile() {
  return logFile;
}

function write(level, message) {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  if (process.env.LAUNCHER_DEBUG) console.log(line);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch (_) {}
}

function format(args) {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch (_) { return String(arg); }
    })
    .join(' ');
}

const info = (...args) => write('INFO', format(args));
const warn = (...args) => write('WARN', format(args));
const error = (...args) => write('ERROR', format(args));

module.exports = { init, info, warn, error, getLogFile };
