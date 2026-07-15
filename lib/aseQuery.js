const dgram = require('dgram');

// Multi Theft Auto ASE (Auto Server Enumeration) query.
// Query port = game port + 123. Request is a single 's' byte,
// response is a 4-byte header ("EYE1") followed by length-prefixed fields.
function queryServer(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const sentAt = Date.now();

    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.close(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.once('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    socket.once('message', (msg) => {
      clearTimeout(timer);
      try {
        const parsed = parseAseResponse(msg);
        finish({ ...parsed, ping: Date.now() - sentAt });
      } catch (_) {
        finish(null);
      }
    });

    try {
      const req = Buffer.from('s');
      socket.send(req, 0, req.length, port, host, (err) => {
        if (err) {
          clearTimeout(timer);
          finish(null);
        }
      });
    } catch (_) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

// Each field is a 1-byte length prefix followed by that many bytes of
// content, except the length byte counts one extra byte beyond the
// content itself (verified against live server responses).
function readField(buf, offset) {
  const rawLen = buf[offset];
  const len = Math.max(0, rawLen - 1);
  const value = buf.toString('utf8', offset + 1, offset + 1 + len);
  return { value, next: offset + rawLen };
}

function parseAseResponse(buf) {
  // Skip the 4-byte header ("EYE1").
  let offset = 4;
  const fields = ['game', 'port', 'serverName', 'gameMode', 'mapName', 'version', 'passworded', 'players', 'maxPlayers'];
  const data = {};
  for (const field of fields) {
    const { value, next } = readField(buf, offset);
    data[field] = value;
    offset = next;
  }
  const players = parseInt(data.players, 10);
  const maxPlayers = parseInt(data.maxPlayers, 10);
  return {
    serverName: data.serverName || null,
    players: Number.isFinite(players) ? players : null,
    maxPlayers: Number.isFinite(maxPlayers) ? maxPlayers : null,
  };
}

module.exports = { queryServer };
