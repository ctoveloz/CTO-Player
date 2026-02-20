// ===================== SETTINGS =====================

const defaultSettings = {
  skipCreditsSeconds: 0,
  skipIntroSeconds: 0,
  autoPlayNext: true,
  defaultVolume: 100,
  gridSize: 'medium',
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

// ===================== FAVORITES =====================

function getFavorites() {
  try { return JSON.parse(localStorage.getItem('ctoplayer_favorites')) || {}; }
  catch { return {}; }
}

function saveFavorites(favs) {
  localStorage.setItem('ctoplayer_favorites', JSON.stringify(favs));
}

function getFavKey(item) {
  if (item.isSeries) return `series:${item.seriesId || item.name}`;
  return item.url || item.name;
}

function isFavorite(item) {
  return !!getFavorites()[getFavKey(item)];
}

function toggleFavorite(item) {
  const favs = getFavorites();
  const key = getFavKey(item);
  if (favs[key]) delete favs[key];
  else favs[key] = true;
  saveFavorites(favs);
  return !!favs[key];
}

// ===================== WATCH PROGRESS =====================

function getProgressData() {
  try { return JSON.parse(localStorage.getItem('ctoplayer_progress')) || {}; }
  catch { return {}; }
}

function saveProgressData(data) {
  localStorage.setItem('ctoplayer_progress', JSON.stringify(data));
}

function getItemProgress(url) {
  return getProgressData()[url] || null;
}

function saveItemProgress(url, currentTime, duration) {
  if (!url || !duration || duration < 10) return;
  const data = getProgressData();
  const percent = (currentTime / duration) * 100;
  if (percent > 90) {
    data[url] = { currentTime: 0, duration, percent: 100, completed: true, updatedAt: Date.now() };
  } else {
    data[url] = { currentTime, duration, percent: Math.round(percent), completed: false, updatedAt: Date.now() };
  }
  saveProgressData(data);
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ===================== STATE =====================

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
  allFilteredItems: [],
  itemsToShow: 200,
  isLoadingMore: false,
  isRefreshing: false,
  progressTimer: null,
  currentStreamUrl: null,
  currentSeriesItem: null,
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
      refreshPlaylist(true);
    }
  } catch (e) {
    // No saved session
  }
}

// ===================== VIEW MANAGEMENT =====================

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
}

// ===================== LOGIN =====================

function setupLogin() {
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

  $('#m3u-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#m3u-url').value.trim();
    if (!url) return;
    await loadPlaylist('/api/load-m3u', { url }, e.target);
  });

  $('#xtream-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const server = $('#xtream-server').value.trim();
    const username = $('#xtream-user').value.trim();
    const password = $('#xtream-pass').value.trim();
    if (!server || !username || !password) return;
    await loadPlaylist('/api/load-xtream', { server, username, password }, e.target);
  });

  $('#btn-back-login').addEventListener('click', logout);

  async function logout() {
    state.playlist = null;
    state.allFilteredItems = [];
    state.itemsToShow = 200;
    await fetch('/api/session', { method: 'DELETE' });
    showView('login');
  }
}

