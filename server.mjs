// Sparkx server: static files + art search proxy + image cache.
// Zero dependencies. Run locally: node server.mjs (or npm start).
// In production (radify) it is compiled to a single binary with Bun; STATIC_DIR / DATA_DIR / PORT come from env.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite'; // works in Node 22+ and in Bun

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(process.env.STATIC_DIR || path.join(ROOT, 'public'));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null; // set by radify in production
const CACHE_DIR = DATA_DIR ? path.join(DATA_DIR, 'cache') : path.join(ROOT, '.cache');
const DB_FILE = path.join(DATA_DIR || path.join(ROOT, '.data'), 'sparkx.db');
const IMG_DIR = path.join(CACHE_DIR, 'img');
const SEARCH_CACHE_FILE = path.join(CACHE_DIR, 'search-cache.json');
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000; // Pixabay asks for 24h caching of results

// --- tiny .env loader -------------------------------------------------------
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
const PORT = Number(process.env.PORT || 5178);
const PIXABAY_KEY = process.env.PIXABAY_KEY || '';

fs.mkdirSync(IMG_DIR, { recursive: true });
let searchCache = {};
try { searchCache = JSON.parse(fs.readFileSync(SEARCH_CACHE_FILE, 'utf8')); } catch {}
let saveTimer;
function persistSearchCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fsp.writeFile(SEARCH_CACHE_FILE, JSON.stringify(searchCache)).catch(() => {}), 1000);
}

// --- maps database (SQLite; radify backs up everything in $DATA_DIR) ----------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS saved_maps (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,      -- the signed-in email (X-Auth-Email), or 'local' when running on a laptop
    title      TEXT NOT NULL,
    data       TEXT NOT NULL,      -- the map as JSON
    thumb      TEXT,               -- small vector preview (JSON of boxes, lines and image urls)
    created_at INTEGER NOT NULL,   -- ms since epoch
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS saved_maps_owner ON saved_maps (owner, updated_at DESC);`);
// the first version kept one map per user in "maps"; it's not used any more
db.exec('DROP TABLE IF EXISTS maps');
const q = {
  list: db.prepare('SELECT id, title, thumb, created_at, updated_at FROM saved_maps WHERE owner = ? ORDER BY updated_at DESC'),
  get: db.prepare('SELECT id, title, data, created_at, updated_at FROM saved_maps WHERE id = ? AND owner = ?'),
  insert: db.prepare('INSERT INTO saved_maps (id, owner, title, data, thumb, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE saved_maps SET title = ?, data = ?, thumb = ?, updated_at = ? WHERE id = ? AND owner = ?'),
  del: db.prepare('DELETE FROM saved_maps WHERE id = ? AND owner = ?'),
};

// Who is this? Behind radify, Caddy sets X-Auth-Email after Google login (and strips any client-sent value).
// Locally there is no login, so everything belongs to 'local'.
function ownerOf(req) {
  const email = String(req.headers['x-auth-email'] || '').trim().toLowerCase();
  if (email) return email;
  return DATA_DIR ? null : 'local';
}

const MAX_BODY = 5 * 1024 * 1024;
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// body: { title, map, thumb }
async function readMapBody(req) {
  const d = JSON.parse(await readBody(req));
  if (!d?.map?.root?.id) throw Object.assign(new Error('not a Sparkx map'), { status: 400 });
  const title = String(d.title || d.map.title || '').trim().slice(0, 200) || 'Untitled map';
  const thumb = d.thumb ? JSON.stringify(d.thumb).slice(0, 200000) : null;
  return { title, data: JSON.stringify(d.map), thumb };
}

// /api/maps            GET list · POST create
// /api/maps/<id>       GET one · PUT update · DELETE
async function handleMaps(req, res, id) {
  const owner = ownerOf(req);
  if (!owner) return send(res, 401, 'not signed in');
  const m = req.method;
  if (!id && m === 'GET') {
    return json(res, q.list.all(owner).map((r) => ({
      id: r.id, title: r.title, thumb: r.thumb ? JSON.parse(r.thumb) : null, createdAt: r.created_at, updatedAt: r.updated_at,
    })));
  }
  if (!id && m === 'POST') {
    const b = await readMapBody(req);
    const now = Date.now();
    const newId = crypto.randomBytes(9).toString('base64url');
    q.insert.run(newId, owner, b.title, b.data, b.thumb, now, now);
    return json(res, { id: newId, createdAt: now, updatedAt: now });
  }
  if (id && m === 'GET') {
    const r = q.get.get(id, owner);
    if (!r) return send(res, 404, 'no such map');
    return json(res, { id: r.id, title: r.title, map: JSON.parse(r.data), createdAt: r.created_at, updatedAt: r.updated_at });
  }
  if (id && m === 'PUT') {
    const b = await readMapBody(req);
    const now = Date.now();
    if (!q.update.run(b.title, b.data, b.thumb, now, id, owner).changes) return send(res, 404, 'no such map');
    return json(res, { updatedAt: now });
  }
  if (id && m === 'DELETE') {
    if (!q.del.run(id, owner).changes) return send(res, 404, 'no such map');
    return json(res, { ok: true });
  }
  send(res, 405, 'method not allowed');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.json': 'application/json', '.ico': 'image/x-icon',
};

async function fetchJson(url, ms = 10000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'sparkx-local/0.1' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const proxied = (u) => '/api/img?u=' + encodeURIComponent(u);

async function searchPixabay(q, type) {
  const url = `https://pixabay.com/api/?key=${encodeURIComponent(PIXABAY_KEY)}&q=${encodeURIComponent(q)}` +
    `&image_type=${type}&safesearch=true&per_page=30&order=popular`;
  const d = await fetchJson(url);
  return (d.hits || []).map((h) => ({
    url: proxied(h.webformatURL),
    w: h.webformatWidth, h: h.webformatHeight,
    transparent: /\.png($|\?)/i.test(h.webformatURL),
    credit: `${h.user} on Pixabay`, link: h.pageURL, source: 'pixabay', kind: type,
  }));
}

