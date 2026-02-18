// ===================== STATE =====================

// ===================== SETTINGS =====================

const defaultSettings = {
  skipCreditsSeconds: 0,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('ctoplayer_settings'));
    return { ...defaultSettings, ...saved };
  } catch { return { ...defaultSettings }; }
}

function saveSettings(settings) {
  localStorage.setItem('ctoplayer_settings', JSON.stringify(settings));
  state.settings = settings;
}

const state = {
  playlist: null,
  tab: 'live',
  category: 'all',
  search: '',
  sort: 'newest',
  hlsInstance: null,
  mpegtsInstance: null,
  plyrInstance: null,
  previousView: 'dashboard',
  playerAbort: null,
  stallTimer: null,
  recoveryAttempts: 0,
  episodeQueue: [],
  currentEpisodeIdx: -1,
  nextEpTimer: null,
  nextEpTriggered: false,
  settings: loadSettings(),
  // Infinite scroll
  allFilteredItems: [],
  itemsToShow: 200,
  isLoadingMore: false,
  isRefreshing: false,
};

// ===================== DOM REFS =====================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const views = {
  login: $('#login-view'),
  dashboard: $('#dashboard-view'),
  series: $('#series-view'),
  player: $('#player-view'),
  settings: $('#settings-view'),
};

// ===================== INIT =====================

document.addEventListener('DOMContentLoaded', () => {
  setupLogin();
  setupDashboard();
  setupPlayer();
  setupSettings();
  restoreSession();
});

async function restoreSession() {
  try {
    const res = await fetch('/api/playlist');
    if (res.ok) {
      state.playlist = await res.json();
      showDashboard();
      // Auto-refresh playlist in background
      refreshPlaylist(true);
    }
  } catch (e) {
    // No saved session, stay on login
  }
}

// ===================== VIEW MANAGEMENT =====================

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
}

// ===================== LOGIN =====================

function setupLogin() {
  // Tab switching
  $$('.login-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.login-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tab = btn.dataset.tab;
      $('#m3u-form').hidden = tab !== 'm3u';
      $('#xtream-form').hidden = tab !== 'xtream';
      $('#login-error').hidden = true;
    });
  });

  // M3U form
  $('#m3u-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#m3u-url').value.trim();
    if (!url) return;
    await loadPlaylist('/api/load-m3u', { url }, e.target);
  });

  // Xtream form
  $('#xtream-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const server = $('#xtream-server').value.trim();
    const username = $('#xtream-user').value.trim();
    const password = $('#xtream-pass').value.trim();
    if (!server || !username || !password) return;
    await loadPlaylist('/api/load-xtream', { server, username, password }, e.target);
  });

  // Back from dashboard — clear saved session
  $('#btn-back-login').addEventListener('click', logout);

  async function logout() {
    // Limpar state
    state.playlist = null;
    state.allFilteredItems = [];
    state.itemsToShow = 200;

    // Deletar sessão no servidor (remove cookie e dados)
    await fetch('/api/session', { method: 'DELETE' });

    // Voltar para tela de login
    showView('login');
  }
}

async function loadPlaylist(endpoint, body, form) {
  const btn = form.querySelector('.btn-primary');
  const btnText = form.querySelector('.btn-text');
  const btnLoading = form.querySelector('.btn-loading');
  const progressEl = form.querySelector('.progress-info');
  const progressFill = form.querySelector('.progress-fill');
  const progressText = form.querySelector('.progress-text');
  const errorEl = $('#login-error');

  btn.disabled = true;
  btnText.hidden = true;
  btnLoading.hidden = false;
  errorEl.hidden = true;
  progressEl.hidden = false;
  progressFill.style.width = '0%';
  progressText.textContent = 'Iniciando...';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Read NDJSON stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          lastData = data;

          if (data.type === 'progress') {
            progressText.textContent = data.message;
            if (data.percent != null) progressFill.style.width = data.percent + '%';
          } else if (data.type === 'error') {
            throw new Error(data.error);
          } else if (data.type === 'done') {
            // Success — load the playlist
            progressText.textContent = 'Carregando interface...';
            progressFill.style.width = '100%';
          }
        } catch (parseErr) {
          if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
        }
      }
    }

    // Check if we got an error in the last data
    if (lastData && lastData.type === 'error') {
      throw new Error(lastData.error);
    }

    // Load full playlist
    const playlistRes = await fetch('/api/playlist');
    state.playlist = await playlistRes.json();

    showDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
    btnText.hidden = false;
    btnLoading.hidden = true;
    progressEl.hidden = true;
  }
}

