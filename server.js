const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { URL } = require('url');

// Keep-alive agents for connection pooling (proxy)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 120000 });
httpAgent.setMaxListeners(0);
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 120000, rejectUnauthorized: false });
httpsAgent.setMaxListeners(0);

const app = express();
const PORT = process.env.PORT || 3125;

// Trust reverse proxy (nginx, etc.) for correct client IP
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ===================== SECURITY =====================

function isPrivateIP(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
  }
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd')) return true;
  return false;
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal' || h === 'instance-data') return true;
  if (net.isIP(h)) return isPrivateIP(h);
  return false;
}

function validateExternalUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (isBlockedHost(parsed.hostname)) return null;
  return parsed;
}

// Rate limiting
const rateCounters = new Map();

function getClientIP(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(key, maxPerMinute) {
  const now = Date.now();
  let entry = rateCounters.get(key);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + 60000 };
    rateCounters.set(key, entry);
  }
  entry.count++;
  return entry.count <= maxPerMinute;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateCounters) {
    if (now > entry.resetTime) rateCounters.delete(key);
  }
}, 120000);

const MAX_SESSIONS = 50;

const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
const LEGACY_SESSION_FILE = path.join(__dirname, 'data', 'session.json');

// ===================== MULTI-USER SESSION SYSTEM =====================

// In-memory cache: sid -> { playlist, xtreamConfig, source, credentials, lastAccess }
const sessions = new Map();

const COOKIE_NAME = 'ctoplayer_sid';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function parseSid(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  const val = match.substring(COOKIE_NAME.length + 1);
  // Validate UUID format to prevent path traversal
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(val)) {
    return val;
  }
  return null;
}