async function loadPlaylist(endpoint, body, form) {
  const btn = form.querySelector('.btn');
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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastData = null;

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
          lastData = data;
          if (data.type === 'progress') {
            progressText.textContent = data.message;
            if (data.percent != null) progressFill.style.width = data.percent + '%';
          } else if (data.type === 'error') {
            throw new Error(data.error);
          } else if (data.type === 'done') {
            progressText.textContent = 'Carregando interface...';
            progressFill.style.width = '100%';
          }
        } catch (parseErr) {
          if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
        }
      }
    }

    if (lastData && lastData.type === 'error') throw new Error(lastData.error);

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
  // Tab switching (desktop + mobile)
  const allTabs = [...$$('.tab'), ...$$('.tab-mobile')];
  allTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => { b.classList.remove('btn-light', 'active'); b.classList.add('btn-outline-light'); });
      $$('.tab-mobile').forEach(b => { b.classList.remove('btn-light', 'active'); b.classList.add('btn-outline-light'); });
      // Activate matching tabs
      const type = btn.dataset.type;
      allTabs.filter(t => t.dataset.type === type).forEach(t => {
        t.classList.add('btn-light', 'active');
        t.classList.remove('btn-outline-light');
      });
      state.tab = type;
      state.category = 'all';
      state.sort = 'newest';
      $('#sort-select').value = 'newest';
      renderSidebar();
      renderContent();
    });
  });

  let searchTimeout;
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = e.target.value.trim().toLowerCase();
      renderContent();
    }, 200);
  });

  $('#sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderContent();
  });

  $('#btn-logout').addEventListener('click', async () => {
    state.playlist = null;
    state.allFilteredItems = [];
    state.itemsToShow = 200;
    await fetch('/api/session', { method: 'DELETE' });
    showView('login');
  });

  // Infinite scroll
  const contentArea = $('#content-area');
  contentArea.addEventListener('scroll', () => {
    if (state.isLoadingMore) return;
    const { scrollTop, scrollHeight, clientHeight } = contentArea;
    if (scrollHeight - scrollTop - clientHeight < 500 && state.itemsToShow < state.allFilteredItems.length) {
      state.isLoadingMore = true;
      state.itemsToShow += 100;
      setTimeout(() => renderContent(true), 100);
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

  $$('.tab').forEach(b => { b.classList.remove('btn-light', 'active'); b.classList.add('btn-outline-light'); });
  $$('.tab-mobile').forEach(b => { b.classList.remove('btn-light', 'active'); b.classList.add('btn-outline-light'); });
  const liveTab = $('.tab[data-type="live"]');
  const liveMobile = $('.tab-mobile[data-type="live"]');
  if (liveTab) { liveTab.classList.add('btn-light', 'active'); liveTab.classList.remove('btn-outline-light'); }
  if (liveMobile) { liveMobile.classList.add('btn-light', 'active'); liveMobile.classList.remove('btn-outline-light'); }

  showView('dashboard');
  renderSidebar();
  renderContent();
}

// ===================== REFRESH =====================

async function refreshPlaylist(silent) {
  const btn = $('#btn-refresh');
  const btnText = $('#btn-refresh-text');
  const progressEl = $('#refresh-progress');
  const progressFill = $('#refresh-progress-fill');
  const statusEl = $('#refresh-status');

  if (state.isRefreshing) return;
  state.isRefreshing = true;
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
            statusEl.textContent = data.error;
          } else if (data.type === 'done') {
            success = true;
          }
        } catch { /* ignore */ }
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
    statusEl.textContent = 'Falha ao atualizar';
  } finally {
    state.isRefreshing = false;
    btn.disabled = false;
    btnText.textContent = 'Atualizar';
    if (silent) progressEl.hidden = true;
  }
}

// ===================== SIDEBAR =====================