// ===================== DASHBOARD =====================

function setupDashboard() {
  // Tab switching
  $$('.topbar-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.topbar-tabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tab = btn.dataset.type;
      state.category = 'all';
      state.sort = 'newest';
      $('#sort-select').value = 'newest';
      renderSidebar();
      renderContent();
    });
  });

  // Search
  let searchTimeout;
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = e.target.value.trim().toLowerCase();
      renderContent();
    }, 200);
  });

  // Sort
  $('#sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderContent();
  });

  // Logout button
  $('#btn-logout').addEventListener('click', async () => {
    // Limpar state
    state.playlist = null;
    state.allFilteredItems = [];
    state.itemsToShow = 200;

    // Deletar sessão no servidor (remove cookie e dados)
    await fetch('/api/session', { method: 'DELETE' });

    // Voltar para tela de login
    showView('login');
  });

  // Infinite scroll
  const contentArea = $('#content-area');
  contentArea.addEventListener('scroll', () => {
    if (state.isLoadingMore) return;

    const { scrollTop, scrollHeight, clientHeight } = contentArea;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // Carregar mais quando estiver a 500px do fim
    if (distanceFromBottom < 500 && state.itemsToShow < state.allFilteredItems.length) {
      state.isLoadingMore = true;
      state.itemsToShow += 100; // Carregar 100 itens por vez
      setTimeout(() => renderContent(true), 100); // Pequeno delay para suavizar
    }
  });
}

function showDashboard() {
  state.tab = 'live';
  state.category = 'all';
  state.search = '';
  state.sort = 'newest';
  $('#search-input').value = '';
  $('#sort-select').value = 'newest';

  // Reset tabs
  $$('.topbar-tabs .tab').forEach(b => b.classList.remove('active'));
  $('.topbar-tabs .tab[data-type="live"]').classList.add('active');

  showView('dashboard');
  renderSidebar();
  renderContent();
}

async function refreshPlaylist(silent) {
  const btn = $('#btn-refresh');
  const btnText = $('#btn-refresh-text');
  const progressEl = $('#refresh-progress');
  const progressFill = $('#refresh-progress-fill');
  const statusEl = $('#refresh-status');

  if (state.isRefreshing) return;
  state.isRefreshing = true;
  btn.classList.add('refreshing');
  btn.disabled = true;

  if (!silent) {
    btnText.textContent = 'Atualizando...';
    progressEl.hidden = false;
    progressFill.style.width = '0%';
  }

  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let success = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.type === 'progress') {
            statusEl.textContent = data.message;
            if (data.percent != null) progressFill.style.width = data.percent + '%';
            if (!silent) progressEl.hidden = false;
          } else if (data.type === 'error') {
            console.warn('[REFRESH] Error:', data.error);
            statusEl.textContent = data.error;
          } else if (data.type === 'done') {
            success = true;
          }
        } catch { /* ignore parse errors */ }
      }
    }

    if (success) {
      const playlistRes = await fetch('/api/playlist');
      if (playlistRes.ok) {
        state.playlist = await playlistRes.json();
        renderSidebar();
        renderContent();
      }
      statusEl.textContent = 'Lista atualizada com sucesso!';
      progressFill.style.width = '100%';
    }
  } catch (err) {
    console.warn('[REFRESH] Failed:', err.message);
    statusEl.textContent = 'Falha ao atualizar';
  } finally {
    state.isRefreshing = false;
    btn.classList.remove('refreshing');
    btn.disabled = false;
    btnText.textContent = 'Atualizar';
    if (silent) progressEl.hidden = true;
  }
}