function setSidCookie(res, sid) {
  if (res.headersSent) return;
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`
  );
}

function sessionFilePath(sid) {
  return path.join(SESSIONS_DIR, sid + '.json');
}

function ensureSid(req, res) {
  let sid = parseSid(req);
  if (!sid) {
    sid = crypto.randomUUID();
    setSidCookie(res, sid);
  }
  return sid;
}

function getSession(req) {
  const sid = parseSid(req);
  if (!sid) return { sid: null, entry: null };

  let entry = sessions.get(sid);
  if (entry) {
    entry.lastAccess = Date.now();
    return { sid, entry };
  }

  entry = loadSessionFromDisk(sid);
  return { sid, entry };
}

// ===================== SESSION PERSISTENCE =====================

function saveSession(sid, source, credentials, playlist, xtreamCfg) {
  try {
    const session = {
      source,
      credentials,
      playlist,
      xtreamConfig: xtreamCfg,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(sessionFilePath(sid), JSON.stringify(session));
  } catch (err) {
    console.error('Erro ao salvar sessão:', err.message);
  }
}

function loadSessionFromDisk(sid) {
  try {
    const filePath = sessionFilePath(sid);
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (data.playlist) {
      const entry = {
        playlist: data.playlist,
        xtreamConfig: data.xtreamConfig || null,
        source: data.source,
        credentials: data.credentials,
        lastAccess: Date.now(),
      };
      sessions.set(sid, entry);
      return entry;
    }
  } catch (err) {
    console.error('Erro ao carregar sessão:', err.message);
  }
  return null;
}

function clearSession(sid) {
  sessions.delete(sid);
  try {
    const filePath = sessionFilePath(sid);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) { /* ignore */ }
}

// Evict sessions not accessed in the last 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of sessions) {
    if (now - entry.lastAccess > 30 * 60 * 1000) {
      sessions.delete(sid);
    }
  }
}, 5 * 60 * 1000);

// Delete session files older than 30 days
setInterval(() => {
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const stat = fs.statSync(path.join(SESSIONS_DIR, file));
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(path.join(SESSIONS_DIR, file));
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}, 60 * 60 * 1000);

// ===================== M3U PARSER =====================

function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const live = [];
  const movies = [];
  const series = [];

  let current = null;
  let idx = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('#EXTINF:')) {
      current = {};
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const idMatch = line.match(/tvg-id="([^"]*)"/i);
      const nameMatch = line.match(/,(.+)$/);

      current.group = groupMatch ? groupMatch[1].trim() : 'Sem Categoria';
      current.logo = logoMatch ? logoMatch[1] : '';
      current.tvgId = idMatch ? idMatch[1] : '';
      current.name = nameMatch ? nameMatch[1].trim() : 'Desconhecido';
    } else if (line && !line.startsWith('#') && current) {
      current.url = line;
      current._idx = idx++;

      const url = line.toLowerCase();
      const group = current.group.toLowerCase();

      if (url.includes('/movie/') || group.includes('vod') || group.includes('movie') || group.includes('filme')) {
        movies.push(current);
      } else if (url.includes('/series/') || group.includes('series') || group.includes('série') || group.includes('serie')) {
        series.push(current);
      } else {
        live.push(current);
      }
      current = null;
    }
  }

  return buildPlaylistResponse(live, movies, series);
}

function buildPlaylistResponse(live, movies, series, skipGrouping) {
  const groupedSeries = skipGrouping ? series : groupSeriesItems(series);

  return {
    live: {
      categories: extractCategories(live),
      items: live,
      count: live.length,
    },
    movies: {
      categories: extractCategories(movies),
      items: movies,
      count: movies.length,
    },
    series: {
      categories: extractCategories(groupedSeries),
      items: groupedSeries,
      count: groupedSeries.length,
    },
  };
}

function extractCategories(items) {
  const cats = {};
  for (const item of items) {
    const g = item.group || 'Sem Categoria';
    cats[g] = (cats[g] || 0) + 1;
  }
  return Object.entries(cats)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

// ===================== SERIES GROUPING =====================

function parseSeriesInfo(name) {
  // Match: S01E01, S1E1, S01 E01, S01.E01, etc.
  const match = name.match(/[\s\-._]*[Ss](\d{1,2})\s*[Ee](\d{1,3})/);
  if (match) {
    const baseName = name.substring(0, match.index).replace(/[\s\-._]+$/, '').trim();
    return {
      baseName: baseName || name,
      season: parseInt(match[1], 10),
      episode: parseInt(match[2], 10),
    };
  }
  return null;
}

function groupSeriesItems(items) {
  const seriesMap = {};
  const ungrouped = [];

  for (const item of items) {
    const info = parseSeriesInfo(item.name);
    if (info) {
      const key = info.baseName.toLowerCase().trim();
      if (!seriesMap[key]) {
        seriesMap[key] = {
          name: info.baseName,
          group: item.group,
          logo: item.logo,
          isSeries: true,
          _idx: item._idx || 0,
          seasons: {},
        };
      }
      // Track the highest _idx (most recently added episode = series position)
      if ((item._idx || 0) > seriesMap[key]._idx) {
        seriesMap[key]._idx = item._idx;
      }
      const s = String(info.season);
      if (!seriesMap[key].seasons[s]) {
        seriesMap[key].seasons[s] = [];
      }
      // Deduplicate: skip if this episode number already exists in this season
      const alreadyExists = seriesMap[key].seasons[s].some(e => e.episode === info.episode);
      if (!alreadyExists) {
        seriesMap[key].seasons[s].push({
          name: item.name,
          episode: info.episode,
          url: item.url,
          logo: item.logo || '',
        });
      }
      // Use first available logo
      if (!seriesMap[key].logo && item.logo) {
        seriesMap[key].logo = item.logo;
      }
    } else {
      // No SxxExx pattern — keep as standalone item
      ungrouped.push(item);
    }
  }

  // Sort episodes within each season
  for (const series of Object.values(seriesMap)) {
    for (const s of Object.keys(series.seasons)) {
      series.seasons[s].sort((a, b) => a.episode - b.episode);
    }
  }

  return [...Object.values(seriesMap), ...ungrouped];
}

// ===================== XTREAM CODES =====================

function buildXtreamPlaylist(server, user, pass, liveCats, liveStreams, vodCats, vodStreams, seriesCats, seriesData) {
  const catMap = (arr) => {
    const m = {};
    if (Array.isArray(arr)) arr.forEach(c => m[c.category_id] = c.category_name);
    return m;
  };

  const liveCatMap = catMap(liveCats);
  const vodCatMap = catMap(vodCats);
  const seriesCatMap = catMap(seriesCats);

  const live = (Array.isArray(liveStreams) ? liveStreams : []).map((s, i) => ({
    name: s.name || 'Desconhecido',
    group: liveCatMap[s.category_id] || 'Sem Categoria',
    logo: s.stream_icon || '',
    url: `${server}/live/${user}/${pass}/${s.stream_id}.m3u8`,
    tvgId: s.epg_channel_id || '',
    _idx: Number(s.added) || i,
  }));

  const movies = (Array.isArray(vodStreams) ? vodStreams : []).map((s, i) => ({
    name: s.name || 'Desconhecido',
    group: vodCatMap[s.category_id] || 'Sem Categoria',
    logo: s.stream_icon || '',
    url: `${server}/movie/${user}/${pass}/${s.stream_id}.${s.container_extension || 'mp4'}`,
    tvgId: '',
    rating: s.rating || '',
    year: s.year || '',
    _idx: Number(s.added) || i,
  }));

  const seriesItems = (Array.isArray(seriesData) ? seriesData : []).map((s, i) => ({
    name: s.name || 'Desconhecido',
    group: seriesCatMap[s.category_id] || 'Sem Categoria',
    logo: s.cover || '',
    seriesId: s.series_id,
    tvgId: '',
    rating: s.rating || '',
    year: s.year || '',
    isSeries: true,
    _idx: Number(s.last_modified) || i,
  }));

  return buildPlaylistResponse(live, movies, seriesItems, true);
}

// ===================== ROUTES =====================

app.post('/api/load-m3u', (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(`load:${ip}`, 5)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto.' });
  }

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  const parsedUrl = validateExternalUrl(url);
  if (!parsedUrl) {
    return res.status(400).json({ error: 'URL inválida ou bloqueada' });
  }

  const sid = ensureSid(req, res);

  // Check session limit before allowing new playlist load
  if (!sessions.has(sid)) {
    try {
      const fileCount = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).length;
      if (fileCount >= MAX_SESSIONS) {
        return res.status(503).json({ error: 'Limite de sessões atingido. Tente mais tarde.' });
      }
    } catch { /* ignore */ }
  }

  // Stream progress as NDJSON
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch(e) {} };

  send({ type: 'progress', message: 'Conectando ao servidor...', percent: 5 });

  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const chunks = [];
  let received = 0;
  let totalSize = 0;

  const dlReq = transport.request({
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip, deflate, identity' },
    agent: isHttps ? httpsAgent : httpAgent,
    timeout: 15000,
  }, (upstream) => {
    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode)) {
      upstream.resume();
      const loc = upstream.headers.location;
      if (loc) {
        const rUrl = loc.startsWith('http') ? loc : `${parsedUrl.protocol}//${parsedUrl.host}${loc}`;
        // Validate redirect target is not internal
        if (!validateExternalUrl(rUrl)) {
          send({ type: 'error', error: 'Redirecionamento para destino bloqueado' });
          return res.end();
        }
        send({ type: 'progress', message: 'Redirecionando...', percent: 5 });
        axios.get(rUrl, { timeout: 120000, maxContentLength: 200 * 1024 * 1024, responseType: 'text' })
          .then(r => finishM3U(r.data))
          .catch(e => { send({ type: 'error', error: e.message }); res.end(); });
        return;
      }
      send({ type: 'error', error: 'Redirect sem destino' });
      return res.end();
    }

    if (upstream.statusCode >= 400) {
      upstream.resume();
      send({ type: 'error', error: `Servidor retornou erro ${upstream.statusCode}` });
      return res.end();
    }

    totalSize = parseInt(upstream.headers['content-length'] || '0', 10);
    const encoding = upstream.headers['content-encoding'];
    let stream = upstream;
    if (encoding === 'gzip') stream = upstream.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = upstream.pipe(zlib.createInflate());

    send({ type: 'progress', message: 'Baixando playlist...', percent: 10 });

    // Track progress every 500ms
    let lastProgressTime = Date.now();
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastProgressTime > 500) {
        lastProgressTime = now;
        const mb = (received / 1024 / 1024).toFixed(1);
        let pct = 10;
        if (totalSize > 0) pct = Math.min(70, 10 + Math.round((received / totalSize) * 60));
        else pct = Math.min(70, 10 + Math.round(received / (50 * 1024 * 1024) * 60)); // estimate for 50MB
        send({ type: 'progress', message: `Baixando playlist... ${mb} MB`, percent: pct });
      }
    });

    stream.on('end', () => {
      const content = Buffer.concat(chunks).toString('utf-8');
      finishM3U(content);
    });

    stream.on('error', (err) => {
      send({ type: 'error', error: 'Erro no download: ' + err.message });
      res.end();
    });
  });

  dlReq.on('timeout', () => {
    dlReq.destroy();
    send({ type: 'error', error: 'Tempo limite de conexao' });
    res.end();
  });

  dlReq.on('error', (err) => {
    send({ type: 'error', error: 'Falha na conexao: ' + err.message });
    res.end();
  });

  dlReq.end();

  function finishM3U(content) {
    const mb = (Buffer.byteLength(content) / 1024 / 1024).toFixed(1);
    send({ type: 'progress', message: `Download completo (${mb} MB). Processando...`, percent: 75 });

    if (!content.includes('#EXTM3U')) {
      send({ type: 'error', error: 'Playlist M3U invalida' });
      return res.end();
    }

    send({ type: 'progress', message: 'Analisando canais e categorias...', percent: 80 });
    const playlist = parseM3U(content);

    sessions.set(sid, {
      playlist,
      xtreamConfig: null,
      source: 'm3u',
      credentials: { url },
      lastAccess: Date.now(),
    });

    send({ type: 'progress', message: 'Salvando sessao...', percent: 95 });
    saveSession(sid, 'm3u', { url }, playlist, null);

    const stats = { live: playlist.live.count, movies: playlist.movies.count, series: playlist.series.count };
    send({ type: 'progress', message: `Pronto! ${stats.live} canais, ${stats.movies} filmes, ${stats.series} series`, percent: 100 });
    send({ type: 'done', stats });
    res.end();
  }
});

