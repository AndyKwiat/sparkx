import { layoutTree } from './layout.js';
import { findArt, keywords, onBusyChange, artStatus } from './art.js';

// ---------------------------------------------------------------------------
// Desktop gate
// ---------------------------------------------------------------------------
const isMobile = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
if (isMobile) document.body.classList.add('mobile');

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------
const PALETTE = ['#ff5d73', '#ff9f1c', '#f7c22b', '#2ec4b6', '#3a86ff', '#8338ec', '#ff4fb4', '#2bb673', '#fb5607', '#00b4d8'];
const LAST_KEY = 'sparkx.lastMap'; // id of the last saved map this browser had open
const PREFS_KEY = 'sparkx.prefs.v1';

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const world = $('#world');
const nodesLayer = $('#nodes');
const edgesLayer = $('#edges');
const bdLayer = $('#backdrops');
const SVGNS = 'http://www.w3.org/2000/svg';

let uid = Date.now() % 1e6;
const newId = () => 'n' + (uid++).toString(36) + Math.random().toString(36).slice(2, 5);
const node = (text, extra = {}) => ({ id: newId(), text, children: [], ...extra });

function demoMap() {
  const kid = (text, side, color, children = []) => ({ ...node(text), side, color, children });
  return {
    title: 'My first Sparkx map',
    root: {
      ...node('Trip to Japan'),
      children: [
        kid('Tokyo', 'R', 0, [node('Sushi'), node('Ramen')]),
        kid('Temples', 'R', 1, [node('Kyoto')]),
        kid('Mount Fuji', 'L', 2, [node('Hiking'), node('Camera')]),
        kid('Budget', 'L', 3, [node('Train pass')]),
      ],
    },
  };
}

// Maps live in the server's SQLite database, many per signed-in user. A map is only stored once you hit Save;
// from then on every change autosaves. `doc` is the open map's server identity (id null = not saved yet).
let map = demoMap();
let doc = { id: null, createdAt: null, updatedAt: null };
try {
  const last = localStorage.getItem(LAST_KEY);
  if (last) {
    const d = await api('GET', '/api/maps/' + encodeURIComponent(last));
    map = d.map;
    doc = { id: d.id, createdAt: d.createdAt, updatedAt: d.updatedAt };
  }
} catch { try { localStorage.removeItem(LAST_KEY); } catch {} }
let prefs = { stickers: true, backdrops: true, density: 'medium', ...safeJson(localStorage.getItem(PREFS_KEY)) };
let selectedId = map.root.id;
let editing = null; // { id, original, isNew, snapshot }
const undoStack = [];
const redoStack = [];

// index (rebuilt each render)
let index = new Map(); // id -> { node, parent, depth, color }

// DOM bookkeeping
const els = new Map(); // id -> element record
let targets = new Map(); // id -> {x,y,dir}
const cam = { x: 0, y: 0, z: 1 };
const camT = { x: 0, y: 0, z: 1 };
let drag = null;
let animating = false;
let lastT = 0;