function renderSidebar() {
  const sidebar = $('#sidebar');
  const section = state.playlist[state.tab];
  if (!section) return;

  const cats = section.categories || [];
  const totalCount = section.items ? section.items.length : 0;

  let html = `<button class="cat-item ${state.category === 'all' ? 'active' : ''}" data-cat="all">
    <span>Todas</span><span class="cat-count">${totalCount}</span>
  </button>`;

  for (const cat of cats) {
    const isActive = state.category === cat.name ? 'active' : '';
    html += `<button class="cat-item ${isActive}" data-cat="${escapeAttr(cat.name)}">
      <span title="${escapeHtml(cat.name)}">${escapeHtml(truncate(cat.name, 22))}</span>
      <span class="cat-count">${cat.count}</span>
    </button>`;
  }

  sidebar.innerHTML = html;

  // Bind category clicks
  sidebar.querySelectorAll('.cat-item').forEach(btn => {
    btn.addEventListener('click', () => {
      sidebar.querySelectorAll('.cat-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.category = btn.dataset.cat;
      renderContent();
    });
  });
}

function renderContent(append = false) {
  const grid = $('#content-grid');
  const empty = $('#empty-state');
  const section = state.playlist[state.tab];
  if (!section) return;

  // Se não for append, processar filtros e ordenação
  if (!append) {
    let items = [...(section.items || [])];

    // Migrate: assign _idx if missing (old sessions before _idx existed)
    if (items.length > 0 && items[0]._idx === undefined) {
      section.items.forEach((item, i) => { item._idx = i; });
    }

    // Filter by category
    if (state.category !== 'all') {
      items = items.filter(i => i.group === state.category);
    }

    // Filter by search
    if (state.search) {
      items = items.filter(i => i.name.toLowerCase().includes(state.search));
    }

    // Sort
    switch (state.sort) {
      case 'newest':
        items.sort((a, b) => (b._idx || 0) - (a._idx || 0));
        break;
      case 'oldest':
        items.sort((a, b) => (a._idx || 0) - (b._idx || 0));
        break;
      case 'az':
        items.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'za':
        items.sort((a, b) => b.name.localeCompare(a.name));
        break;
    }

    // Guardar items filtrados e resetar contador
    state.allFilteredItems = items;
    state.itemsToShow = 200;
  }

  // Set grid class for live TV
  grid.className = state.tab === 'live' ? 'grid live-grid' : 'grid';

  if (state.allFilteredItems.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  // Calcular quantos itens renderizar
  const limit = Math.min(state.allFilteredItems.length, state.itemsToShow);
  const startIdx = append ? grid.querySelectorAll('.grid-item').length : 0;

  // Se não for append, limpar grid
  if (!append) {
    grid.innerHTML = '';
  }

  // Remover indicador "carregando" se existir
  const loadingIndicator = grid.querySelector('.loading-more');
  if (loadingIndicator) loadingIndicator.remove();

  // Renderizar novos itens
  const fragment = document.createDocumentFragment();
  for (let i = startIdx; i < limit; i++) {
    const item = state.allFilteredItems[i];
    const el = createGridItem(item);
    fragment.appendChild(el);
  }
  grid.appendChild(fragment);

  // Adicionar indicador de "mais itens" se houver mais para carregar
  if (state.allFilteredItems.length > limit) {
    const more = document.createElement('div');
    more.className = 'loading-more';
    more.style.cssText = 'grid-column: 1/-1; text-align:center; padding:20px; color:var(--text-muted); font-size:13px;';
    more.innerHTML = `
      <div class="spinner" style="width:24px; height:24px; margin:0 auto 8px;"></div>
      <div>Carregando mais itens... (${limit} de ${state.allFilteredItems.length})</div>
    `;
    grid.appendChild(more);
  }

  state.isLoadingMore = false;
}

function createGridItem(item) {
  const div = document.createElement('div');
  div.className = 'grid-item';

  const poster = item.logo
    ? `<img src="${escapeAttr(item.logo)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<svg class=placeholder-icon width=40 height=40 viewBox=&quot;0 0 24 24&quot; fill=&quot;currentColor&quot;><path d=&quot;M8 5v14l11-7z&quot;/></svg>'">`
    : `<svg class="placeholder-icon" width="40" height="40" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

  div.innerHTML = `
    <div class="grid-item-poster">${poster}</div>
    <div class="grid-item-info">
      <div class="grid-item-name" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</div>
      <div class="grid-item-group">${escapeHtml(item.group)}</div>
    </div>
  `;

  div.addEventListener('click', () => {
    if (item.isSeries) {
      openSeries(item);
    } else if (item.url) {
      playStream(item.url, item.name, 'dashboard');
    }
  });

  return div;
}

// ===================== SERIES DETAIL =====================

async function openSeries(item) {
  $('#series-title').textContent = item.name;
  $('#series-seasons').innerHTML = '<div class="loading"><div class="spinner"></div><p>Carregando temporadas...</p></div>';
  showView('series');
  $('#btn-back-dashboard').onclick = () => showView('dashboard');

  // M3U series: seasons are already embedded in the item
  if (item.seasons) {
    renderSeasons({ name: item.name, seasons: item.seasons });
    return;
  }

  // Xtream series: fetch from API
  if (item.seriesId) {
    try {
      const res = await fetch(`/api/series/${item.seriesId}`);
      if (!res.ok) throw new Error('Falha ao carregar');
      const data = await res.json();
      renderSeasons(data);
    } catch (err) {
      $('#series-seasons').innerHTML = `<div class="empty"><p>Erro: ${escapeHtml(err.message)}</p></div>`;
    }
    return;
  }

  $('#series-seasons').innerHTML = '<div class="empty"><p>Nenhum episódio encontrado</p></div>';
}

function renderSeasons(data) {
  const container = $('#series-seasons');
  const seasons = data.seasons || {};
  const keys = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));

  if (keys.length === 0) {
    container.innerHTML = '<div class="empty"><p>Nenhum episódio encontrado</p></div>';
    return;
  }

  // Build flat episode queue across all seasons (ordered)
  const queue = [];
  for (const num of keys) {
    for (const ep of seasons[num]) {
      queue.push({ url: ep.url, name: ep.name });
    }
  }

  let html = '';
  let queueIdx = 0;
  for (const num of keys) {
    const episodes = seasons[num];
    html += `<div class="season-block">
      <div class="season-title">Temporada ${num}</div>
      <div class="episode-list">`;

    for (const ep of episodes) {
      html += `<div class="episode-item" data-url="${escapeAttr(ep.url)}" data-name="${escapeAttr(ep.name)}" data-queue-idx="${queueIdx}">
        <span class="episode-num">E${String(ep.episode).padStart(2, '0')}</span>
        <span class="episode-name">${escapeHtml(ep.name)}</span>
        ${ep.duration ? `<span class="episode-duration">${escapeHtml(ep.duration)}</span>` : ''}
      </div>`;
      queueIdx++;
    }

    html += '</div></div>';
  }

  container.innerHTML = html;

  container.querySelectorAll('.episode-item').forEach(el => {
    el.addEventListener('click', () => {
      state.episodeQueue = queue;
      state.currentEpisodeIdx = parseInt(el.dataset.queueIdx, 10);
      console.log('[EPISODE-CLICK] idx:', state.currentEpisodeIdx, 'queueLen:', queue.length, 'name:', el.dataset.name, 'queue[0]:', queue[0]?.name, 'queue[1]:', queue[1]?.name);
      playStream(el.dataset.url, el.dataset.name, 'series');
    });
  });
}

// ===================== PLAYER =====================

function setupPlayer() {
  // Init Plyr (wrapped in try-catch to not block other setup)
  try {
    state.plyrInstance = new Plyr('#video-player', {
      controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'fullscreen'],
      settings: ['quality', 'speed'],
      tooltips: { controls: true, seek: true },
      keyboard: { focused: true, global: true },
      invertTime: false,
      blankVideo: '',
    });
  } catch (e) {
    console.warn('[PLAYER] Plyr init failed, using native controls:', e.message);
  }

  $('#btn-back-player').addEventListener('click', stopPlayback);
  $('#btn-retry').addEventListener('click', () => {
    const video = $('#video-player');
    const src = video.dataset.originalUrl;
    const name = $('#player-title').textContent;
    if (src) playStream(src, name, state.previousView);
  });
  $('#btn-prev-ep').addEventListener('click', playPrevEpisode);
  $('#btn-next-ep').addEventListener('click', playNextEpisode);
}

function detectStreamType(url) {
  const u = url.toLowerCase();
  if (u.includes('.m3u8') || u.includes('type=m3u8')) return 'hls';
  if (u.includes('.ts') || u.includes('/live/')) return 'ts';
  return 'direct'; // mp4, mkv, etc.
}

function playStream(url, name, fromView) {
  state.previousView = fromView || 'dashboard';
  const video = $('#video-player');
  const errorEl = $('#player-error');

  // Abort all previous event listeners
  if (state.playerAbort) state.playerAbort.abort();
  state.playerAbort = new AbortController();
  const { signal } = state.playerAbort;

  // Clear stall timer and next-ep timer
  if (state.stallTimer) { clearInterval(state.stallTimer); state.stallTimer = null; }
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }
  state.recoveryAttempts = 0;

  // Hide next-ep overlay if visible
  const nextEpOverlay = $('#next-ep-overlay');
  if (nextEpOverlay) nextEpOverlay.hidden = true;

  video.dataset.originalUrl = url;
  errorEl.hidden = true;
  $('#player-title').textContent = name;

  // Show/hide episode nav buttons
  updateEpNavButtons();

  // Cleanup previous instances
  if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
  if (state.mpegtsInstance) { state.mpegtsInstance.destroy(); state.mpegtsInstance = null; }

  // Reset video completely
  video.pause();
  video.removeAttribute('src');
  video.load();

  showView('player');

  const proxyUrl = location.origin + '/api/proxy?url=' + encodeURIComponent(url);
  const streamType = detectStreamType(url);

  console.log(`[PLAYER] Starting ${streamType} stream:`, url.substring(0, 80));

  if (streamType === 'hls' && Hls.isSupported()) {
    console.log('[PLAYER] HLS.js supported, creating instance');
    const hls = new Hls({
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      maxBufferSize: 60 * 1024 * 1024,
      maxBufferHole: 0.5,
      lowLatencyMode: false,
      fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingTimeOut: 15000,
      manifestLoadingMaxRetry: 4,
      levelLoadingTimeOut: 15000,
      levelLoadingMaxRetry: 4,
      startFragPrefetch: true,
    });
    state.hlsInstance = hls;

    console.log('[PLAYER] Loading source:', proxyUrl.substring(0, 80));
    hls.loadSource(proxyUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      console.log('[PLAYER] Manifest parsed, levels:', data.levels?.length);
      video.play().catch((e) => console.warn('[PLAYER] play() rejected:', e.message));
    });

    hls.on(Hls.Events.MANIFEST_LOADING, () => console.log('[PLAYER] Loading manifest...'));
    hls.on(Hls.Events.MANIFEST_LOADED, () => console.log('[PLAYER] Manifest loaded'));
    hls.on(Hls.Events.LEVEL_LOADED, () => console.log('[PLAYER] Level loaded'));
    hls.on(Hls.Events.FRAG_LOADING, () => console.log('[PLAYER] Loading fragment...'));
    hls.on(Hls.Events.FRAG_LOADED, () => {
      console.log('[PLAYER] Fragment loaded');
      state.recoveryAttempts = 0; // reset on successful fragment
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      console.warn(`[PLAYER] HLS error: type=${data.type} details=${data.details} fatal=${data.fatal}`, data.response ? `status=${data.response.code}` : '', data.reason || '');
      if (!data.fatal) return;

      if (state.recoveryAttempts >= 10) { errorEl.hidden = false; return; }
      state.recoveryAttempts++;
      console.log(`[PLAYER] Recovery attempt ${state.recoveryAttempts}/10`);

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        const delay = Math.min(2000 * state.recoveryAttempts, 10000);
        setTimeout(() => {
          if (state.hlsInstance) hls.startLoad();
        }, delay);
      } else {
        // Try full reload for other errors
        hls.destroy();
        const newHls = new Hls(hls.config);
        state.hlsInstance = newHls;
        newHls.loadSource(proxyUrl);
        newHls.attachMedia(video);
        newHls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
        });
      }
    });

    // Stall recovery for HLS
    setupStallDetection(video, signal, () => {
      if (state.hlsInstance) state.hlsInstance.recoverMediaError();
    });

  } else if (streamType === 'ts' && typeof mpegts !== 'undefined' && mpegts.isSupported()) {
    // Use mpegts.js for live TS streams
    const player = mpegts.createPlayer({
      type: 'mpegts',
      isLive: true,
      url: proxyUrl,
    }, {
      enableWorker: true,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 30,
      liveBufferLatencyMinRemain: 3,
      lazyLoadMaxDuration: 120,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 15,
    });
    state.mpegtsInstance = player;

    player.attachMediaElement(video);
    player.load();
    player.play().catch(() => {});

    player.on(mpegts.Events.ERROR, (type, detail) => {
      console.warn(`[PLAYER] mpegts error: ${type}/${detail}`);
      if (state.recoveryAttempts >= 5) { errorEl.hidden = false; return; }
      state.recoveryAttempts++;
      // Auto-reconnect for live streams
      setTimeout(() => {
        try {
          player.unload();
          player.load();
          player.play().catch(() => {});
        } catch (e) { errorEl.hidden = false; }
      }, 2000);
    });

    // Stall recovery for TS
    setupStallDetection(video, signal, () => {
      if (state.mpegtsInstance) {
        try {
          state.mpegtsInstance.unload();
          state.mpegtsInstance.load();
          state.mpegtsInstance.play().catch(() => {});
        } catch (e) { /* ignore */ }
      }
    });

  } else if (streamType === 'hls' && video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    video.src = proxyUrl;
    video.addEventListener('error', () => { errorEl.hidden = false; }, { signal });
    video.play().catch(() => {});

  } else {
    // Direct MP4/MKV playback with stall recovery
    video.src = proxyUrl;
    video.addEventListener('error', () => {
      console.error('[PLAYER] Video error:', video.error?.code, video.error?.message);
      errorEl.hidden = false;
    }, { signal });
    video.play().catch(() => {});

    // Auto-reconnect on stall for direct streams
    setupStallDetection(video, signal, () => {
      const currentTime = video.currentTime;
      console.log('[PLAYER] Reconnecting direct stream at', currentTime.toFixed(1));
      video.src = proxyUrl;
      video.currentTime = currentTime;
      video.play().catch(() => {});
    });
  }

  state.nextEpTriggered = false;

  let overlayShown = false;

  if (state.settings.skipCreditsSeconds > 0 && state.episodeQueue.length > 0) {
    const skipAt = state.settings.skipCreditsSeconds;
    const warnAt = skipAt + 10; // show overlay 10s before skip

    let skipArmed = false;
    video.addEventListener('loadedmetadata', () => { skipArmed = true; }, { signal, once: true });

    video.addEventListener('timeupdate', () => {
      if (state.nextEpTriggered || !skipArmed) return;
      if (!video.duration || !isFinite(video.duration)) return;
      if (video.currentTime < 30) return;
      const remaining = video.duration - video.currentTime;

      // Show overlay 10s before skip
      if (!overlayShown && remaining <= warnAt && remaining > skipAt) {
        overlayShown = true;
        console.log('[SKIP] Showing warning. currentEpisodeIdx:', state.currentEpisodeIdx, 'queueLen:', state.episodeQueue.length, 'next:', state.episodeQueue[state.currentEpisodeIdx + 1]?.name);
        showSkipWarning(remaining - skipAt);
      }

      // Skip now
      if (remaining <= skipAt && remaining > 0) {
        console.log('[SKIP] Triggering skip. currentEpisodeIdx:', state.currentEpisodeIdx, 'queueLen:', state.episodeQueue.length, 'next:', state.episodeQueue[state.currentEpisodeIdx + 1]?.name, 'nextUrl:', state.episodeQueue[state.currentEpisodeIdx + 1]?.url?.substring(0, 60));
        state.nextEpTriggered = true;
        hideSkipWarning();
        video.pause();
        playNextEpisode();
      }
    }, { signal });
  }

  video.addEventListener('ended', () => {
    if (!state.nextEpTriggered) showNextEpisodeOverlay();
  }, { signal });
}

function setupStallDetection(video, signal, recoveryFn) {
  let lastTime = 0;
  let stallCount = 0;

  const timer = setInterval(() => {
    if (signal.aborted) { clearInterval(timer); return; }
    if (!video.paused && !video.ended && video.readyState > 0) {
      if (Math.abs(video.currentTime - lastTime) < 0.1) {
        stallCount++;
        console.warn(`[PLAYER] Stall (${stallCount}/3): time=${video.currentTime.toFixed(1)}`);
        if (stallCount >= 3) {
          stallCount = 0;
          console.log('[PLAYER] Auto-recovering from stall');
          recoveryFn();
        }
      } else {
        stallCount = 0;
      }
      lastTime = video.currentTime;
    }
  }, 4000);

  state.stallTimer = timer;
}

function showNextEpisodeOverlay() {
  const nextIdx = state.currentEpisodeIdx + 1;
  if (state.episodeQueue.length === 0 || nextIdx >= state.episodeQueue.length) return;

  const nextEp = state.episodeQueue[nextIdx];
  const overlay = $('#next-ep-overlay');
  if (!overlay) return;

  $('#next-ep-name').textContent = nextEp.name;
  overlay.hidden = false;

  let countdown = 10;
  $('#next-ep-countdown').textContent = countdown;

  // Clear any previous timer
  if (state.nextEpTimer) clearInterval(state.nextEpTimer);

  state.nextEpTimer = setInterval(() => {
    countdown--;
    $('#next-ep-countdown').textContent = countdown;
    if (countdown <= 0) {
      clearInterval(state.nextEpTimer);
      state.nextEpTimer = null;
      playNextEpisode();
    }
  }, 1000);
}

function showSkipWarning(seconds) {
  const nextIdx = state.currentEpisodeIdx + 1;
  if (state.episodeQueue.length === 0 || nextIdx >= state.episodeQueue.length) return;

  const nextEp = state.episodeQueue[nextIdx];
  const overlay = $('#next-ep-overlay');
  if (!overlay) return;

  $('#next-ep-name').textContent = nextEp.name;
  overlay.hidden = false;

  let countdown = Math.round(seconds);
  $('#next-ep-countdown').textContent = countdown;

  if (state.nextEpTimer) clearInterval(state.nextEpTimer);
  state.nextEpTimer = setInterval(() => {
    countdown--;
    if (countdown >= 0) $('#next-ep-countdown').textContent = countdown;
    if (countdown <= 0) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }
  }, 1000);
}

function hideSkipWarning() {
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }
  const overlay = $('#next-ep-overlay');
  if (overlay) overlay.hidden = true;
}

function updateEpNavButtons() {
  const nav = $('#ep-nav-buttons');
  if (!nav) return;

  const hasQueue = state.episodeQueue.length > 0;
  nav.hidden = !hasQueue;
  if (!hasQueue) return;

  $('#btn-prev-ep').disabled = state.currentEpisodeIdx <= 0;
  $('#btn-next-ep').disabled = state.currentEpisodeIdx >= state.episodeQueue.length - 1;
}

function playPrevEpisode() {
  if (state.episodeQueue.length === 0 || state.currentEpisodeIdx <= 0) return;

  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }

  const prevIdx = state.currentEpisodeIdx - 1;
  const prevEp = state.episodeQueue[prevIdx];
  state.currentEpisodeIdx = prevIdx;
  playStream(prevEp.url, prevEp.name, 'series');
}

function playNextEpisode() {
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }

  const nextIdx = state.currentEpisodeIdx + 1;
  console.log('[NEXT-EP] currentEpisodeIdx:', state.currentEpisodeIdx, 'nextIdx:', nextIdx, 'queueLen:', state.episodeQueue.length);
  if (state.episodeQueue.length === 0 || nextIdx >= state.episodeQueue.length) return;

  const nextEp = state.episodeQueue[nextIdx];
  console.log('[NEXT-EP] Playing:', nextEp.name, 'url:', nextEp.url?.substring(0, 60));
  state.currentEpisodeIdx = nextIdx;
  playStream(nextEp.url, nextEp.name, 'series');
}

function cancelNextEpisode() {
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }
  const overlay = $('#next-ep-overlay');
  if (overlay) overlay.hidden = true;
}

function stopPlayback() {
  // Kill timers
  if (state.stallTimer) { clearInterval(state.stallTimer); state.stallTimer = null; }
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }

  // Kill all player event listeners
  if (state.playerAbort) {
    state.playerAbort.abort();
    state.playerAbort = null;
  }

  if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
  if (state.mpegtsInstance) { state.mpegtsInstance.destroy(); state.mpegtsInstance = null; }

  // Clear episode queue
  state.episodeQueue = [];
  state.currentEpisodeIdx = -1;

  // Hide next-ep overlay
  const nextEpOverlay = $('#next-ep-overlay');
  if (nextEpOverlay) nextEpOverlay.hidden = true;

  const video = $('#video-player');
  video.pause();
  video.removeAttribute('src');

  showView(state.previousView);
}

// ===================== SETTINGS VIEW =====================

function setupSettings() {
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-back-settings').addEventListener('click', () => showView('dashboard'));
  $('#btn-refresh').addEventListener('click', () => refreshPlaylist(false));

  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const skipCredits = parseInt($('#setting-skip-credits').value, 10) || 0;

    saveSettings({
      skipCreditsSeconds: Math.max(0, Math.min(300, skipCredits)),
    });

    // Show saved feedback
    const btn = $('#settings-form .btn-primary');
    const orig = btn.textContent;
    btn.textContent = 'Salvo!';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
  });
}

function openSettings() {
  $('#setting-skip-credits').value = state.settings.skipCreditsSeconds;
  showView('settings');
}

// ===================== UTILS =====================

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

// Keyboard shortcut: Escape to go back
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (views.player.classList.contains('active')) {
      stopPlayback();
    } else if (views.series.classList.contains('active')) {
      showView('dashboard');
    } else if (views.settings.classList.contains('active')) {
      showView('dashboard');
    }
  }
});