function renderSidebar() {
  const section = state.playlist[state.tab];
  if (!section) return;

  const cats = section.categories || [];
  const items = section.items || [];
  const favs = getFavorites();
  const favCount = items.filter(i => favs[getFavKey(i)]).length;

  let html = `<button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center ${state.category === 'all' ? 'active' : ''}" data-cat="all">
    <span>Todas</span><span class="badge bg-secondary rounded-pill">${items.length}</span>
  </button>`;

  if (favCount > 0) {
    html += `<button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center ${state.category === '__favs__' ? 'active' : ''}" data-cat="__favs__">
      <span>\u2B50 Favoritos</span><span class="badge bg-secondary rounded-pill">${favCount}</span>
    </button>`;
  }

  for (const cat of cats) {
    html += `<button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center ${state.category === cat.name ? 'active' : ''}" data-cat="${escapeAttr(cat.name)}">
      <span class="text-truncate" title="${escapeAttr(cat.name)}">${escapeHtml(truncate(cat.name, 22))}</span><span class="badge bg-secondary rounded-pill">${cat.count}</span>
    </button>`;
  }

  // Desktop sidebar
  $('#sidebar').innerHTML = html;
  $('#sidebar').querySelectorAll('.list-group-item').forEach(btn => {
    btn.addEventListener('click', () => {
      $('#sidebar').querySelectorAll('.list-group-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.category = btn.dataset.cat;
      renderContent();
    });
  });

  // Mobile sidebar
  $('#sidebar-mobile').innerHTML = html;
  $('#sidebar-mobile').querySelectorAll('.list-group-item').forEach(btn => {
    btn.addEventListener('click', () => {
      state.category = btn.dataset.cat;
      renderContent();
      renderSidebar();
      bootstrap.Offcanvas.getInstance($('#sidebar-offcanvas'))?.hide();
    });
  });
}

// ===================== CONTENT GRID =====================

function getGridClasses() {
  switch (state.settings.gridSize) {
    case 'small': return 'row row-cols-3 row-cols-sm-4 row-cols-md-5 row-cols-lg-7 row-cols-xl-8 g-2';
    case 'large': return 'row row-cols-2 row-cols-md-3 row-cols-lg-4 row-cols-xl-5 g-2';
    default: return 'row row-cols-2 row-cols-sm-3 row-cols-md-4 row-cols-lg-5 row-cols-xl-6 g-2';
  }
}

function renderContent(append = false) {
  const grid = $('#content-grid');
  const empty = $('#empty-state');
  const section = state.playlist[state.tab];
  if (!section) return;

  if (!append) {
    let items = [...(section.items || [])];

    if (items.length > 0 && items[0]._idx === undefined) {
      section.items.forEach((item, i) => { item._idx = i; });
    }

    if (state.category === '__favs__') {
      const favs = getFavorites();
      items = items.filter(i => favs[getFavKey(i)]);
    } else if (state.category !== 'all') {
      items = items.filter(i => i.group === state.category);
    }

    if (state.search) {
      items = items.filter(i => i.name.toLowerCase().includes(state.search));
    }

    switch (state.sort) {
      case 'newest': items.sort((a, b) => (b._idx || 0) - (a._idx || 0)); break;
      case 'oldest': items.sort((a, b) => (a._idx || 0) - (b._idx || 0)); break;
      case 'az': items.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'za': items.sort((a, b) => b.name.localeCompare(a.name)); break;
    }

    state.allFilteredItems = items;
    state.itemsToShow = 200;
  }

  grid.className = getGridClasses();

  if (state.allFilteredItems.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  const limit = Math.min(state.allFilteredItems.length, state.itemsToShow);
  const startIdx = append ? grid.querySelectorAll('.grid-col').length : 0;

  if (!append) grid.innerHTML = '';

  const loadingIndicator = grid.querySelector('.loading-more');
  if (loadingIndicator) loadingIndicator.remove();

  const fragment = document.createDocumentFragment();
  for (let i = startIdx; i < limit; i++) {
    fragment.appendChild(createGridItem(state.allFilteredItems[i]));
  }
  grid.appendChild(fragment);

  if (state.allFilteredItems.length > limit) {
    const more = document.createElement('div');
    more.className = 'loading-more col-12 text-center py-3 text-secondary small';
    more.innerHTML = `<div class="spinner-border spinner-border-sm text-primary mb-1"></div><div>Carregando... (${limit} de ${state.allFilteredItems.length})</div>`;
    grid.appendChild(more);
  }

  state.isLoadingMore = false;
}

function createGridItem(item) {
  const col = document.createElement('div');
  col.className = 'grid-col col';

  const fav = isFavorite(item);
  const isLive = state.tab === 'live';
  const posterRatio = isLive ? 'ratio-16x9' : 'ratio-2x3';

  const posterImg = item.logo
    ? `<img src="${escapeAttr(item.logo)}" alt="" loading="lazy" class="w-100 h-100 object-fit-cover" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'w-100 h-100 d-flex align-items-center justify-content-center text-secondary',innerHTML:'<i class=\\'bi bi-play-circle fs-1\\'></i>'}))">`
    : `<div class="w-100 h-100 d-flex align-items-center justify-content-center text-secondary"><i class="bi bi-play-circle fs-1"></i></div>`;

  let progressHtml = '';
  if (!item.isSeries && item.url) {
    const prog = getItemProgress(item.url);
    if (prog && prog.percent > 0) {
      const cls = prog.completed ? 'bg-success' : 'bg-primary';
      progressHtml = `<div class="progress" style="height:3px;border-radius:0"><div class="progress-bar ${cls}" style="width:${prog.percent}%"></div></div>`;
    }
  }

  col.innerHTML = `
    <div class="card h-100 grid-card">
      <div class="card-poster ${posterRatio} position-relative">
        ${posterImg}
        <button class="btn-fav ${fav ? 'is-fav' : ''}" data-fav>${fav ? '\u2605' : '\u2606'}</button>
      </div>
      ${progressHtml}
      <div class="card-body p-2">
        <div class="small fw-medium text-truncate" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</div>
        <div class="small text-secondary text-truncate">${escapeHtml(item.group)}</div>
      </div>
    </div>
  `;

  const favBtn = col.querySelector('.btn-fav');
  favBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowFav = toggleFavorite(item);
    favBtn.classList.toggle('is-fav', nowFav);
    favBtn.textContent = nowFav ? '\u2605' : '\u2606';
    renderSidebar();
  });

  col.querySelector('.card').addEventListener('click', () => {
    if (item.isSeries) {
      openSeries(item);
    } else if (item.url) {
      if (item.streamId) {
        openMovieDetail(item);
      } else {
        maybeResumeOrPlay(item.url, item.name, 'dashboard');
      }
    }
  });

  return col;
}

// ===================== MOVIE DETAIL (OFFCANVAS) =====================

