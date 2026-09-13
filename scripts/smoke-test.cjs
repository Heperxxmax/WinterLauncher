// Launch the packaged Windows app and verify its renderer and preload bridge.
// Node.js 22+ provides fetch and WebSocket; no test dependencies are required.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const executable = path.resolve(process.argv[2] || 'dist/win-unpacked/UKRAINE ONLINE.exe');
  assert.ok(fs.existsSync(executable), `Missing executable: ${executable}`);
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'winter-launcher-smoke-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    toggles: { autoUpdate: false, discord: false, sound: false },
  }));
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let launchError;
  child.on('error', error => { launchError = error; });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  let socket;
  try {
    const deadline = Date.now() + 45000;
    let page;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, `App exited early: ${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        page = (await response.json()).find(target => target.url.endsWith('/src/index.html'));
        if (page) break;
      } catch (_) {}
      await delay(250);
    }
    assert.ok(page, `Main window did not open: ${logs}`);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, 'open');
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    });
    const id = ++nextId;
    const resultPromise = new Promise(resolve => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
        const data = await window.api.getConfig();
        const state = await window.api.getInstallState();
        await document.fonts.ready;
        return { version: data.version, title: data.config.launcherTitle,
          bodyLength: document.body.innerText.trim().length,
          installedType: typeof state.installed,
          brokenImages: [...document.images].filter(img => img.getAttribute('src') && (!img.complete || img.naturalWidth === 0)).map(img => img.src),
          buttons: document.querySelectorAll('button').length };
      })()`
    }}));
    const result = await Promise.race([
      resultPromise,
      delay(15000).then(() => { throw new Error('Renderer check timed out'); }),
    ]);
    assert.ok(!result.error, JSON.stringify(result.error));
    assert.ok(!result.result.exceptionDetails, JSON.stringify(result.result.exceptionDetails));
    const actual = result.result.result.value;
    assert.equal(actual.version, require('../package.json').version);
    assert.equal(actual.title, require('../config.json').launcherTitle);
    assert.equal(actual.installedType, 'boolean');
    assert.ok(actual.bodyLength > 50, 'Main window is empty');
    assert.ok(actual.buttons > 0, 'Controls did not render');
    assert.deepEqual(actual.brokenImages, [], 'Packaged images failed to load');
    console.log('Packaged Windows startup passed:', JSON.stringify(actual));
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    if (socket) socket.close();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(5000)]);
    }
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