async function searchOpenverse(q, category) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20` +
    (category ? `&category=${category}` : '');
  const d = await fetchJson(url, 7000);
  return (d.results || []).filter((r) => r.thumbnail).map((r) => ({
    url: proxied(r.thumbnail),
    w: r.width, h: r.height,
    transparent: /\.png($|\?)/i.test(r.url || ''),
    credit: `${r.creator || 'unknown'} (${(r.license || '').toUpperCase()}) via Openverse`,
    link: r.foreign_landing_url, source: 'openverse', kind: category || 'any',
  }));
}

// Wikimedia Commons "drawings" are SVGs (rendered to transparent PNG thumbs). Mixed quality, but fast and keyless.
async function searchCommons(q) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20' +
    `&gsrsearch=${encodeURIComponent(q + ' filetype:drawing')}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=360`;
  const d = await fetchJson(url, 8000);
  const junk = /\b(flag|coat of arms|emblem|logo|logomark|signature|maps?|charts?|diagram|graph|plot|seal|wappen|blason|locat\w*|localisation|relief|election|protocol|parties|population|distribution|constraint|circuit|statistics?|results|trips by|per person|percent|census|district|prefecture|municipal|route|subway|railway|timeline|family tree|wordmark|text)\b/i;
  return Object.values(d.query?.pages || {})
    .sort((a, b) => a.index - b.index)
    .filter((p) => p.imageinfo?.[0]?.thumburl && !junk.test(p.title))
    .map((p) => {
      const ii = p.imageinfo[0];
      const artist = (ii.extmetadata?.Artist?.value || 'unknown').replace(/<[^>]+>/g, '').trim().slice(0, 60);
      return {
        url: proxied(ii.thumburl), w: ii.thumbwidth, h: ii.thumbheight, transparent: true,
        credit: `${artist} via Wikimedia Commons`, link: ii.descriptionurl, source: 'commons', kind: 'vector',
      };
    });
}

// Try vector art first, then illustrations, then anything.
async function searchArt(q) {
  const key = (PIXABAY_KEY ? 'px:' : 'ov:') + q.toLowerCase();
  const hit = searchCache[key];
  if (hit && Date.now() - hit.t < SEARCH_TTL_MS) return { results: hit.results, failed: false };
  let results = [];
  let failed = false;
  const run = (fn) => fn().catch((e) => { failed = true; console.warn('art search failed:', q, e.message); return []; });
  if (PIXABAY_KEY) {
    for (const type of ['vector', 'illustration', 'all']) {
      results = results.concat(await run(() => searchPixabay(q, type)));
      if (results.length >= 6) break;
    }
  } else {
    // keyless: query both sources in parallel (Openverse is often slow)
    const [ov, wc] = await Promise.all([run(() => searchOpenverse(q, 'illustration')), run(() => searchCommons(q))]);
    results = [...wc, ...ov]; // Commons SVG renders first: reliable thumbs and closer to vector art
  }
  // only cache complete answers, so a flaky upstream gets retried later
  if (!failed || results.length >= 6) {
    searchCache[key] = { t: Date.now(), results };
    persistSearchCache();
  }
  return { results, failed };
}

const IMG_HOSTS = [/^(upload|thumb)\.wikimedia\.org$/, /(^|\.)pixabay\.com$/, /(^|\.)openverse\.org$/, /(^|\.)openverse\.engineering$/];
async function serveImage(res, u) {
  let parsed;
  try { parsed = new URL(u); } catch { return send(res, 400, 'bad url'); }
  if (parsed.protocol !== 'https:' || !IMG_HOSTS.some((re) => re.test(parsed.hostname))) return send(res, 403, 'host not allowed');
  const hash = crypto.createHash('sha1').update(u).digest('hex');
  const file = path.join(IMG_DIR, hash);
  try {
    const [buf, type] = await Promise.all([fsp.readFile(file), fsp.readFile(file + '.type', 'utf8')]);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(buf);
  } catch {}
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'sparkx-local/0.1' } });
    if (!r.ok) return send(res, 502, 'upstream ' + r.status);
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return send(res, 502, 'not an image');
    const buf = Buffer.from(await r.arrayBuffer());
    fsp.writeFile(file, buf).then(() => fsp.writeFile(file + '.type', type)).catch(() => {});
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(buf);
  } catch (e) {
    send(res, 504, 'image fetch failed');
  }
}

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}
const json = (res, obj) => send(res, 200, JSON.stringify(obj), 'application/json');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname === '/api/status') {
      return json(res, { pixabay: !!PIXABAY_KEY, source: PIXABAY_KEY ? 'Pixabay' : 'Openverse' });
    }
    if (url.pathname === '/api/art') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      if (!q) return json(res, { results: [] });
      return json(res, await searchArt(q));
    }
    const mm = url.pathname.match(/^\/api\/maps(?:\/([\w-]{1,40}))?\/?$/);
    if (mm) return await handleMaps(req, res, mm[1]);
    if (url.pathname === '/api/img') return serveImage(res, url.searchParams.get('u') || '');

    // static
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'not found');
    if (e instanceof SyntaxError) return send(res, 400, 'bad json');
    if (e.status) return send(res, e.status, e.message);
    console.error(e);
    send(res, 500, 'server error');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ⚠️  Port ${PORT} is already in use — Sparkx is probably already running at http://localhost:${PORT}`);
    console.error(`     Stop the other one, or run on another port:  PORT=5179 npm start\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ✨ Sparkx running at http://localhost:${PORT}`);
  console.log(`  🎨 Art source: ${PIXABAY_KEY ? 'Pixabay (vector-first)' : 'Openverse (no key) — add PIXABAY_KEY to .env for better vector art'}\n`);
});