app.post('/api/load-xtream', async (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(`load:${ip}`, 5)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto.' });
  }

  const { server, username, password } = req.body;
  if (!server || !username || !password) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }

  if (!validateExternalUrl(server)) {
    return res.status(400).json({ error: 'URL do servidor inválida ou bloqueada' });
  }

  const sid = ensureSid(req, res);

  // Check session limit
  if (!sessions.has(sid)) {
    try {
      const fileCount = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).length;
      if (fileCount >= MAX_SESSIONS) {
        return res.status(503).json({ error: 'Limite de sessões atingido. Tente mais tarde.' });
      }
    } catch { /* ignore */ }
  }

  // Stream progress as NDJSON
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch(e) {} };

  try {
    const cleanServer = server.replace(/\/+$/, '');
    const base = `${cleanServer}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

    send({ type: 'progress', message: 'Autenticando no servidor...', percent: 5 });
    const authRes = await axios.get(base, { timeout: 15000 });
    if (authRes.data.user_info && authRes.data.user_info.auth === 0) {
      send({ type: 'error', error: 'Autenticacao falhou - verifique usuario e senha' });
      return res.end();
    }

    send({ type: 'progress', message: 'Autenticado! Carregando categorias de TV...', percent: 10 });
    const liveCats = await axios.get(`${base}&action=get_live_categories`, { timeout: 30000 }).then(r => r.data).catch(() => []);
    send({ type: 'progress', message: `Categorias de TV: ${Array.isArray(liveCats) ? liveCats.length : 0}. Carregando canais...`, percent: 20 });

    const liveStreams = await axios.get(`${base}&action=get_live_streams`, { timeout: 120000 }).then(r => r.data).catch(() => []);
    send({ type: 'progress', message: `${Array.isArray(liveStreams) ? liveStreams.length : 0} canais ao vivo. Carregando categorias de filmes...`, percent: 35 });

    const vodCats = await axios.get(`${base}&action=get_vod_categories`, { timeout: 30000 }).then(r => r.data).catch(() => []);
    send({ type: 'progress', message: `Categorias de filmes: ${Array.isArray(vodCats) ? vodCats.length : 0}. Carregando filmes...`, percent: 45 });

    const vodStreams = await axios.get(`${base}&action=get_vod_streams`, { timeout: 120000 }).then(r => r.data).catch(() => []);
    send({ type: 'progress', message: `${Array.isArray(vodStreams) ? vodStreams.length : 0} filmes. Carregando categorias de series...`, percent: 60 });

    const seriesCats = await axios.get(`${base}&action=get_series_categories`, { timeout: 30000 }).then(r => r.data).catch(() => []);
    send({ type: 'progress', message: `Categorias de series: ${Array.isArray(seriesCats) ? seriesCats.length : 0}. Carregando series...`, percent: 70 });

    const seriesData = await axios.get(`${base}&action=get_series`, { timeout: 120000 }).then(r => r.data).catch(() => []);
    send({ type: 'progress', message: `${Array.isArray(seriesData) ? seriesData.length : 0} series. Montando playlist...`, percent: 85 });

    const xtreamCfg = { server: cleanServer, username, password };
    const playlist = buildXtreamPlaylist(cleanServer, username, password, liveCats, liveStreams, vodCats, vodStreams, seriesCats, seriesData);

    sessions.set(sid, {
      playlist,
      xtreamConfig: xtreamCfg,
      source: 'xtream',
      credentials: { server: cleanServer, username, password },
      lastAccess: Date.now(),
    });

    send({ type: 'progress', message: 'Salvando sessao...', percent: 95 });
    saveSession(sid, 'xtream', { server: cleanServer, username, password }, playlist, xtreamCfg);

    const stats = { live: playlist.live.count, movies: playlist.movies.count, series: playlist.series.count };
    send({ type: 'progress', message: `Pronto! ${stats.live} canais, ${stats.movies} filmes, ${stats.series} series`, percent: 100 });
    send({ type: 'done', stats });
    res.end();
  } catch (err) {
    send({ type: 'error', error: 'Falha ao conectar: ' + err.message });
    res.end();
  }
});

// ===================== REFRESH (re-fetch from source) =====================

app.post('/api/refresh', async (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(`refresh:${ip}`, 3)) {
    return res.status(429).json({ error: 'Muitas atualizações. Aguarde um minuto.' });
  }

  const { entry, sid } = getSession(req);
  if (!entry || !entry.source || !entry.credentials) {
    return res.status(404).json({ error: 'Nenhuma sessão salva para atualizar' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch(e) {} };

  try {
    if (entry.source === 'm3u') {
      const url = entry.credentials.url;
      const parsedUrl = validateExternalUrl(url);
      if (!parsedUrl) {
        send({ type: 'error', error: 'URL da playlist inválida' });
        return res.end();
      }

      send({ type: 'progress', message: 'Baixando playlist atualizada...', percent: 10 });

      const content = await axios.get(url, {
        timeout: 120000,
        maxContentLength: 200 * 1024 * 1024,
        responseType: 'text',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }).then(r => r.data);

      if (!content.includes('#EXTM3U')) {
        send({ type: 'error', error: 'Playlist M3U inválida' });
        return res.end();
      }

      send({ type: 'progress', message: 'Processando playlist...', percent: 60 });
      const playlist = parseM3U(content);

      entry.playlist = playlist;
      entry.lastAccess = Date.now();
      sessions.set(sid, entry);
      saveSession(sid, 'm3u', entry.credentials, playlist, null);

      const stats = { live: playlist.live.count, movies: playlist.movies.count, series: playlist.series.count };
      send({ type: 'progress', message: `Atualizado! ${stats.live} canais, ${stats.movies} filmes, ${stats.series} séries`, percent: 100 });
      send({ type: 'done', stats });
      res.end();

    } else if (entry.source === 'xtream') {
      const { server, username, password } = entry.credentials;
      const base = `${server}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

      send({ type: 'progress', message: 'Autenticando...', percent: 5 });
      const authRes = await axios.get(base, { timeout: 15000 });
      if (authRes.data.user_info && authRes.data.user_info.auth === 0) {
        send({ type: 'error', error: 'Autenticação falhou' });
        return res.end();
      }

      send({ type: 'progress', message: 'Carregando TV ao vivo...', percent: 15 });
      const liveCats = await axios.get(`${base}&action=get_live_categories`, { timeout: 30000 }).then(r => r.data).catch(() => []);
      const liveStreams = await axios.get(`${base}&action=get_live_streams`, { timeout: 120000 }).then(r => r.data).catch(() => []);

      send({ type: 'progress', message: 'Carregando filmes...', percent: 40 });
      const vodCats = await axios.get(`${base}&action=get_vod_categories`, { timeout: 30000 }).then(r => r.data).catch(() => []);
      const vodStreams = await axios.get(`${base}&action=get_vod_streams`, { timeout: 120000 }).then(r => r.data).catch(() => []);

      send({ type: 'progress', message: 'Carregando séries...', percent: 65 });
      const seriesCats = await axios.get(`${base}&action=get_series_categories`, { timeout: 30000 }).then(r => r.data).catch(() => []);
      const seriesData = await axios.get(`${base}&action=get_series`, { timeout: 120000 }).then(r => r.data).catch(() => []);

      send({ type: 'progress', message: 'Montando playlist...', percent: 85 });
      const xtreamCfg = { server, username, password };
      const playlist = buildXtreamPlaylist(server, username, password, liveCats, liveStreams, vodCats, vodStreams, seriesCats, seriesData);

      entry.playlist = playlist;
      entry.xtreamConfig = xtreamCfg;
      entry.lastAccess = Date.now();
      sessions.set(sid, entry);
      saveSession(sid, 'xtream', entry.credentials, playlist, xtreamCfg);

      const stats = { live: playlist.live.count, movies: playlist.movies.count, series: playlist.series.count };
      send({ type: 'progress', message: `Atualizado! ${stats.live} canais, ${stats.movies} filmes, ${stats.series} séries`, percent: 100 });
      send({ type: 'done', stats });
      res.end();

    } else {
      send({ type: 'error', error: 'Tipo de fonte desconhecido' });
      res.end();
    }
  } catch (err) {
    send({ type: 'error', error: 'Falha ao atualizar: ' + err.message });
    res.end();
  }
});