async function openMovieDetail(item) {
  const offcanvasEl = $('#vod-detail-offcanvas');
  const offcanvas = bootstrap.Offcanvas.getOrCreateInstance(offcanvasEl);

  $('#vod-detail-title').textContent = item.name;
  $('#vod-detail-cover').src = item.logo || '';
  $('#vod-detail-cover').hidden = !item.logo;

  // Badges
  let badges = '';
  if (item.rating) badges += `<span class="badge bg-warning text-dark">\u2605 ${escapeHtml(item.rating)}</span>`;
  if (item.year) badges += `<span class="badge bg-secondary">${escapeHtml(item.year)}</span>`;
  $('#vod-detail-badges').innerHTML = badges;

  // Clear pending fields
  $('#vod-detail-genre').hidden = true;
  $('#vod-detail-plot').hidden = true;
  $('#vod-detail-cast').hidden = true;
  $('#vod-detail-director').hidden = true;
  $('#vod-detail-trailer').hidden = true;

  // Fav button
  const favBtn = $('#vod-detail-fav');
  const fav = isFavorite(item);
  favBtn.innerHTML = fav ? '<i class="bi bi-star-fill"></i>' : '<i class="bi bi-star"></i>';
  favBtn.className = fav ? 'btn btn-warning' : 'btn btn-outline-warning';
  favBtn.onclick = () => {
    const nowFav = toggleFavorite(item);
    favBtn.innerHTML = nowFav ? '<i class="bi bi-star-fill"></i>' : '<i class="bi bi-star"></i>';
    favBtn.className = nowFav ? 'btn btn-warning' : 'btn btn-outline-warning';
    renderSidebar();
  };

  // Play button
  $('#vod-detail-play').onclick = () => {
    offcanvas.hide();
    maybeResumeOrPlay(item.url, item.name, 'dashboard');
  };

  offcanvas.show();

  // Fetch full details
  try {
    const res = await fetch(`/api/vod/${item.streamId}`);
    if (res.ok) {
      const info = await res.json();
      if (info.plot) { $('#vod-detail-plot').textContent = info.plot; $('#vod-detail-plot').hidden = false; }
      if (info.genre) { $('#vod-detail-genre').textContent = info.genre; $('#vod-detail-genre').hidden = false; }
      if (info.cast) { $('#vod-detail-cast').innerHTML = `<strong>Elenco:</strong> ${escapeHtml(info.cast)}`; $('#vod-detail-cast').hidden = false; }
      if (info.director) { $('#vod-detail-director').innerHTML = `<strong>Dire\u00e7\u00e3o:</strong> ${escapeHtml(info.director)}`; $('#vod-detail-director').hidden = false; }
      if (info.duration) {
        $('#vod-detail-badges').innerHTML += `<span class="badge bg-info">${escapeHtml(info.duration)}</span>`;
      }
      if (info.cover) { $('#vod-detail-cover').src = info.cover; $('#vod-detail-cover').hidden = false; }
      if (info.youtubeTrailer) {
        $('#vod-detail-trailer').href = `https://www.youtube.com/watch?v=${encodeURIComponent(info.youtubeTrailer)}`;
        $('#vod-detail-trailer').hidden = false;
      }
    }
  } catch (e) { /* basic info already shown */ }
}

// ===================== RESUME OR PLAY =====================

