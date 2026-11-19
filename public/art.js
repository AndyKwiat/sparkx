// Background art fetching: colorful vector icons (Iconify) + illustrations (Pixabay / Openverse via local server).

const ICON_SETS = [
  'fluent-emoji-flat', 'noto', 'twemoji', 'openmoji', 'emojione', 'fxemoji', 'streamline-emojis',
  'fluent-color', 'streamline-color', 'icon-park', 'flat-color-icons', 'meteocons', 'noto-v1',
].join(',');

const STOP = new Set(`a an the and or but if then else of to in on at by for with from into onto over under about as is are was were be been
being it its this that these those i me my we our you your he she they them their his her what which who whom how why when where
not no yes do does did done can could should would will just very really more most less some any all each every other such than
too also get got make made new idea ideas thing things stuff lot lots etc vs via per way ways use using need needs want maybe`.split(/\s+/));

export function keywords(text) {
  const words = (text || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}
const singular = (w) => (w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.endsWith('ss') ? w : w.endsWith('s') ? w.slice(0, -1) : w);

function queriesFor(text) {
  const kw = keywords(text);
  if (!kw.length) return [];
  const qs = [];
  if (kw.length > 1) qs.push(kw.slice(0, 3).join(' '));
  for (const w of [...kw].sort((a, b) => b.length - a.length)) {
    qs.push(w);
    if (singular(w) !== w) qs.push(singular(w));
  }
  return [...new Set(qs)].slice(0, 5);
}

// --- caches ------------------------------------------------------------------
const iconCache = new Map();
const artCache = new Map();
let lastFailed = false;

async function searchIcons(q) {
  if (iconCache.has(q)) return iconCache.get(q);
  const p = fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=64&prefixes=${ICON_SETS}`)
    .then((r) => (r.ok ? r.json() : { icons: [] }))
    .then((d) => {
      const term = q.split(' ')[0];
      // rank: exact name match > starts with > contains
      const score = (id) => {
        const name = id.split(':')[1];
        return name === term ? 0 : name.startsWith(term) ? 1 : name.includes(term) ? 2 : 3;
      };
      return (d.icons || []).sort((a, b) => score(a) - score(b)).map((id) => {
        const [prefix, name] = id.split(':');
        return { url: `https://api.iconify.design/${prefix}/${name}.svg`, transparent: true, credit: `${prefix} icons via Iconify`, source: 'iconify', kind: 'icon' };
      });
    })
    .catch(() => []);
  iconCache.set(q, p);
  return p;
}

async function searchArt(q) {
  if (artCache.has(q)) return artCache.get(q);
  const p = fetch(`/api/art?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20000) })
    .then((r) => r.json())
    .then((d) => {
      if (d.failed) { artCache.delete(q); if (!d.results?.length) throw new Error('upstream failed'); }
      return d.results || [];
    })
    .catch(() => { artCache.delete(q); lastFailed = true; return []; });
  artCache.set(q, p);
  return p;
}

async function firstWith(queries, fn, min = 1) {
  for (const q of queries) {
    const r = await fn(q);
    if (r.length >= min) return r;
  }
  return [];
}

// --- queue: max N concurrent jobs so typing never waits on the network ---------
const MAX_CONCURRENT = 3;
let active = 0;
const queue = [];
const listeners = new Set();
export const onBusyChange = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn(active + queue.length));

function enqueue(job) {
  return new Promise((resolve) => {
    queue.push({ job, resolve });
    pump();
  });
}
function pump() {
  notify();
  while (active < MAX_CONCURRENT && queue.length) {
    const { job, resolve } = queue.shift();
    active++;
    job().then(resolve, (e) => { console.warn('art lookup failed:', e); resolve(null); }).finally(() => { active--; pump(); });
  }
}

// --- public API ----------------------------------------------------------------
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

const broken = new Set();
// pick an unused candidate (deterministic per text, random on reroll) that actually loads
async function pick(list, used, seed, avoid) {
  const ok = list.filter((a) => a.url !== avoid && !broken.has(a.url));
  const fresh = ok.filter((a) => !used.has(a.url));
  const pool = (fresh.length ? fresh : ok).slice(0, 10);
  for (let i = 0; i < Math.min(4, pool.length); i++) {
    const cand = pool[Math.abs(seed + i) % pool.length];
    if (await preload(cand.url)) return cand;
    broken.add(cand.url);
  }
  return null;
}

/**
 * Find art for a node.
 * opts: { depth, wantBackdrop, used:Set<url>, reroll:bool, current:{sticker,backdrop}, contextText }
 * resolves to { sticker, backdrop } (each may be null)
 */
export function findArt(text, opts) {
  return enqueue(async () => {
    let qs = queriesFor(text);
    if (!qs.length) return { sticker: null, backdrop: null };
    const seed = hash(text) + (opts.reroll ? Math.floor(Math.random() * 1000) : 0);

    lastFailed = false;
    const [icons, art] = await Promise.all([firstWith(qs, searchIcons), firstWith(qs, searchArt, 3)]);
    // stickers: shallow nodes prefer illustrations, deep nodes prefer crisp icons; fall back to the other.
    const preferIcon = opts.depth >= 2 ? seed % 4 !== 0 : seed % 4 === 0;
    const stickerPool = preferIcon ? (icons.length ? icons : art) : (art.length ? art : icons);
    const sticker = await pick(stickerPool, opts.used, seed, opts.current?.sticker?.url);
    let backdrop = null;
    if (opts.wantBackdrop) {
      const used = new Set(opts.used);
      if (sticker) used.add(sticker.url);
      backdrop = await pick(art.length ? art : icons, used, seed >>> 3, opts.current?.backdrop?.url);
    }
    // nothing found because the network failed (not because there is no art): let the app retry later
    if (!sticker && !backdrop && lastFailed) return null;
    return { sticker, backdrop };
  });
}

// warm the browser cache so images appear fully formed; resolves false if the image is broken
function preload(url) {
  return new Promise((res) => {
    const img = new Image();
    const t = setTimeout(() => res(false), 15000);
    img.onload = () => { clearTimeout(t); res(img.naturalWidth > 0); };
    img.onerror = () => { clearTimeout(t); res(false); };
    img.src = url;
  });
}

export async function artStatus() {
  try { return await (await fetch('/api/status')).json(); } catch { return { pixabay: false, source: 'offline' }; }
}
