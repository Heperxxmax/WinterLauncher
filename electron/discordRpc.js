const { Client } = require('@xhayper/discord-rpc');

let client = null;
let clientId = null;
let connecting = false;
let reconnectTimer = null;
let enabled = true;
let startTimestamp = null;

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(clientId), 15000);
}

async function connect(id) {
  if (!id || !enabled) return;
  clientId = id;
  if (client || connecting) return;
  connecting = true;
  try {
    client = new Client({ clientId: id });
    client.on('disconnected', () => {
      client = null;
      scheduleReconnect();
    });
    await client.login();
    startTimestamp = Date.now();
    setIdle();
  } catch (_err) {
    client = null;
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function disconnect() {
  clearTimeout(reconnectTimer);
  if (client) {
    client.destroy().catch(() => {});
    client = null;
  }
}

function setEnabled(value) {
  enabled = !!value;
  if (!enabled) disconnect();
  else if (clientId) connect(clientId);
}

async function setActivity(activity) {
  if (!client || !enabled) return;
  try {
    await client.user?.setActivity({ startTimestamp, ...activity });
  } catch (_err) {
    // Discord client not reachable right now — ignore, next state change will retry.
  }
}

// Discord rate-limits presence updates to roughly one every 15 seconds and
// silently drops the rest. The download loop reports progress several times a
// second, so without this gate almost every call is wasted work — an await'd
// IPC round-trip to the Discord client, thousands of times over a multi-GB
// download. The final 100% always goes through so the presence never sticks
// at a stale percentage.
const RPC_MIN_INTERVAL_MS = 15000;
let lastDownloadingAt = 0;

function setIdle() {
  lastDownloadingAt = 0;
  setActivity({
    details: 'У лаунчері',
    state: 'Обирає сервер',
    largeImageKey: 'launcher_logo',
    largeImageText: 'WINTER GTA',
  });
}

function setDownloading(fraction) {
  const now = Date.now();
  if (fraction < 1 && now - lastDownloadingAt < RPC_MIN_INTERVAL_MS) return;
  lastDownloadingAt = now;
  const pct = Math.round((fraction || 0) * 100);
  setActivity({
    details: 'Завантажує гру',
    state: `${pct}%`,
    largeImageKey: 'launcher_logo',
    largeImageText: 'WINTER GTA',
  });
}

function setPlaying(serverName) {
  lastDownloadingAt = 0;
  setActivity({
    details: 'У грі',
    state: serverName || 'На сервері',
    largeImageKey: 'launcher_logo',
    largeImageText: 'WINTER GTA',
  });
}

module.exports = { connect, disconnect, setEnabled, setIdle, setDownloading, setPlaying };
