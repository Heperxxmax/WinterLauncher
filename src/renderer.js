(function () {
  const el = (id) => document.getElementById(id);

  const TOGGLE_DEFS = [
    { key: 'fullscreen', label: 'Повноекранний режим' },
    { key: 'autoUpdate', label: 'Автоматичні оновлення' },
    { key: 'sound', label: 'Звуки в лаунчері' },
    { key: 'discord', label: 'Discord Rich Presence' },
  ];

  let state = {
    config: null,
    settings: null,
    servers: [],
    selectedServerId: null,
    install: 'notInstalled', // notInstalled | downloading | installed | updateAvailable | running
    progress: 0,
    activePanel: null, // null | 'settings' | 'servers' | 'news'
    toggles: {},
    volume: 70,
  };

  function friendlyDownloadError(err) {
    const message = (err && err.message) || '';
    if (/ENOSPC/.test(message)) return 'Недостатньо вільного місця на диску для встановлення гри. Звільніть місце або оберіть іншу теку в налаштуваннях.';
    if (/EPERM|EACCES/.test(message)) return 'Немає прав для запису у вибрану теку. Оберіть іншу теку в налаштуваннях або запустіть лаунчер від імені адміністратора.';
    return message || 'Помилка встановлення';
  }

  function pingColor(ping) {
    if (ping === null || ping === undefined) return '#7c8798';
    if (ping < 60) return '#3fd07a';
    if (ping < 150) return '#f2b84b';
    return '#ff6a6a';
  }

  function fmtPlayers(server) {
    if (!server || !server.online || server.players === null) return '— гравців';
    const max = server.maxPlayers !== null ? `/${server.maxPlayers}` : '';
    return `${server.players}${max} гравців`;
  }

  function selectedServer() {
    return state.servers.find((s) => s.id === state.selectedServerId) || state.servers[0] || null;
  }

  // ---------- Snowfall ----------
  function spawnSnow() {
    const layer = el('snowfall');
    const count = 14;
    for (let i = 0; i < count; i++) {
      const flake = document.createElement('span');
      const size = 2.5 + Math.random() * 2.5;
      const left = Math.random() * 100;
      const duration = 8 + Math.random() * 6;
      const delay = -Math.random() * duration;
      const opacity = 0.4 + Math.random() * 0.4;
      flake.style.left = `${left}%`;
      flake.style.width = `${size}px`;
      flake.style.height = `${size}px`;
      flake.style.opacity = opacity;
      flake.style.animationDuration = `${duration}s`;
      flake.style.animationDelay = `${delay}s`;
      layer.appendChild(flake);
    }
  }

  // ---------- Dock ----------
  function renderDock() {
    const dock = el('dock-servers');
    const indicator = el('dock-indicator');
    dock.querySelectorAll('.server-pill').forEach((n) => n.remove());

    state.servers.forEach((server) => {
      const closed = !!server.status;
      const pill = document.createElement('button');
      pill.className = 'server-pill' + (closed ? ' disabled' : '');
      pill.innerHTML = `
        <div class="pill-badge">${server.label ?? ''}</div>
        <div class="pill-info">
          <div class="pill-name">${server.name}</div>
          <div class="pill-meta">
            <span class="pill-meta-dot" style="background:${pingColor(server.ping)}"></span>
            <span class="pill-meta-text">${fmtPlayers(server)}${server.online && server.ping !== null ? ' · ' + server.ping + ' ms' : ''}</span>
          </div>
        </div>
      `;
      if (!closed) {
        pill.addEventListener('click', () => {
          WGSound.click();
          selectServer(server.id);
        });
      }
      dock.appendChild(pill);
    });

    requestAnimationFrame(positionIndicator);
  }

  function positionIndicator() {
    const dock = el('dock-servers');
    const indicator = el('dock-indicator');
    const idx = state.servers.findIndex((s) => s.id === state.selectedServerId);
    const pill = dock.querySelectorAll('.server-pill')[idx];
    if (!pill) {
      indicator.style.width = '0';
      return;
    }
    indicator.style.width = `${pill.offsetWidth}px`;
    indicator.style.transform = `translateX(${pill.offsetLeft}px)`;
  }

  function selectServer(id) {
    state.selectedServerId = id;
    window.api.saveSelectedServer(id);
    renderDock();
    renderNowPlaying();
    if (state.activePanel === 'servers') renderServersPanel();
  }

  function renderNowPlaying() {
    const cur = selectedServer();
    if (state.install === 'running' && cur) {
      el('now-playing').textContent = `Зараз грає: ${cur.name}`;
    } else {
      el('now-playing').textContent = 'Зараз грає: —';
    }
  }

  // ---------- Hero / news ----------
  function renderHero() {
    const news = (state.config.news || [])[0];
    if (!news) return;
    el('hero-date').textContent = `${news.date || ''} · НОВИНИ ПРОЄКТУ`;
    el('hero-title').textContent = (news.title || '').toUpperCase();
    el('hero-subtitle').textContent = news.subtitle || '';
    const hero = document.querySelector('.hero');
    if (news.image) {
      hero.style.backgroundImage = `url("${news.image}")`;
      hero.style.backgroundSize = 'cover';
      hero.style.backgroundPosition = 'center';
    }
  }

  // ---------- Action / dock status ----------
  function renderAction() {
    const dot = el('status-dot');
    const statusText = el('status-text');
    const area = el('dock-action');

    const defs = {
      notInstalled: { sub: 'Гру ще не встановлено', dot: '' },
      downloading: { sub: 'Завантаження та встановлення', dot: 'state-busy' },
      installed: { sub: 'Готово до запуску', dot: 'state-ready' },
      updateAvailable: { sub: 'Доступне оновлення гри', dot: 'state-update' },
      running: { sub: 'Гра запущена — триває сесія', dot: 'state-running' },
    };
    const d = defs[state.install];
    dot.className = 'status-dot' + (d.dot ? ' ' + d.dot : '');
    statusText.textContent = d.sub;

    const reinstallRow = el('reinstall-row');
    reinstallRow.style.display = (state.install === 'installed' || state.install === 'updateAvailable') ? '' : 'none';

    if (state.install === 'downloading') {
      const pct = Math.round(state.progress * 100);
      area.innerHTML = `
        <div class="progress-wrap">
          <div class="progress-info">
            <div class="progress-head"><span>Завантаження та встановлення…</span><span class="pct">${pct}%</span></div>
            <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:${pct}%"></div></div>
          </div>
          <button class="cancel-btn" id="btn-cancel" title="Скасувати">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      `;
      el('btn-cancel').addEventListener('click', () => {
        WGSound.click();
        cancelDownload();
      });
      return;
    }

    if (state.install === 'running') {
      area.innerHTML = `
        <button class="action-btn state-running" id="btn-action" disabled>
          <span class="spinner"></span>
          <span class="label">У ГРІ</span>
        </button>
      `;
      return;
    }

    const labels = { notInstalled: 'СКАЧАТИ', installed: 'ГРАТИ', updateAvailable: 'ОНОВИТИ' };
    const classes = { notInstalled: '', installed: 'state-installed', updateAvailable: 'state-update' };
    area.innerHTML = `
      <button class="action-btn ${classes[state.install] || ''}" id="btn-action">
        <span class="label">${labels[state.install] || 'СКАЧАТИ'}</span>
      </button>
    `;
    el('btn-action').addEventListener('click', () => {
      WGSound.click();
      handlePrimary();
    });
  }

  async function refreshInstallState() {
    const st = await window.api.getInstallState();
    if (st.updateAvailable) state.install = 'updateAvailable';
    else if (st.installed) state.install = 'installed';
    else state.install = 'notInstalled';
    state.progress = 0;
    renderAction();
    renderNowPlaying();
  }

  async function handlePrimary() {
    if (state.install === 'notInstalled' || state.install === 'updateAvailable') {
      startDownload();
    } else if (state.install === 'installed') {
      try {
        await window.api.launchGame(state.selectedServerId);
        state.install = 'running';
        renderAction();
        renderNowPlaying();
      } catch (err) {
        WGSound.error();
        el('status-text').textContent = err.message || 'Помилка запуску';
      }
    }
  }

  async function startDownload() {
    state.install = 'downloading';
    state.progress = 0;
    renderAction();
    try {
      const ok = await window.api.downloadGame();
      if (ok) {
        WGSound.success();
        await refreshInstallState();
      } else {
        state.install = 'notInstalled';
        renderAction();
      }
    } catch (err) {
      WGSound.error();
      state.install = 'notInstalled';
      renderAction();
      el('status-text').textContent = friendlyDownloadError(err);
    }
  }

  function cancelDownload() {
    window.api.cancelDownload();
  }

  async function reinstallGame() {
    const ok = window.confirm('Гру буде повністю видалено та завантажено заново. Продовжити?');
    if (!ok) return;
    WGSound.click();
    try {
      await window.api.reinstallGame();
    } catch (err) {
      WGSound.error();
      el('status-text').textContent = friendlyDownloadError(err);
      return;
    }
    await startDownload();
  }

  // ---------- Settings panel ----------
  function renderTogglesList() {
    const list = el('toggles-list');
    list.innerHTML = '';
    TOGGLE_DEFS.forEach((def) => {
      const on = !!state.toggles[def.key];
      const row = document.createElement('div');
      row.className = 'toggle-row';
      row.innerHTML = `
        <div class="toggle-label">${def.label}</div>
        <button class="toggle-switch${on ? ' on' : ''}" data-key="${def.key}">
          <span class="toggle-knob"></span>
        </button>
      `;
      row.querySelector('.toggle-switch').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const newVal = !state.toggles[def.key];
        state.toggles[def.key] = newVal;
        btn.classList.toggle('on', newVal);
        if (def.key === 'sound') WGSound.setEnabled(newVal);
        newVal ? WGSound.toggleOn() : WGSound.toggleOff();
        await window.api.saveToggle(def.key, newVal);
      });
      list.appendChild(row);
    });
  }

  function openPanel(name) {
    WGSound.open();
    state.activePanel = name;
    if (name === 'servers') {
      renderServersPanel();
      refreshServers().catch(() => {});
    }
    if (name === 'news') renderNewsPanel();
    el(`${name}-panel`).classList.remove('hidden');
    requestAnimationFrame(() => el(`${name}-panel`).classList.add('visible'));
  }

  function closePanel() {
    if (!state.activePanel) return;
    WGSound.close();
    const panelEl = el(`${state.activePanel}-panel`);
    panelEl.classList.remove('visible');
    setTimeout(() => panelEl.classList.add('hidden'), 240);
    state.activePanel = null;
  }

  // ---------- Servers panel ----------
  function renderServersPanel() {
    const list = el('servers-list');
    list.innerHTML = '';
    state.servers.forEach((server) => {
      const closed = !!server.status;
      const active = server.id === state.selectedServerId;
      const card = document.createElement('div');
      card.className = 'server-card' + (active ? ' active' : '') + (closed ? ' disabled' : '');
      const loadPct = server.online && server.maxPlayers ? Math.round((server.players / server.maxPlayers) * 100) : 0;
      card.innerHTML = `
        <div class="card-badge">${server.label ?? ''}</div>
        <div class="card-info">
          <div class="card-name">${server.name}</div>
          <div class="card-mode">${server.mode || ''}</div>
          <div class="card-load-row">
            <div class="card-load-track"><div class="card-load-fill" style="width:${loadPct}%"></div></div>
            <span class="card-load-text">${server.online ? `${server.players} / ${server.maxPlayers}` : '— / —'}</span>
          </div>
        </div>
        <div class="card-right">
          <div class="card-ping-row">
            <span class="card-ping-dot" style="background:${pingColor(server.ping)}"></span>
            <span class="card-ping-value" style="color:${pingColor(server.ping)}">${server.ping !== null ? server.ping + ' ms' : '—'}</span>
          </div>
          ${closed
            ? `<span class="card-status-pill">${server.statusLabel || 'Тимчасово закрито'}</span>`
            : `<div class="card-pick-label">${active ? 'ОБРАНО' : 'обрати'}</div>`}
        </div>
      `;
      if (!closed) {
        card.addEventListener('click', () => {
          WGSound.click();
          selectServer(server.id);
        });
      }
      list.appendChild(card);
    });
  }

  // ---------- News panel ----------
  function renderNewsPanel() {
    const list = el('news-list');
    list.innerHTML = '';
    const newsItems = state.config.news || [];

    if (!newsItems.length) {
      const empty = document.createElement('div');
      empty.className = 'news-empty';
      empty.textContent = 'Новин поки немає.';
      list.appendChild(empty);
      return;
    }

    newsItems.forEach((news) => {
      const card = document.createElement('article');
      card.className = 'news-card';
      if (news.image) card.style.backgroundImage = `linear-gradient(90deg, rgba(8, 15, 28, 0.94), rgba(8, 15, 28, 0.72)), url("${news.image}")`;

      const date = document.createElement('div');
      date.className = 'news-card-date';
      date.textContent = news.date || 'НОВИНИ ПРОЄКТУ';
      const title = document.createElement('h2');
      title.className = 'news-card-title';
      title.textContent = news.title || 'Новина';
      const subtitle = document.createElement('p');
      subtitle.className = 'news-card-subtitle';
      subtitle.textContent = news.subtitle || '';

      card.append(date, title, subtitle);
      list.appendChild(card);
    });
  }

  // ---------- Install path (first run + settings) ----------
  async function refreshInstallPathDisplay() {
    el('install-path-value').textContent = await window.api.getInstallPath();
  }

  async function showInstallPathModal() {
    const modal = el('install-path-modal');
    el('modal-path-value').textContent = await window.api.getSuggestedInstallPath();
    modal.classList.remove('hidden');
  }

  function hideInstallPathModal() {
    el('install-path-modal').classList.add('hidden');
  }

  async function changeInstallPath() {
    WGSound.click();
    const chosen = await window.api.chooseInstallPath();
    if (chosen) await refreshInstallPathDisplay();
  }

  // ---------- Launcher self-update ----------
  function setUpdateStatus(text, cls) {
    const el2 = el('launcher-update-status');
    el2.textContent = text;
    el2.className = 'update-status' + (cls ? ` ${cls}` : '');
  }

  async function checkLauncherUpdate() {
    WGSound.click();
    setUpdateStatus('Перевірка оновлень...');
    await window.api.checkLauncherUpdate();
  }

  function wireLauncherUpdate() {
    window.api.onLauncherUpdateStatus(({ phase, version, fraction, message }) => {
      if (phase === 'available') {
        setUpdateStatus(`Доступна версія ${version}. Завантаження...`);
        window.api.downloadLauncherUpdate();
      } else if (phase === 'not-available') {
        setUpdateStatus('У вас остання версія лаунчера.', 'is-ready');
      } else if (phase === 'downloading') {
        setUpdateStatus(`Завантаження оновлення лаунчера... ${Math.round((fraction || 0) * 100)}%`);
      } else if (phase === 'downloaded') {
        setUpdateStatus('Оновлення завантажено. Натисніть, щоб перезапустити та встановити.', 'is-ready');
        const btn = el('btn-check-update');
        btn.textContent = 'Встановити та перезапустити';
        btn.onclick = () => {
          WGSound.click();
          window.api.installLauncherUpdate();
        };
      } else if (phase === 'error') {
        setUpdateStatus(message || 'Помилка перевірки оновлень', 'is-error');
      }
    });
  }

  // ---------- Live server status polling ----------
  const SERVER_REFRESH_MS = 15000;

  async function refreshServers() {
    const servers = await window.api.queryServers();
    state.servers = servers;
    renderDock();
    renderNowPlaying();
    if (state.activePanel === 'servers') renderServersPanel();
  }

  function startServerPolling() {
    setInterval(() => {
      refreshServers().catch(() => {});
    }, SERVER_REFRESH_MS);
  }

  // ---------- Nav ----------
  function setActiveNav(id) {
    ['nav-home', 'nav-news', 'nav-servers'].forEach((n) => el(n).classList.toggle('active', n === id));
  }

  function wireStaticUi() {
    el('btn-minimize').addEventListener('click', () => {
      WGSound.click();
      window.api.minimize();
    });
    el('btn-close').addEventListener('click', () => {
      WGSound.click();
      window.api.close();
    });
    el('btn-settings').addEventListener('click', () => openPanel('settings'));
    el('btn-close-settings').addEventListener('click', closePanel);
    el('btn-close-servers').addEventListener('click', closePanel);
    el('btn-close-news').addEventListener('click', closePanel);
    el('btn-reinstall').addEventListener('click', reinstallGame);
    el('btn-change-path').addEventListener('click', changeInstallPath);
    el('btn-check-update').addEventListener('click', checkLauncherUpdate);
    el('btn-modal-browse').addEventListener('click', async () => {
      WGSound.click();
      const chosen = await window.api.chooseInstallPath();
      if (chosen) el('modal-path-value').textContent = chosen;
    });
    el('btn-modal-confirm').addEventListener('click', async () => {
      WGSound.click();
      const hasPath = await window.api.hasInstallPath();
      if (!hasPath) await window.api.useDefaultInstallPath();
      hideInstallPathModal();
      await refreshInstallPathDisplay();
    });

    el('nav-home').addEventListener('click', () => {
      WGSound.click();
      closePanel();
      setActiveNav('nav-home');
    });
    el('nav-news').addEventListener('click', () => {
      closePanel();
      openPanel('news');
      setActiveNav('nav-news');
    });
    el('nav-site').addEventListener('click', () => {
      WGSound.click();
      window.api.openExternal(state.config.siteUrl);
    });
    el('nav-servers').addEventListener('click', () => {
      openPanel('servers');
      setActiveNav('nav-servers');
    });

    let volumeSaveTimer = null;
    el('volume-slider').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      el('volume-value').textContent = `${v}%`;
      WGSound.setVolume(v);
      // Dragging fires 'input' dozens of times a second; each save is a
      // synchronous disk write in the main process. Debounce so a drag ends
      // in a single write instead of a burst.
      clearTimeout(volumeSaveTimer);
      volumeSaveTimer = setTimeout(() => window.api.saveVolume(v), 200);
    });
    el('volume-slider').addEventListener('change', () => WGSound.click());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel();
    });

    window.addEventListener('resize', () => positionIndicator());

    window.api.onDownloadProgress(({ phase, fraction }) => {
      if (phase === 'downloading') {
        state.progress = fraction;
        const fill = el('progress-fill');
        const pctEl = document.querySelector('.progress-head .pct');
        if (fill) fill.style.width = `${Math.round(fraction * 100)}%`;
        if (pctEl) pctEl.textContent = `${Math.round(fraction * 100)}%`;
      } else if (phase === 'installing') {
        el('status-text').textContent = 'Встановлення...';
      } else if (phase === 'cancelled') {
        state.install = 'notInstalled';
        renderAction();
      }
    });

    window.api.onGameExited(() => {
      state.install = 'installed';
      renderAction();
      renderNowPlaying();
    });

    window.api.onGameLaunchError((message) => {
      WGSound.error();
      el('status-text').textContent = message || 'Помилка запуску';
    });

    window.api.onBeforeMinimize(() => document.body.classList.add('win-minimizing'));
    window.api.onBeforeClose(() => document.body.classList.add('win-closing'));
    window.api.onAfterRestore(() => {
      document.body.classList.remove('win-minimizing');
      document.body.classList.add('win-restoring');
      setTimeout(() => document.body.classList.remove('win-restoring'), 300);
    });
  }

  async function init() {
    spawnSnow();

    const { config, settings, version } = await window.api.getConfig();
    state.config = config;
    state.settings = settings;
    state.toggles = { ...settings.toggles };
    state.volume = settings.volume;
    state.selectedServerId = settings.selectedServerId || (config.servers[0] && config.servers[0].id);

    WGSound.setEnabled(!!state.toggles.sound);
    WGSound.setVolume(state.volume);

    el('volume-slider').value = state.volume;
    el('volume-value').textContent = `${state.volume}%`;
    await refreshInstallPathDisplay();
    el('launcher-version-value').textContent = `версія ${await window.api.getLauncherVersion()}`;
    renderTogglesList();
    renderHero();
    wireStaticUi();
    wireLauncherUpdate();

    if (!(await window.api.hasInstallPath())) {
      await showInstallPathModal();
    }

    state.servers = await window.api.queryServers();
    renderDock();
    await refreshInstallState();
    startServerPolling();
  }

  init();
})();