function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
async function api(method, url, body, opts = {}) {
  const r = await fetch(url, {
    method, signal: AbortSignal.timeout(15000), ...opts,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || 'HTTP ' + r.status);
  return r.json();
}

// save() is called after every change. It only reaches the server once the map has been saved with the Save button.
let saveTimer = null;
let saveChain = Promise.resolve();
function save() {
  if (!doc.id) return;
  clearTimeout(saveTimer);
  setSaveState('saving');
  saveTimer = setTimeout(flushSave, 800);
}
function flushSave(leaving = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const id = doc.id;
  if (!id) return saveChain;
  const body = JSON.stringify({ title: map.title, map, thumb: makeThumb() });
  // chain the requests so an older save can never land after a newer one
  saveChain = saveChain.then(() =>
    fetch('/api/maps/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: leaving && body.length < 60000 })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((d) => { if (doc.id === id) doc.updatedAt = d.updatedAt; if (!saveTimer) setSaveState('saved'); })
      .catch((e) => { console.warn('save failed:', e); setSaveState('failed'); }));
  return saveChain;
}
function setSaveState(s = doc.id ? 'saved' : 'unsaved') {
  const el = document.getElementById('saveState');
  if (!el) return;
  el.textContent = { unsaved: 'not saved', saving: 'saving…', saved: '✓ saved', failed: '⚠ not saved — offline?' }[s];
  el.title = s === 'unsaved' ? 'This map only exists in this tab. Hit Save to keep it.' : 'Saved on the server; changes save automatically';
  el.className = s;
}
// an unsaved map counts as worth keeping once you've edited it
const hasUnsavedWork = () => !doc.id && undoStack.length > 0;
addEventListener('beforeunload', (e) => {
  if (saveTimer) flushSave(true);
  if (hasUnsavedWork()) e.preventDefault();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flushSave(true); });

const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------
function rebuildIndex() {
  index = new Map();
  const walk = (n, parent, depth, color) => {
    const c = depth === 1 ? (n.color ?? 0) : color;
    index.set(n.id, { node: n, parent, depth, color: c });
    n.children.forEach((k) => walk(k, n, depth + 1, c));
  };
  walk(map.root, null, 0, null);
}
const info = (id) => index.get(id);
const get = (id) => index.get(id)?.node;

function countDesc(n) { return n.children.reduce((a, k) => a + 1 + countDesc(k), 0); }
function isAncestor(a, b) { // is a an ancestor-or-self of b?
  for (let cur = info(b); cur; cur = cur.parent ? info(cur.parent.id) : null) if (cur.node.id === a) return true;
  return false;
}
function nextColor() {
  const used = map.root.children.map((c) => c.color);
  for (let i = 0; i < PALETTE.length; i++) if (!used.includes(i)) return i;
  return map.root.children.length % PALETTE.length;
}
function balancedSide() {
  let r = 0, l = 0;
  for (const c of map.root.children) (c.side === 'L' ? (l += 1 + countDesc(c)) : (r += 1 + countDesc(c)));
  return l < r ? 'L' : 'R';
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
const snap = () => JSON.stringify({ map, selectedId });
function pushUndo(s = snap()) {
  undoStack.push(s);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
function restore(s) {
  const d = JSON.parse(s);
  map = d.map;
  rebuildIndex();
  selectedId = get(d.selectedId) ? d.selectedId : map.root.id;
  $('#title').value = map.title || '';
  render();
  save();
}
function undo() { if (editing) commitEdit(); if (undoStack.length) { redoStack.push(snap()); restore(undoStack.pop()); } }
function redo() { if (redoStack.length) { undoStack.push(snap()); restore(redoStack.pop()); } }

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function addChild(parentId = selectedId) {
  const p = get(parentId);
  if (!p) return;
  const s = snap();
  p.collapsed = false;
  const n = node('');
  if (p === map.root) { n.side = balancedSide(); n.color = nextColor(); }
  p.children.push(n);
  selectedId = n.id;
  render();
  startEdit(n.id, 'replace', true, s);
}

function addSibling() {
  const inf = info(selectedId);
  if (!inf || !inf.parent) return addChild(selectedId);
  const s = snap();
  const p = inf.parent;
  const n = node('');
  if (p === map.root) { n.side = inf.node.side || 'R'; n.color = nextColor(); }
  p.children.splice(p.children.indexOf(inf.node) + 1, 0, n);
  selectedId = n.id;
  render();
  startEdit(n.id, 'replace', true, s);
}

function removeSelected() {
  const inf = info(selectedId);
  if (!inf || !inf.parent) return;
  pushUndo();
  const sibs = inf.parent.children;
  const i = sibs.indexOf(inf.node);
  sibs.splice(i, 1);
  // prefer a sibling on the same side, else parent
  const same = sibs.filter((k) => inf.parent !== map.root || (k.side || 'R') === (inf.node.side || 'R'));
  const next = same.find((k) => sibs.indexOf(k) >= i) || same[same.length - 1];
  selectedId = (next || inf.parent).id;
  render();
  save();
}

function toggleFold(id = selectedId) {
  const n = get(id);
  if (!n || !n.children.length) return;
  pushUndo();
  n.collapsed = !n.collapsed;
  render();
  save();
}

function reorder(delta) {
  const inf = info(selectedId);
  if (!inf || !inf.parent) return;
  const sibs = inf.parent.children;
  const sameSide = (k) => inf.parent !== map.root || (k.side || 'R') === (inf.node.side || 'R');
  const peers = sibs.filter(sameSide);
  const pi = peers.indexOf(inf.node);
  const swapWith = peers[pi + delta];
  if (!swapWith) return;
  pushUndo();
  const a = sibs.indexOf(inf.node), b = sibs.indexOf(swapWith);
  [sibs[a], sibs[b]] = [sibs[b], sibs[a]];
  render();
  save();
}

function select(id) {
  if (!get(id) || id === selectedId) return;
  selectedId = id;
  for (const [eid, el] of els) el.slot.classList.toggle('selected', eid === id);
  ensureVisible(id);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function navigate(key) {
  const cur = targets.get(selectedId);
  const inf = info(selectedId);
  if (!cur || !inf) return;
  const n = inf.node;
  const kidsOnSide = (dirSign) => {
    let kids = n.collapsed ? [] : n.children;
    if (n === map.root) kids = kids.filter((k) => (dirSign > 0 ? k.side !== 'L' : k.side === 'L'));
    return kids.map((k) => k.id).filter((id) => targets.has(id));
  };
  const nearestY = (ids) => ids.sort((a, b) => Math.abs(targets.get(a).y - cur.y) - Math.abs(targets.get(b).y - cur.y))[0];

  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const sign = key === 'ArrowRight' ? 1 : -1;
    if (n === map.root || cur.dir === sign) {
      if (n.collapsed && n.children.length) { toggleFold(n.id); return; }
      const id = nearestY(kidsOnSide(sign));
      if (id) select(id);
    } else if (inf.parent) select(inf.parent.id);
    return;
  }
  // up / down: closest node in that vertical direction, favouring same column
  const up = key === 'ArrowUp';
  let best = null, bestScore = Infinity;
  for (const [id, t] of targets) {
    if (id === selectedId) continue;
    const dy = up ? cur.y - t.y : t.y - cur.y;
    if (dy <= 4) continue;
    const sameParent = info(id)?.parent === inf.parent ? 0 : 1;
    const score = dy + Math.abs(t.x - cur.x) * 1.5 + sameParent * 60;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  if (best) select(best);
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------
function startEdit(id, mode = 'end', isNew = false, snapshot = snap(), initialText) {
  if (editing) commitEdit();
  const el = els.get(id);
  const n = get(id);
  if (!el || !n) return;
  selectedId = id;
  editing = { id, original: n.text, isNew, snapshot };
  el.slot.classList.add('editing', 'selected');
  const t = el.text;
  t.contentEditable = 'plaintext-only';
  if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
  if (mode === 'replace') t.textContent = initialText ?? '';
  t.focus();
  const range = document.createRange();
  range.selectNodeContents(t);
  if (mode !== 'select') range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  onEditInput();
  ensureVisible(id);
}

function onEditInput() {
  if (!editing) return;
  const el = els.get(editing.id);
  get(editing.id).text = el.text.innerText.replace(/\n$/, '');
  el.slot.classList.toggle('empty', !el.text.textContent);
  relayout();
}

function commitEdit() {
  if (!editing) return;
  const { id, original, isNew, snapshot } = editing;
  editing = null;
  const el = els.get(id);
  const n = get(id);
  if (el) { el.text.contentEditable = 'false'; el.slot.classList.remove('editing'); }
  if (!n) return render();
  const text = (el ? el.text.innerText : n.text).replace(/\s+$/g, '').replace(/^\s+/g, '');
  if (!text) {
    if (isNew) { removeNodeSilently(id); }
    else n.text = original;
    return render();
  }
  n.text = text;
  if (isNew || text !== original) { pushUndo(snapshot); save(); }
  render();
}

function cancelEdit() {
  if (!editing) return;
  const { id, original, isNew } = editing;
  editing = null;
  const el = els.get(id);
  if (el) { el.text.contentEditable = 'false'; el.slot.classList.remove('editing'); }
  if (isNew) removeNodeSilently(id);
  else if (get(id)) get(id).text = original;
  render();
}

function removeNodeSilently(id) {
  const inf = info(id);
  if (!inf?.parent) return;
  const sibs = inf.parent.children;
  const i = sibs.indexOf(inf.node);
  sibs.splice(i, 1);
  selectedId = (sibs[i - 1] || sibs[i] || inf.parent).id;
}

// ---------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------
const pendingArt = new Set();
const failedArt = new Set();
const idHash = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

function wantsBackdrop(n, depth) {
  if (!prefs.backdrops) return false;
  if (n.bd === false) return false;
  if (n.bd === true) return true;
  if (depth <= 1) return true;
  const h = idHash(n.id);
  if (prefs.density === 'high') return h % 5 !== 0;
  if (prefs.density === 'medium') return h % 3 === 0;
  return false;
}

function needsArt(n, depth) {
  if (!keywords(n.text).length) return false;
  if (!n.art || n.art.q !== n.text) return true;
  return wantsBackdrop(n, depth) && n.art.backdrop === undefined;
}

function usedUrls(exceptId) {
  const s = new Set();
  for (const [id, { node: n }] of index) {
    if (id === exceptId || !n.art) continue;
    if (n.art.sticker) s.add(n.art.sticker.url);
    if (n.art.backdrop) s.add(n.art.backdrop.url);
  }
  return s;
}

function requestArt(id, reroll = false) {
  const inf = info(id);
  if (!inf || pendingArt.has(id)) return;
  const n = inf.node;
  const text = n.text;
  const want = wantsBackdrop(n, inf.depth);
  pendingArt.add(id);
  els.get(id)?.slot.classList.add('art-loading');
  findArt(text, { depth: inf.depth, wantBackdrop: want, used: usedUrls(id), reroll, current: reroll ? n.art : null })
    .then((res) => {
      pendingArt.delete(id);
      els.get(id)?.slot.classList.remove('art-loading');
      const cur = get(id);
      if (!cur || cur.text !== text) return render();
      if (!res) { // network trouble: retry in a minute
        failedArt.add(id + text);
        setTimeout(() => { failedArt.delete(id + text); if (!editing) render(); }, 60000);
        return;
      }
      const keep = !reroll && cur.art?.q === text ? cur.art : null;
      cur.art = { q: text, sticker: res.sticker ?? keep?.sticker ?? null };
      if (want) cur.art.backdrop = res.backdrop ?? null;
      else if (keep?.backdrop) cur.art.backdrop = keep.backdrop;
      save();
      render();
    });
}

function reroll(id = selectedId) {
  const n = get(id);
  if (!n || !keywords(n.text).length) return flash('Type some words first — art is found from the text');
  pushUndo();
  requestArt(id, true);
}

function toggleBackdrop(id = selectedId) {
  const inf = info(id);
  if (!inf) return;
  pushUndo();
  const showing = wantsBackdrop(inf.node, inf.depth);
  inf.node.bd = !showing;
  if (!showing && !prefs.backdrops) { prefs.backdrops = true; savePrefs(); }
  save();
  render();
}

onBusyChange((n) => {
  $('#busy').hidden = n === 0;
  $('#busyText').textContent = n === 1 ? 'finding art…' : `finding art for ${n} ideas…`;
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const stickerSize = (depth) => (depth === 0 ? 104 : depth === 1 ? 70 : 52);
const backdropSize = (depth) => (depth === 0 ? 440 : depth === 1 ? 270 : 200);

function makeEl(n) {
  const slot = document.createElement('div');
  slot.className = 'node';
  slot.dataset.id = n.id;
  const card = document.createElement('div');
  card.className = 'card';
  const text = document.createElement('span');
  text.className = 'text';
  text.spellcheck = false;
  card.append(text);
  const fold = document.createElement('button');
  fold.className = 'fold';
  fold.tabIndex = -1;
  fold.addEventListener('pointerdown', (e) => { e.stopPropagation(); toggleFold(n.id); });
  const sticker = document.createElement('div');
  sticker.className = 'sticker';
  slot.append(sticker, card, fold);
  nodesLayer.append(slot);

  const edge = document.createElementNS(SVGNS, 'path');
  edge.setAttribute('class', 'edge');
  edgesLayer.append(edge);

  const bd = document.createElement('div');
  bd.className = 'backdrop';
  bdLayer.append(bd);

  text.addEventListener('input', onEditInput);
  text.addEventListener('keydown', onEditKey);
  text.addEventListener('blur', () => { if (editing?.id === n.id) commitEdit(); });
  text.addEventListener('paste', (e) => { // keep it plain
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  const rot = (idHash(n.id) % 19) - 9;
  return { slot, card, text, sticker, fold, edge, bd, x: NaN, y: NaN, w: 0, h: 0, rot, stickerUrl: null, bdUrl: null };
}

function render() {
  rebuildIndex();
  if (!get(selectedId)) selectedId = map.root.id;

  // visible set
  const visible = [];
  const walk = (n) => { visible.push(n.id); if (!n.collapsed) n.children.forEach(walk); };
  walk(map.root);
  const vis = new Set(visible);

  for (const [id, el] of els) {
    if (!vis.has(id)) { el.slot.remove(); el.edge.remove(); el.bd.remove(); els.delete(id); }
  }

  for (const id of visible) {
    const inf = info(id);
    const n = inf.node;
    let el = els.get(id);
    if (!el) { el = makeEl(n); els.set(id, el); }
    const color = inf.depth === 0 ? null : PALETTE[inf.color % PALETTE.length];
    el.depth = inf.depth;
    el.slot.className = 'node d' + Math.min(inf.depth, 2) +
      (id === selectedId ? ' selected' : '') + (editing?.id === id ? ' editing' : '') +
      (pendingArt.has(id) ? ' art-loading' : '') + (n.text ? '' : ' empty');
    if (color) { el.slot.style.setProperty('--c', color); el.bd.style.setProperty('--c', color); }
    if (editing?.id !== id && el.text.textContent !== n.text) el.text.textContent = n.text;

    // fold badge
    const hidden = n.collapsed ? countDesc(n) : 0;
    el.fold.hidden = !hidden;
    el.fold.textContent = hidden ? '+' + hidden : '';

    // sticker
    const st = prefs.stickers ? n.art?.sticker : null;
    const ss = stickerSize(inf.depth);
    el.ss = st ? ss : 0;
    if ((st?.url || null) !== el.stickerUrl) {
      el.stickerUrl = st?.url || null;
      el.sticker.replaceChildren();
      if (st) {
        const img = new Image();
        img.onerror = () => el.sticker.classList.add('broken');
        el.sticker.classList.remove('broken');
        img.src = st.url;
        img.alt = '';
        img.draggable = false;
        el.sticker.title = st.credit ? `Art: ${st.credit}` : '';
        el.sticker.classList.toggle('framed', !st.transparent);
        el.sticker.append(img);
        el.sticker.classList.remove('pop');
        void el.sticker.offsetWidth;
        el.sticker.classList.add('pop');
      }
    }
    el.sticker.style.width = el.sticker.style.height = ss + 'px';
    el.sticker.style.setProperty('--rot', el.rot + 'deg');
    el.sticker.hidden = !st;

    // backdrop
    const bdArt = wantsBackdrop(n, inf.depth) ? n.art?.backdrop : null;
    if ((bdArt?.url || null) !== el.bdUrl) {
      el.bdUrl = bdArt?.url || null;
      el.bd.replaceChildren();
      el.bd.classList.remove('show');
      if (bdArt) {
        const img = new Image();
        img.onerror = () => img.remove();
        img.src = bdArt.url;
        img.alt = '';
        el.bd.classList.toggle('opaque', !bdArt.transparent);
        el.bd.append(img);
        requestAnimationFrame(() => el.bd.classList.add('show'));
      }
    }
    el.bdSize = backdropSize(inf.depth);
    el.bd.classList.toggle('root', inf.depth === 0);

    // queue art in background
    if (editing?.id !== id && needsArt(n, inf.depth) && !failedArt.has(id + n.text)) requestArt(id);
  }
  relayout();
}

function relayout() {
  const sizes = new Map();
  for (const [id, el] of els) {
    el.w = el.card.offsetWidth;
    el.h = el.card.offsetHeight;
    const top = el.depth === 0 ? 0 : el.ss ? el.ss * 0.58 : 0;
    sizes.set(id, { w: el.w, h: el.h, top });
  }
  targets = layoutTree(map.root, sizes);
  for (const [id, el] of els) {
    const t = targets.get(id);
    if (!t) continue;
    el.dir = t.dir;
    // sticker sits on the outer-top corner (away from parent edge)
    const s = el.ss;
    const st = el.sticker.style;
    if (el.depth === 0) {
      st.left = `calc(50% - ${s / 2}px)`; st.right = ''; st.top = -s * 0.78 + 'px';
    } else if (t.dir < 0) {
      st.left = -s * 0.42 + 'px'; st.right = ''; st.top = -s * 0.8 + 'px';
    } else {
      st.left = ''; st.right = -s * 0.42 + 'px'; st.top = -s * 0.8 + 'px';
    }
    el.fold.classList.toggle('left', t.dir < 0);
    // new nodes grow out of their parent
    if (Number.isNaN(el.x)) {
      const p = info(id)?.parent;
      const pe = p && els.get(p.id);
      el.x = pe && !Number.isNaN(pe.x) ? pe.x : t.x;
      el.y = pe && !Number.isNaN(pe.y) ? pe.y : t.y;
    }
  }
  if (selectedId) ensureVisible(selectedId);
  kick();
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
function kick() {
  if (!animating) { animating = true; lastT = performance.now(); nextFrame(); }
}

// background tabs don't get animation frames: snap straight to the layout instead
const nextFrame = () => (document.hidden ? setTimeout(() => tick(performance.now()), 16) : requestAnimationFrame(tick));

function tick(now) {
  const dt = Math.min(50, now - lastT);
  lastT = now;
  const k = document.hidden ? 1 : 1 - Math.exp(-dt / 65);
  let moving = false;

  for (const [id, el] of els) {
    const t = targets.get(id);
    if (!t) continue;
    let tx = t.x, ty = t.y, kk = k;
    if (drag?.active && drag.ids.has(id)) { tx += drag.dx; ty += drag.dy; kk = id === drag.id ? 1 : Math.max(k, 0.5); }
    const dx = tx - el.x, dy = ty - el.y;
    if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) { el.x += dx * kk; el.y += dy * kk; moving = true; }
    else { el.x = tx; el.y = ty; }
    el.slot.style.transform = `translate(${el.x - el.w / 2}px, ${el.y - el.h / 2}px)`;

    const s = el.bdSize;
    const off = el.depth === 0 ? 0 : (el.dir || 1) * el.w * 0.22;
    el.bd.style.width = el.bd.style.height = s + 'px';
    el.bd.style.transform = `translate(${el.x + off - s / 2}px, ${el.y - s / 2 - 8}px)`;
  }

  // edges
  for (const [id, el] of els) {
    const p = info(id)?.parent;
    const pe = p && els.get(p.id);
    if (!pe) { el.edge.setAttribute('d', ''); continue; }
    const dir = el.dir || 1;
    const sx = pe.x + dir * (pe.depth === 0 ? pe.w * 0.32 : pe.w / 2 - 4);
    const sy = pe.y;
    const ex = el.x - dir * (el.w / 2 - 6);
    const ey = el.y;
    const mx = (sx + ex) / 2;
    el.edge.setAttribute('d', `M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}`);
    el.edge.style.stroke = el.slot.style.getPropertyValue('--c');
    el.edge.style.strokeWidth = el.depth === 1 ? 7 : el.depth === 2 ? 4 : 2.5;
  }

  // camera
  for (const key of ['x', 'y', 'z']) {
    const d = camT[key] - cam[key];
    if (Math.abs(d) > (key === 'z' ? 0.0005 : 0.25)) { cam[key] += d * k; moving = true; }
    else cam[key] = camT[key];
  }
  applyCam();

  if (moving || drag?.active) nextFrame();
  else animating = false;
}

function applyCam() {
  const r = stage.getBoundingClientRect();
  world.style.transform = `translate(${r.width / 2 + cam.x}px, ${r.height / 2 + cam.y}px) scale(${cam.z})`;
  stage.style.setProperty('--grid-x', (r.width / 2 + cam.x) + 'px');
  stage.style.setProperty('--grid-y', (r.height / 2 + cam.y) + 'px');
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
const toWorld = (cx, cy) => {
  const r = stage.getBoundingClientRect();
  return { x: (cx - r.left - r.width / 2 - cam.x) / cam.z, y: (cy - r.top - r.height / 2 - cam.y) / cam.z };
};

function ensureVisible(id) {
  const t = targets.get(id);
  const el = els.get(id);
  if (!t || !el) return;
  const r = stage.getBoundingClientRect();
  const m = 90;
  const halfW = (el.w / 2 + 40) * camT.z, halfH = (el.h / 2 + el.ss) * camT.z;
  const sx = r.width / 2 + camT.x + t.x * camT.z;
  const sy = r.height / 2 + camT.y + t.y * camT.z;
  if (sx - halfW < m) camT.x += m - (sx - halfW);
  if (sx + halfW > r.width - m) camT.x -= sx + halfW - (r.width - m);
  if (sy - halfH < m) camT.y += m - (sy - halfH);
  if (sy + halfH > r.height - m - 30) camT.y -= sy + halfH - (r.height - m - 30);
  kick();
}

function fit() {
  if (!targets.size) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [id, t] of targets) {
    const el = els.get(id);
    x0 = Math.min(x0, t.x - el.w / 2 - 30); x1 = Math.max(x1, t.x + el.w / 2 + 30);
    y0 = Math.min(y0, t.y - el.h / 2 - el.ss); y1 = Math.max(y1, t.y + el.h / 2 + 20);
  }
  const r = stage.getBoundingClientRect();
  const z = Math.max(0.25, Math.min(1.25, (r.width - 120) / (x1 - x0), (r.height - 140) / (y1 - y0)));
  camT.z = z;
  camT.x = -((x0 + x1) / 2) * z;
  camT.y = -((y0 + y1) / 2) * z;
  kick();
}

function zoomBy(f, cx, cy) {
  const r = stage.getBoundingClientRect();
  if (cx === undefined) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  const w = toWorld(cx, cy);
  const z = Math.max(0.2, Math.min(2.5, camT.z * f));
  camT.z = cam.z = z;
  camT.x = cam.x = cx - r.left - r.width / 2 - w.x * z;
  camT.y = cam.y = cy - r.top - r.height / 2 - w.y * z;
  applyCam();
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function onEditKey(e) {
  if (e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
  else if (e.key === 'Tab') {
    e.preventDefault();
    const id = editing?.id;
    commitEdit();
    if (get(id)) addChild(id); else addChild();
  } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  e.stopPropagation();
}

document.addEventListener('keydown', (e) => {
  if (editing || e.isComposing) return;
  const tgt = e.target;
  if (tgt.closest?.('dialog') || ['INPUT', 'SELECT', 'TEXTAREA'].includes(tgt.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveToServer(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.2); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
  if (mod && e.key === '0') { e.preventDefault(); fit(); return; }
  if (mod) return;

  if (e.altKey && e.code === 'KeyI') { e.preventDefault(); reroll(); return; }
  if (e.altKey && e.code === 'KeyB') { e.preventDefault(); toggleBackdrop(); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); reorder(e.key === 'ArrowUp' ? -1 : 1); return; }

  switch (e.key) {
    case 'Enter': e.preventDefault(); addSibling(); return;
    case 'Tab': e.preventDefault(); if (!e.shiftKey) addChild(); else if (info(selectedId)?.parent) select(info(selectedId).parent.id); return;
    case 'Delete': case 'Backspace': e.preventDefault(); removeSelected(); return;
    case ' ': case 'F2': e.preventDefault(); startEdit(selectedId, 'end'); return;
    case '/': e.preventDefault(); toggleFold(); return;
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': e.preventDefault(); navigate(e.key); return;
    case 'Escape': return;
  }
  if (e.key.length === 1 && !e.altKey) {
    e.preventDefault();
    startEdit(selectedId, 'replace', false, snap(), e.key);
  }
});

// ---------------------------------------------------------------------------
// Mouse: select, edit, drag-to-move, pan, zoom
// ---------------------------------------------------------------------------
let pan = null;

nodesLayer.addEventListener('dblclick', (e) => {
  const slot = e.target.closest('.node');
  if (slot && editing?.id !== slot.dataset.id) startEdit(slot.dataset.id, 'select');
});

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const slot = e.target.closest('.node');
  if (slot) {
    const id = slot.dataset.id;
    if (editing?.id === id) return; // let the caret move
    if (editing) commitEdit();
    e.preventDefault();
    select(id);
    if (id !== map.root.id) {
      const w = toWorld(e.clientX, e.clientY);
      drag = { id, sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y, active: false, dx: 0, dy: 0, ids: null, over: null };
    } else pan = { x: e.clientX, y: e.clientY };
  } else {
    if (editing) commitEdit();
    pan = { x: e.clientX, y: e.clientY };
    stage.classList.add('panning');
  }
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener('pointermove', (e) => {
  if (pan) {
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    pan = { x: e.clientX, y: e.clientY };
    cam.x = camT.x = cam.x + dx;
    cam.y = camT.y = cam.y + dy;
    applyCam();
    return;
  }
  if (!drag) return;
  if (!drag.active && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) {
    drag.active = true;
    drag.ids = new Set();
    const add = (n) => { drag.ids.add(n.id); if (!n.collapsed) n.children.forEach(add); };
    add(get(drag.id));
    for (const id of drag.ids) els.get(id)?.slot.classList.add('dragging');
    kick();
  }
  if (!drag.active) return;
  const w = toWorld(e.clientX, e.clientY);
  drag.dx = w.x - drag.wx;
  drag.dy = w.y - drag.wy;
  drag.wpos = w;
  // drop target = node card under the pointer
  let over = null;
  for (const [id, t] of targets) {
    if (drag.ids.has(id)) continue;
    const el = els.get(id);
    if (Math.abs(w.x - t.x) < el.w / 2 + 8 && Math.abs(w.y - t.y) < el.h / 2 + 8) { over = id; break; }
  }
  if (over !== drag.over) {
    if (drag.over) els.get(drag.over)?.slot.classList.remove('drop-target');
    if (over) els.get(over)?.slot.classList.add('drop-target');
    drag.over = over;
  }
});

stage.addEventListener('pointerup', () => {
  stage.classList.remove('panning');
  pan = null;
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.active) return;
  for (const id of d.ids) els.get(id)?.slot.classList.remove('dragging');
  if (d.over) els.get(d.over)?.slot.classList.remove('drop-target');
  const inf = info(d.id);
  const n = inf.node;
  pushUndo();
  if (d.over && !isAncestor(d.id, d.over)) {
    const target = get(d.over);
    inf.parent.children.splice(inf.parent.children.indexOf(n), 1);
    if (target === map.root) { n.side = d.wpos.x < 0 ? 'L' : 'R'; n.color = n.color ?? nextColor(); }
    else { delete n.side; delete n.color; }
    target.collapsed = false;
    target.children.push(n);
  } else {
    // dropped on empty space: reorder among siblings (and switch side for main branches)
    const p = inf.parent;
    const sibs = p.children;
    sibs.splice(sibs.indexOf(n), 1);
    if (p === map.root) n.side = d.wpos.x < 0 ? 'L' : 'R';
    const peers = sibs.filter((k) => p !== map.root || (k.side || 'R') === (n.side || 'R'));
    const before = peers.find((k) => (targets.get(k.id)?.y ?? Infinity) > d.wpos.y);
    if (before) sibs.splice(sibs.indexOf(before), 0, n);
    else sibs.push(n);
  }
  save();
  render();
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  else {
    cam.x = camT.x = cam.x - e.deltaX;
    cam.y = camT.y = cam.y - e.deltaY;
    applyCam();
  }
}, { passive: false });

window.addEventListener('resize', applyCam);

// ---------------------------------------------------------------------------
// Toolbar, dialogs, import/export
// ---------------------------------------------------------------------------
let flashTimer;
function flash(msg) {
  const b = $('#busy');
  $('#busyText').textContent = msg;
  b.hidden = false;
  b.classList.add('msg');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { b.hidden = true; b.classList.remove('msg'); }, 2200);
}

// ---- server maps: save, name prompt, open --------------------------------------
const needsName = (t) => !t || /^untitled\b/i.test(t.trim());

function askName() {
  const dlg = $('#nameDlg');
  const input = $('#nameInput');
  const rootText = map.root.text.trim();
  input.value = needsName(map.title) ? (rootText && rootText !== 'Central idea' ? rootText : '') : map.title;
  input.setCustomValidity('');
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null), { once: true });
  });
}
$('#nameCancel').addEventListener('click', () => $('#nameDlg').close('cancel'));
$('#nameInput').addEventListener('input', (e) => {
  e.target.setCustomValidity(needsName(e.target.value) ? 'Give your map a real name' : '');
});

async function saveToServer() {
  if (editing) commitEdit();
  if (doc.id) { await flushSave(); flash('Saved'); return; }
  if (needsName(map.title)) {
    const name = await askName();
    if (!name) return;
    map.title = name;
    titleInput.value = name;
  }
  setSaveState('saving');
  try {
    const d = await api('POST', '/api/maps', { title: map.title, map, thumb: makeThumb() });
    doc = { id: d.id, createdAt: d.createdAt, updatedAt: d.updatedAt };
    try { localStorage.setItem(LAST_KEY, d.id); } catch {}
    setSaveState('saved');
    flash('Saved — changes now save automatically');
  } catch (e) {
    setSaveState('unsaved');
    alert('Could not save: ' + e.message);
  }
}

async function confirmLeave() {
  if (editing) commitEdit();
  if (hasUnsavedWork() && !confirm('This map isn\'t saved yet. Discard it?')) return false;
  if (saveTimer) await flushSave();
  return true;
}

// swap in another map (from the server, or a fresh unsaved one)
function loadDoc(m, d) {
  map = m;
  doc = d;
  undoStack.length = redoStack.length = 0;
  failedArt.clear();
  selectedId = map.root.id;
  titleInput.value = map.title || '';
  try { d.id ? localStorage.setItem(LAST_KEY, d.id) : localStorage.removeItem(LAST_KEY); } catch {}
  setSaveState();
  resetView();
}

async function openMap(id) {
  if (id === doc.id) return $('#openDlg').close();
  if (!(await confirmLeave())) return;
  try {
    const d = await api('GET', '/api/maps/' + id);
    $('#openDlg').close();
    loadDoc(d.map, { id: d.id, createdAt: d.createdAt, updatedAt: d.updatedAt });
  } catch (e) { alert('Could not open that map: ' + e.message); }
}

const fmtDate = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function relTime(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

async function showOpenDialog() {
  if (editing) commitEdit();
  if (saveTimer) flushSave();
  const list = $('#mapList');
  list.innerHTML = '<p class="empty">Loading your maps…</p>';
  $('#openDlg').showModal();
  let maps;
  try { maps = await api('GET', '/api/maps'); } catch (e) {
    list.innerHTML = '';
    list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Could not load your maps: ' + e.message }));
    return;
  }
  list.replaceChildren();
  if (!maps.length) {
    list.innerHTML = '<p class="empty">No saved maps yet. Hit <b>💾 Save</b> to keep the one you\'re working on.</p>';
    return;
  }
  for (const m of maps) {
    const card = document.createElement('div');
    card.className = 'map-card' + (m.id === doc.id ? ' current' : '');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open-map';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (m.thumb) thumb.append(thumbSvg(m.thumb));
    const title = Object.assign(document.createElement('div'), { className: 'map-title', textContent: m.title });
    const dates = document.createElement('div');
    dates.className = 'map-dates';
    const created = Object.assign(document.createElement('span'), { textContent: 'Created ' + new Date(m.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }), title: fmtDate(m.createdAt) });
    const modified = Object.assign(document.createElement('span'), { textContent: 'Modified ' + relTime(m.updatedAt), title: fmtDate(m.updatedAt) });
    dates.append(created, modified);
    open.append(thumb, title, dates);
    open.addEventListener('click', () => openMap(m.id));
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'del', textContent: '🗑', title: 'Delete this map' });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${m.title}"? This can't be undone.`)) return;
      try {
        await api('DELETE', '/api/maps/' + m.id);
        card.remove();
        if (m.id === doc.id) { clearTimeout(saveTimer); saveTimer = null; doc = { id: null, createdAt: null, updatedAt: null }; try { localStorage.removeItem(LAST_KEY); } catch {} setSaveState(); }
        if (!list.children.length) showOpenDialog();
      } catch (e) { alert('Could not delete: ' + e.message); }
    });
    card.append(open, del);
    list.append(card);
  }
}

// ---- thumbnails: a tiny vector sketch of the laid-out map (boxes, branches, art) ----
const THUMB_W = 320, THUMB_H = 200;
function makeThumb() {
  const items = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (l, t, r, b) => { x0 = Math.min(x0, l); y0 = Math.min(y0, t); x1 = Math.max(x1, r); y1 = Math.max(y1, b); };
  for (const [id, el] of els) {
    const t = targets.get(id);
    if (!t || !el.w) continue;
    items.push({ id, el, x: t.x, y: t.y, dir: t.dir || 1 });
    grow(t.x - el.w / 2, t.y - el.h / 2 - (el.ss || 0) * 0.8, t.x + el.w / 2, t.y + el.h / 2);
  }
  if (!items.length) return null;
  const pad = 10;
  const k = Math.min((THUMB_W - pad * 2) / (x1 - x0), (THUMB_H - pad * 2) / (y1 - y0), 0.6);
  const ox = (THUMB_W - (x1 - x0) * k) / 2, oy = (THUMB_H - (y1 - y0) * k) / 2;
  const X = (x) => Math.round(((x - x0) * k + ox) * 10) / 10;
  const Y = (y) => Math.round(((y - y0) * k + oy) * 10) / 10;
  const S = (v) => Math.round(v * k * 10) / 10;
  const byId = new Map(items.map((i) => [i.id, i]));
  const okUrl = (u) => typeof u === 'string' && (u.startsWith('/api/img?') || u.startsWith('https://'));
  const th = { w: THUMB_W, h: THUMB_H, b: [], e: [], n: [], s: [] };
  for (const { id, el, x, y, dir } of items) {
    const color = el.depth === 0 ? '#8338ec' : el.slot.style.getPropertyValue('--c') || '#8338ec';
    if (el.bdUrl && el.depth <= 1 && okUrl(el.bdUrl)) {
      const s = el.bdSize * 0.8;
      const off = el.depth === 0 ? 0 : dir * el.w * 0.22;
      th.b.push([el.bdUrl, X(x + off - s / 2), Y(y - s / 2), S(s)]);
    }
    const p = info(id)?.parent;
    const pi = p && byId.get(p.id);
    if (pi) {
      const sx = pi.x + dir * (pi.el.depth === 0 ? pi.el.w * 0.32 : pi.el.w / 2 - 4);
      const ex = x - dir * (el.w / 2 - 6);
      th.e.push([X(sx), Y(pi.y), X(ex), Y(y), color, el.depth === 1 ? 2.5 : 1.5]);
    }
    th.n.push([X(x - el.w / 2), Y(y - el.h / 2), S(el.w), S(el.h), color, el.depth, (info(id)?.node.text || '').slice(0, 40)]);
    if (el.stickerUrl && el.ss && th.s.length < 30 && okUrl(el.stickerUrl)) {
      const s = el.ss;
      const left = el.depth === 0 ? x - s / 2 : dir < 0 ? x - el.w / 2 - s * 0.42 : x + el.w / 2 + s * 0.42 - s;
      th.s.push([el.stickerUrl, X(left), Y(y - el.h / 2 - s * 0.8), S(s)]);
    }
  }
  return th;
}

function thumbSvg(th) {
  const mk = (tag, attrs) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const svg = mk('svg', { viewBox: `0 0 ${th.w} ${th.h}`, preserveAspectRatio: 'xMidYMid meet' });
  const img = ([href, x, y, s], extra = {}) => {
    if (typeof href !== 'string' || !(href.startsWith('/api/img?') || href.startsWith('https://'))) return;
    svg.append(mk('image', { href, x, y, width: s, height: s, preserveAspectRatio: 'xMidYMid meet', ...extra }));
  };
  for (const b of th.b || []) img(b, { opacity: 0.22 });
  for (const [sx, sy, ex, ey, c, w] of th.e || []) {
    const mx = (sx + ex) / 2;
    svg.append(mk('path', { d: `M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}`, fill: 'none', stroke: c, 'stroke-width': w, 'stroke-linecap': 'round' }));
  }
  for (const [x, y, w, h, c, depth, label] of th.n || []) {
    svg.append(mk('rect', {
      x, y, width: w, height: h, rx: Math.min(h / 2, depth === 0 ? 8 : 5),
      fill: depth <= 1 ? c : '#fff', stroke: c, 'stroke-width': depth <= 1 ? 0 : 1,
    }));
    const text = String(label || '').split('\n')[0];
    const size = Math.min(h * 0.5, (w * 0.9) / Math.max(1, text.length * 0.56));
    if (text && size >= 3) {
      const t = mk('text', {
        x: x + w / 2, y: y + h / 2, 'font-size': size.toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-family': depth === 0 ? 'Fredoka, sans-serif' : 'Nunito, sans-serif', 'font-weight': 700,
        fill: depth <= 1 ? '#fff' : '#2a2350',
      });
      t.textContent = text;
      svg.append(t);
    }
  }
  for (const s of th.s || []) img(s);
  return svg;
}

function resetView() {
  for (const el of els.values()) { el.slot.remove(); el.edge.remove(); el.bd.remove(); }
  els.clear();
  render();
  requestAnimationFrame(fit);
}

const commands = {
  async new() {
    if (!(await confirmLeave())) return;
    loadDoc({ title: 'Untitled map', root: node('Central idea') }, { id: null, createdAt: null, updatedAt: null });
    camT.x = camT.y = 0; camT.z = 1;
    requestAnimationFrame(() => startEdit(map.root.id, 'select'));
    flash('New map — hit Save when you want to keep it');
  },
  open: showOpenDialog,
  save: saveToServer,
  undo, redo, fit,
  zoomIn: () => zoomBy(1.2),
  zoomOut: () => zoomBy(1 / 1.2),
  reroll: () => reroll(),
  help: () => $('#helpDlg').showModal(),
  async settings() {
    $('#prefStickers').checked = prefs.stickers;
    $('#prefBackdrops').checked = prefs.backdrops;
    $('#prefDensity').value = prefs.density;
    const st = await artStatus();
    $('#sourceStatus').innerHTML = st.pixabay
      ? '✅ Using <b>Pixabay</b> (vector art first) + colorful Iconify icons.'
      : '⚠️ No Pixabay key — using <b>Openverse</b> illustrations + Iconify icons. A free Pixabay key gives much better vector art.';
    $('#keyHelp').open = !st.pixabay;
    $('#settingsDlg').showModal();
  },
};
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', (e) => {
  e.currentTarget.blur();
  commands[b.dataset.cmd]();
}));

for (const [elId, key] of [['#prefStickers', 'stickers'], ['#prefBackdrops', 'backdrops'], ['#prefDensity', 'density']]) {
  $(elId).addEventListener('change', (e) => {
    prefs[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    savePrefs();
    render();
  });
}
$('#refreshAll').addEventListener('click', () => {
  pushUndo();
  failedArt.clear();
  for (const { node: n } of index.values()) delete n.art;
  save();
  render();
  $('#settingsDlg').close();
});

const titleInput = $('#title');
titleInput.value = map.title || '';
setSaveState();
titleInput.addEventListener('input', () => { map.title = titleInput.value; save(); });
titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') titleInput.blur(); });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.fonts.ready.then(() => {
  render();
  requestAnimationFrame(() => { fit(); cam.x = camT.x; cam.y = camT.y; cam.z = camT.z; applyCam(); });
});
render();
artStatus().then((st) => {
  if (!st.pixabay && !localStorage.getItem('sparkx.keyhint')) {
    localStorage.setItem('sparkx.keyhint', '1');
    flash('Tip: add a free Pixabay key for better vector art (🎨 menu)');
  }
});
