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

function setIdle() {
  setActivity({
    details: 'У лаунчері',
    state: 'Обирає сервер',
    largeImageKey: 'launcher_logo',
    largeImageText: 'WINTER GTA',
  });
}

function setDownloading(fraction) {
  const pct = Math.round((fraction || 0) * 100);
  setActivity({
    details: 'Завантажує гру',
    state: `${pct}%`,
    largeImageKey: 'launcher_logo',
    largeImageText: 'WINTER GTA',
  });
}

function setPlaying(serverName) {
  setActivity({
    details: 'У грі',
    state: serverName || 'На сервері',
    largeImageKey: 'launcher_logo',
    largeImageText: 'WINTER GTA',
  });
}

module.exports = { connect, disconnect, setEnabled, setIdle, setDownloading, setPlaying };