function maybeResumeOrPlay(url, name, fromView) {
  const prog = getItemProgress(url);
  if (prog && !prog.completed && prog.currentTime > 10 && prog.percent < 90) {
    const modalEl = $('#resume-modal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    $('#resume-item-name').textContent = name;
    $('#resume-time-info').textContent = `Parou em ${formatTime(prog.currentTime)} de ${formatTime(prog.duration)} (${prog.percent}%)`;

    const onResume = () => { modal.hide(); cleanup(); playStream(url, name, fromView, prog.currentTime); };
    const onRestart = () => { modal.hide(); cleanup(); playStream(url, name, fromView, 0); };
    const cleanup = () => {
      $('#btn-resume-yes').removeEventListener('click', onResume);
      $('#btn-resume-no').removeEventListener('click', onRestart);
    };
    $('#btn-resume-yes').addEventListener('click', onResume);
    $('#btn-resume-no').addEventListener('click', onRestart);
    modal.show();
  } else {
    playStream(url, name, fromView, 0);
  }
}

// ===================== SERIES DETAIL =====================

async function openSeries(item) {
  state.currentSeriesItem = item;
  $('#series-title').textContent = item.name;
  $('#series-detail-title').textContent = item.name;
  $('#series-cover').src = item.logo || '';
  $('#series-cover').hidden = !item.logo;
  $('#series-badges').innerHTML = '';
  $('#series-genre').hidden = true;
  $('#series-plot').hidden = true;
  $('#series-cast').hidden = true;
  $('#series-director').hidden = true;
  $('#series-trailer').hidden = true;

  // Fav button
  const favBtn = $('#btn-fav-series');
  const fav = isFavorite(item);
  favBtn.innerHTML = fav ? '<i class="bi bi-star-fill me-1"></i>Favoritado' : '<i class="bi bi-star me-1"></i>Favoritar';
  favBtn.className = fav ? 'btn btn-sm btn-warning w-100' : 'btn btn-sm btn-outline-warning w-100';
  favBtn.onclick = () => {
    const nowFav = toggleFavorite(item);
    favBtn.innerHTML = nowFav ? '<i class="bi bi-star-fill me-1"></i>Favoritado' : '<i class="bi bi-star me-1"></i>Favoritar';
    favBtn.className = nowFav ? 'btn btn-sm btn-warning w-100' : 'btn btn-sm btn-outline-warning w-100';
    renderSidebar();
  };

  // Show rating/year from grid data
  let badges = '';
  if (item.rating) badges += `<span class="badge bg-warning text-dark">\u2605 ${escapeHtml(item.rating)}</span>`;
  if (item.year) badges += `<span class="badge bg-secondary">${escapeHtml(item.year)}</span>`;
  $('#series-badges').innerHTML = badges;

  $('#series-seasons').innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div><p class="text-secondary mt-2">Carregando temporadas...</p></div>';
  showView('series');
  $('#btn-back-dashboard').onclick = () => showView('dashboard');

  if (item.seasons) {
    renderSeasons({ name: item.name, seasons: item.seasons });
    return;
  }

  if (item.seriesId) {
    try {
      const res = await fetch(`/api/series/${item.seriesId}`);
      if (!res.ok) throw new Error('Falha ao carregar');
      const data = await res.json();

      // Fill info panel from API
      if (data.cover) { $('#series-cover').src = data.cover; $('#series-cover').hidden = false; }
      if (data.plot) { $('#series-plot').textContent = data.plot; $('#series-plot').hidden = false; }
      if (data.genre) { $('#series-genre').textContent = data.genre; $('#series-genre').hidden = false; }
      if (data.cast) { $('#series-cast').innerHTML = `<strong>Elenco:</strong> ${escapeHtml(data.cast)}`; $('#series-cast').hidden = false; }
      if (data.director) { $('#series-director').innerHTML = `<strong>Dire\u00e7\u00e3o:</strong> ${escapeHtml(data.director)}`; $('#series-director').hidden = false; }
      if (data.youtubeTrailer) {
        $('#series-trailer').href = `https://www.youtube.com/watch?v=${encodeURIComponent(data.youtubeTrailer)}`;
        $('#series-trailer').hidden = false;
      }
      let extraBadges = '';
      if (data.rating) extraBadges += `<span class="badge bg-warning text-dark">\u2605 ${escapeHtml(data.rating)}</span>`;
      if (data.releaseDate) extraBadges += `<span class="badge bg-secondary">${escapeHtml(data.releaseDate)}</span>`;
      if (data.episodeRunTime) extraBadges += `<span class="badge bg-info">${escapeHtml(data.episodeRunTime)} min</span>`;
      if (extraBadges) $('#series-badges').innerHTML = extraBadges;

      renderSeasons(data);
    } catch (err) {
      $('#series-seasons').innerHTML = `<div class="alert alert-danger">Erro: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  $('#series-seasons').innerHTML = '<div class="alert alert-secondary">Nenhum epis\u00f3dio encontrado</div>';
}

function renderSeasons(data) {
  const container = $('#series-seasons');
  const seasons = data.seasons || {};
  const keys = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));

  if (keys.length === 0) {
    container.innerHTML = '<div class="alert alert-secondary">Nenhum epis\u00f3dio encontrado</div>';
    return;
  }

  const queue = [];
  for (const num of keys) {
    for (const ep of seasons[num]) {
      queue.push({ url: ep.url, name: ep.name });
    }
  }

  const progressData = getProgressData();

  let html = '<div class="accordion" id="seasons-accordion">';
  let queueIdx = 0;
  for (let ki = 0; ki < keys.length; ki++) {
    const num = keys[ki];
    const episodes = seasons[num];
    const collapseId = `season-${num}`;
    const isFirst = ki === 0;

    html += `
    <div class="accordion-item">
      <h2 class="accordion-header">
        <button class="accordion-button ${isFirst ? '' : 'collapsed'}" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}">
          Temporada ${num} <span class="badge bg-secondary ms-2">${episodes.length} ep.</span>
        </button>
      </h2>
      <div id="${collapseId}" class="accordion-collapse collapse ${isFirst ? 'show' : ''}" data-bs-parent="#seasons-accordion">
        <div class="list-group list-group-flush">`;

    for (const ep of episodes) {
      const prog = progressData[ep.url];
      const pct = prog ? prog.percent : 0;
      const isCompleted = prog && prog.completed;
      const progressBar = pct > 0
        ? `<div class="progress mt-1" style="height:3px"><div class="progress-bar ${isCompleted ? 'bg-success' : 'bg-primary'}" style="width:${pct}%"></div></div>`
        : '';
      const watchedBadge = isCompleted ? '<span class="badge bg-success ms-auto">Visto</span>' : '';

      html += `
        <div class="list-group-item list-group-item-action p-0">
          <div class="episode-item d-flex align-items-center gap-2 px-3 py-2" data-url="${escapeAttr(ep.url)}" data-name="${escapeAttr(ep.name)}" data-queue-idx="${queueIdx}">
            <span class="text-primary fw-bold small">E${String(ep.episode).padStart(2, '0')}</span>
            <span class="small flex-grow-1 text-truncate">${escapeHtml(ep.name)}</span>
            ${ep.duration ? `<span class="text-secondary small">${escapeHtml(ep.duration)}</span>` : ''}
            ${watchedBadge}
          </div>
          ${progressBar}
        </div>`;
      queueIdx++;
    }

    html += '</div></div></div>';
  }
  html += '</div>';

  container.innerHTML = html;

  container.querySelectorAll('.episode-item').forEach(el => {
    el.addEventListener('click', () => {
      state.episodeQueue = queue;
      state.currentEpisodeIdx = parseInt(el.dataset.queueIdx, 10);
      maybeResumeOrPlay(el.dataset.url, el.dataset.name, 'series');
    });
  });
}

// ===================== PLAYER =====================

function setupPlayer() {
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
    console.warn('[PLAYER] Plyr init failed:', e.message);
  }

  $('#btn-back-player').addEventListener('click', stopPlayback);
  $('#btn-retry').addEventListener('click', () => {
    const video = $('#video-player');
    const src = video.dataset.originalUrl;
    const name = $('#player-title').textContent;
    if (src) playStream(src, name, state.previousView, video.currentTime || 0);
  });
  $('#btn-prev-ep').addEventListener('click', playPrevEpisode);
  $('#btn-next-ep').addEventListener('click', playNextEpisode);
}

function detectStreamType(url) {
  const u = url.toLowerCase();
  if (u.includes('.m3u8') || u.includes('type=m3u8')) return 'hls';
  if (u.includes('.ts') || u.includes('/live/')) return 'ts';
  return 'direct';
}

function playStream(url, name, fromView, resumeAt) {
  state.previousView = fromView || 'dashboard';
  state.currentStreamUrl = url;
  const video = $('#video-player');
  const errorEl = $('#player-error');

  if (state.playerAbort) state.playerAbort.abort();
  state.playerAbort = new AbortController();
  const { signal } = state.playerAbort;

  if (state.stallTimer) { clearInterval(state.stallTimer); state.stallTimer = null; }
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }
  if (state.progressTimer) { clearInterval(state.progressTimer); state.progressTimer = null; }
  state.recoveryAttempts = 0;

  const nextEpOverlay = $('#next-ep-overlay');
  if (nextEpOverlay) nextEpOverlay.hidden = true;

  video.dataset.originalUrl = url;
  errorEl.hidden = true;
  $('#player-title').textContent = name;

  updateEpNavButtons();

  if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
  if (state.mpegtsInstance) { state.mpegtsInstance.destroy(); state.mpegtsInstance = null; }

  video.pause();
  video.removeAttribute('src');
  video.load();

  // Apply default volume
  video.volume = (state.settings.defaultVolume || 100) / 100;

  showView('player');

  const proxyUrl = location.origin + '/api/proxy?url=' + encodeURIComponent(url);
  const streamType = detectStreamType(url);

  if (streamType === 'hls' && Hls.isSupported()) {
    const hls = new Hls({
      maxBufferLength: 60, maxMaxBufferLength: 120, maxBufferSize: 60 * 1024 * 1024,
      maxBufferHole: 0.5, lowLatencyMode: false, fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000, manifestLoadingTimeOut: 15000,
      manifestLoadingMaxRetry: 4, levelLoadingTimeOut: 15000, levelLoadingMaxRetry: 4, startFragPrefetch: true,
    });
    state.hlsInstance = hls;
    hls.loadSource(proxyUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.on(Hls.Events.FRAG_LOADED, () => { state.recoveryAttempts = 0; });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (state.recoveryAttempts >= 10) { errorEl.hidden = false; return; }
      state.recoveryAttempts++;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        setTimeout(() => { if (state.hlsInstance) hls.startLoad(); }, Math.min(2000 * state.recoveryAttempts, 10000));
      } else {
        hls.destroy();
        const newHls = new Hls(hls.config);
        state.hlsInstance = newHls;
        newHls.loadSource(proxyUrl);
        newHls.attachMedia(video);
        newHls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
      }
    });

    setupStallDetection(video, signal, () => { if (state.hlsInstance) state.hlsInstance.recoverMediaError(); });

  } else if (streamType === 'ts' && typeof mpegts !== 'undefined' && mpegts.isSupported()) {
    const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: proxyUrl }, {
      enableWorker: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 30,
      liveBufferLatencyMinRemain: 3, lazyLoadMaxDuration: 120, autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30, autoCleanupMinBackwardDuration: 15,
    });
    state.mpegtsInstance = player;
    player.attachMediaElement(video);
    player.load();
    player.play().catch(() => {});

    player.on(mpegts.Events.ERROR, () => {
      if (state.recoveryAttempts >= 5) { errorEl.hidden = false; return; }
      state.recoveryAttempts++;
      setTimeout(() => { try { player.unload(); player.load(); player.play().catch(() => {}); } catch { errorEl.hidden = false; } }, 2000);
    });

    setupStallDetection(video, signal, () => {
      if (state.mpegtsInstance) { try { state.mpegtsInstance.unload(); state.mpegtsInstance.load(); state.mpegtsInstance.play().catch(() => {}); } catch {} }
    });

  } else if (streamType === 'hls' && video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxyUrl;
    video.addEventListener('error', () => { errorEl.hidden = false; }, { signal });
    video.play().catch(() => {});
  } else {
    video.src = proxyUrl;
    video.addEventListener('error', () => { errorEl.hidden = false; }, { signal });
    video.play().catch(() => {});
    setupStallDetection(video, signal, () => {
      const ct = video.currentTime;
      video.src = proxyUrl;
      video.currentTime = ct;
      video.play().catch(() => {});
    });
  }

  // Resume at position
  if (resumeAt && resumeAt > 0) {
    video.addEventListener('loadedmetadata', function seekOnce() {
      video.currentTime = resumeAt;
      video.removeEventListener('loadedmetadata', seekOnce);
    }, { signal });
  }

  // Skip intro
  if (state.settings.skipIntroSeconds > 0 && state.episodeQueue.length > 0) {
    video.addEventListener('loadedmetadata', function skipIntro() {
      if (!resumeAt || resumeAt === 0) {
        video.currentTime = state.settings.skipIntroSeconds;
      }
      video.removeEventListener('loadedmetadata', skipIntro);
    }, { signal });
  }

  // Progress saving
  state.progressTimer = setInterval(() => {
    if (!video.paused && !video.ended && video.duration && isFinite(video.duration) && video.currentTime > 5) {
      saveItemProgress(url, video.currentTime, video.duration);
    }
  }, 10000);

  video.addEventListener('pause', () => {
    if (video.duration && isFinite(video.duration) && video.currentTime > 5) saveItemProgress(url, video.currentTime, video.duration);
  }, { signal });
  video.addEventListener('ended', () => {
    if (video.duration && isFinite(video.duration)) saveItemProgress(url, video.duration, video.duration);
  }, { signal });

  state.nextEpTriggered = false;
  let overlayShown = false;

  if (state.settings.skipCreditsSeconds > 0 && state.episodeQueue.length > 0) {
    const skipAt = state.settings.skipCreditsSeconds;
    const warnAt = skipAt + 10;
    let skipArmed = false;
    video.addEventListener('loadedmetadata', () => { skipArmed = true; }, { signal, once: true });

    video.addEventListener('timeupdate', () => {
      if (state.nextEpTriggered || !skipArmed) return;
      if (!video.duration || !isFinite(video.duration)) return;
      if (video.currentTime < 30) return;
      const remaining = video.duration - video.currentTime;

      if (!overlayShown && remaining <= warnAt && remaining > skipAt) {
        overlayShown = true;
        showSkipWarning(remaining - skipAt);
      }

      if (remaining <= skipAt && remaining > 0) {
        state.nextEpTriggered = true;
        hideSkipWarning();
        video.pause();
        playNextEpisode();
      }
    }, { signal });
  }

  video.addEventListener('ended', () => {
    if (!state.nextEpTriggered && state.settings.autoPlayNext) showNextEpisodeOverlay();
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
        if (stallCount >= 3) { stallCount = 0; recoveryFn(); }
      } else { stallCount = 0; }
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
  if (state.nextEpTimer) clearInterval(state.nextEpTimer);
  state.nextEpTimer = setInterval(() => {
    countdown--;
    $('#next-ep-countdown').textContent = countdown;
    if (countdown <= 0) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; playNextEpisode(); }
  }, 1000);
}

function showSkipWarning(seconds) {
  const nextIdx = state.currentEpisodeIdx + 1;
  if (state.episodeQueue.length === 0 || nextIdx >= state.episodeQueue.length) return;
  const overlay = $('#next-ep-overlay');
  if (!overlay) return;
  $('#next-ep-name').textContent = state.episodeQueue[nextIdx].name;
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
  state.currentEpisodeIdx = prevIdx;
  playStream(state.episodeQueue[prevIdx].url, state.episodeQueue[prevIdx].name, 'series', 0);
}

function playNextEpisode() {
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }
  const nextIdx = state.currentEpisodeIdx + 1;
  if (state.episodeQueue.length === 0 || nextIdx >= state.episodeQueue.length) return;
  state.currentEpisodeIdx = nextIdx;
  playStream(state.episodeQueue[nextIdx].url, state.episodeQueue[nextIdx].name, 'series', 0);
}

function cancelNextEpisode() {
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }
  const overlay = $('#next-ep-overlay');
  if (overlay) overlay.hidden = true;
}

function stopPlayback() {
  const video = $('#video-player');
  if (state.currentStreamUrl && video.duration && isFinite(video.duration) && video.currentTime > 5) {
    saveItemProgress(state.currentStreamUrl, video.currentTime, video.duration);
  }

  if (state.stallTimer) { clearInterval(state.stallTimer); state.stallTimer = null; }
  if (state.nextEpTimer) { clearInterval(state.nextEpTimer); state.nextEpTimer = null; }
  if (state.progressTimer) { clearInterval(state.progressTimer); state.progressTimer = null; }

  if (state.playerAbort) { state.playerAbort.abort(); state.playerAbort = null; }
  if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
  if (state.mpegtsInstance) { state.mpegtsInstance.destroy(); state.mpegtsInstance = null; }

  state.episodeQueue = [];
  state.currentEpisodeIdx = -1;
  state.currentStreamUrl = null;

  const nextEpOverlay = $('#next-ep-overlay');
  if (nextEpOverlay) nextEpOverlay.hidden = true;

  video.pause();
  video.removeAttribute('src');
  showView(state.previousView);
}

// ===================== SETTINGS VIEW =====================

function setupSettings() {
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-back-settings').addEventListener('click', () => showView('dashboard'));
  $('#btn-refresh').addEventListener('click', () => refreshPlaylist(false));

  // Volume slider live label
  $('#setting-volume').addEventListener('input', (e) => {
    $('#setting-volume-label').textContent = e.target.value;
  });

  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings({
      skipCreditsSeconds: Math.max(0, Math.min(300, parseInt($('#setting-skip-credits').value, 10) || 0)),
      skipIntroSeconds: Math.max(0, Math.min(120, parseInt($('#setting-skip-intro').value, 10) || 0)),
      autoPlayNext: $('#setting-autoplay-next').checked,
      defaultVolume: parseInt($('#setting-volume').value, 10) || 100,
      gridSize: $('#setting-grid-size').value || 'medium',
    });

    // Apply grid size immediately
    renderContent();

    const btn = e.target.querySelector('.btn-primary');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Salvo!';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
  });

  // Clear progress
  $('#btn-clear-progress').addEventListener('click', () => {
    if (confirm('Remover todo o hist\u00f3rico de assistidos?')) {
      localStorage.removeItem('ctoplayer_progress');
      const btn = $('#btn-clear-progress');
      btn.innerHTML = '<i class="bi bi-check me-1"></i>Limpo!';
      setTimeout(() => { btn.innerHTML = '<i class="bi bi-trash me-1"></i>Limpar'; }, 1500);
    }
  });

  // Clear favorites
  $('#btn-clear-favorites').addEventListener('click', () => {
    if (confirm('Remover todos os favoritos?')) {
      localStorage.removeItem('ctoplayer_favorites');
      renderSidebar();
      const btn = $('#btn-clear-favorites');
      btn.innerHTML = '<i class="bi bi-check me-1"></i>Limpo!';
      setTimeout(() => { btn.innerHTML = '<i class="bi bi-trash me-1"></i>Limpar'; }, 1500);
    }
  });
}

function openSettings() {
  $('#setting-skip-credits').value = state.settings.skipCreditsSeconds;
  $('#setting-skip-intro').value = state.settings.skipIntroSeconds;
  $('#setting-autoplay-next').checked = state.settings.autoPlayNext;
  $('#setting-volume').value = state.settings.defaultVolume;
  $('#setting-volume-label').textContent = state.settings.defaultVolume;
  $('#setting-grid-size').value = state.settings.gridSize;
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