app.get('/api/playlist', (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(`api:${ip}`, 60)) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  const { entry } = getSession(req);
  if (!entry || !entry.playlist) return res.status(404).json({ error: 'Nenhuma playlist carregada' });
  res.json(entry.playlist);
});

app.delete('/api/session', (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(`api:${ip}`, 60)) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  const sid = parseSid(req);
  if (sid) clearSession(sid);
  res.json({ success: true });
});

app.get('/api/series/:id', async (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(`api:${ip}`, 60)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Validate series ID is numeric only
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  const { entry } = getSession(req);
  if (!entry || !entry.xtreamConfig) return res.status(400).json({ error: 'Xtream Codes não configurado' });

  try {
    const { server, username, password } = entry.xtreamConfig;
    const base = `${server}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const info = await axios.get(`${base}&action=get_series_info&series_id=${encodeURIComponent(req.params.id)}`, { timeout: 15000 });

    const data = info.data;
    const seasons = {};

    if (data.episodes) {
      for (const [seasonNum, episodes] of Object.entries(data.episodes)) {
        seasons[seasonNum] = episodes.map(ep => ({
          name: ep.title || `Episódio ${ep.episode_num}`,
          episode: ep.episode_num,
          url: `${server}/series/${username}/${password}/${ep.id}.${ep.container_extension || 'mp4'}`,
          logo: ep.info?.movie_image || data.info?.cover || '',
          duration: ep.info?.duration || '',
        }));
      }
    }

    res.json({
      name: data.info?.name || 'Série',
      cover: data.info?.cover || '',
      seasons,
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao carregar série: ' + err.message });
  }
});

// ===================== STREAM PROXY =====================

function rewriteM3U8(content, originalUrl) {
  const base = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);
  const parsedOrig = new URL(originalUrl);
  const origin = parsedOrig.origin; // e.g. "http://server:port"

  function resolveUri(uri) {
    if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
    if (uri.startsWith('/')) return origin + uri; // absolute path → server origin
    return base + uri; // relative path → base directory
  }

  return content.split(/\r?\n/).map(line => {
    const trimmed = line.trim();

    // Rewrite URI= in tags (#EXT-X-KEY, etc.)
    if (trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
        return `URI="/api/proxy?url=${encodeURIComponent(resolveUri(uri))}"`;
      });
    }

    // Rewrite segment/playlist URLs
    if (trimmed && !trimmed.startsWith('#')) {
      return '/api/proxy?url=' + encodeURIComponent(resolveUri(trimmed));
    }

    return line;
  }).join('\n');
}

// CORS preflight for proxy
app.options('/api/proxy', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.status(204).end();
});

app.get('/api/proxy', (req, res) => {
  const ip = getClientIP(req);
  if (!checkRateLimit(`proxy:${ip}`, 600)) {
    return res.status(429).send('Too many requests');
  }

  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('URL required');

  const decodedUrl = decodeURIComponent(rawUrl);
  const parsedUrl = validateExternalUrl(decodedUrl);
  if (!parsedUrl) {
    return res.status(403).send('URL blocked');
  }

  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const urlLower = decodedUrl.toLowerCase();
  const isM3U8 = urlLower.includes('.m3u8') || urlLower.includes('type=m3u_plus');
  const isLive = urlLower.includes('/live/') || urlLower.includes('.ts');

  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Connection': 'keep-alive',
    'Accept-Encoding': isM3U8 ? 'gzip, deflate, identity' : 'identity',
  };

  // Forward Range header for VOD seeking
  if (req.headers.range) {
    upstreamHeaders['Range'] = req.headers.range;
  }

  const connTimeout = isM3U8 ? 20000 : isLive ? 30000 : 30000;
  const requestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: upstreamHeaders,
    agent: isHttps ? httpsAgent : httpAgent,
    timeout: connTimeout,
  };

  const upstreamReq = transport.request(requestOptions, (upstreamRes) => {
    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode)) {
      const location = upstreamRes.headers.location;
      upstreamRes.resume();
      if (location) {
        const redirectUrl = location.startsWith('http')
          ? location
          : `${parsedUrl.protocol}//${parsedUrl.host}${location}`;
        if (!validateExternalUrl(redirectUrl)) {
          return res.status(403).send('Redirect to blocked URL');
        }
        return res.redirect(307, '/api/proxy?url=' + encodeURIComponent(redirectUrl));
      }
      return res.status(502).send('Redirect without location');
    }

    const ct = upstreamRes.headers['content-type'] || '';

    // M3U8: buffer entirely, rewrite, send
    if (isM3U8 || ct.includes('mpegurl')) {
      // Decompress if needed
      const encoding = upstreamRes.headers['content-encoding'];
      let stream = upstreamRes;
      if (encoding === 'gzip') stream = upstreamRes.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = upstreamRes.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        console.log('[PROXY] M3U8 response:', body.substring(0, 200).replace(/\n/g, '\\n'));
        const rewritten = rewriteM3U8(body, decodedUrl);
        res.set({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
          'Cache-Control': 'no-cache',
        });
        res.send(rewritten);
      });
      stream.on('error', (err) => {
        console.error('[PROXY] M3U8 stream error:', err.message);
        if (!res.headersSent) res.status(502).send('Upstream error');
      });
      return;
    }

    // Build response headers
    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type',
    };

    if (ct) responseHeaders['Content-Type'] = ct;

    if (upstreamRes.statusCode === 206) {
      // Upstream supports range — forward 206 with range headers
      if (upstreamRes.headers['content-range']) responseHeaders['Content-Range'] = upstreamRes.headers['content-range'];
      if (upstreamRes.headers['content-length']) responseHeaders['Content-Length'] = upstreamRes.headers['content-length'];
      responseHeaders['Accept-Ranges'] = 'bytes';
      res.writeHead(206, responseHeaders);
    } else if (upstreamRes.headers['content-length'] && !isLive) {
      // VOD with known length — advertise range support
      responseHeaders['Content-Length'] = upstreamRes.headers['content-length'];
      responseHeaders['Accept-Ranges'] = 'bytes';
      res.writeHead(200, responseHeaders);
    } else {
      // Live stream or unknown length — chunked encoding
      responseHeaders['Cache-Control'] = 'no-cache, no-store';
      res.writeHead(200, responseHeaders);
    }

    // Pipe upstream to client
    upstreamRes.pipe(res);

    upstreamRes.on('error', (err) => {
      console.error('[PROXY] Stream error:', err.message);
      if (!res.writableEnded) res.end();
    });

    // Cleanup when client disconnects
    req.on('close', () => {
      upstreamRes.destroy();
    });
  });

  upstreamReq.on('timeout', () => {
    console.error('[PROXY] Connection timeout:', decodedUrl.substring(0, 80));
    upstreamReq.destroy();
    if (!res.headersSent) res.status(504).send('Gateway Timeout');
  });

  upstreamReq.on('error', (err) => {
    console.error('[PROXY] Request error:', err.message);
    if (!res.headersSent) res.status(502).send('Proxy error');
  });

  upstreamReq.end();
});

// ===================== START =====================

(() => {
  // Migrate legacy single-user session if it exists
  if (fs.existsSync(LEGACY_SESSION_FILE)) {
    try {
      const legacyData = JSON.parse(fs.readFileSync(LEGACY_SESSION_FILE, 'utf-8'));
      if (legacyData.playlist) {
        const migrateSid = crypto.randomUUID();
        console.log(`  Migrando sessão legada para ${migrateSid.substring(0, 8)}...`);
        saveSession(migrateSid, legacyData.source, legacyData.credentials, legacyData.playlist, legacyData.xtreamConfig || null);
        // Remove legacy file after successful migration
        fs.unlinkSync(LEGACY_SESSION_FILE);
        console.log('  Sessão legada migrada com sucesso');
      }
    } catch (err) {
      console.error('  Falha ao migrar sessão legada:', err.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`\n  CtoPlayer rodando em http://localhost:${PORT}\n`);
  });
})();
