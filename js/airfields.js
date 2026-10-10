import { CONFIG } from './config.js';
import * as store from './store.js';

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const nameInput = document.getElementById('name');
const statusEl = document.getElementById('status');
const undoBtn = document.getElementById('undo');
const clearBtn = document.getElementById('clear');
const saveBtn = document.getElementById('save');
const newBtn = document.getElementById('new');
const listEl = document.getElementById('list');
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');

const TILE = CONFIG.tileSize;
const MAX_Z = CONFIG.mapMaxZoom;
const MIN_Z = CONFIG.mapMinZoom;

// Center of Ireland as the initial view.
const state = {
  center: { lat: 53.4, lon: -8.0 },
  zoom: 7,
  capture: { pattern: [], thresholds: [] },
  airfields: store.getAirfields(),
  targetId: store.getTarget(),
};

let W = 0;
let H = 0;
let needDraw = false;
const tileCache = new Map();

/* ------------------------------------------------ slippy-map conversions */

function lonToWorldX(lon, z) {
  return ((lon + 180) / 360) * TILE * 2 ** z;
}
function latToWorldY(lat, z) {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
}
function worldXToLon(x, z) {
  return (x / (TILE * 2 ** z)) * 360 - 180;
}
function worldYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
  return (Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180) / Math.PI;
}

function view() {
  const z = state.zoom;
  const cx = lonToWorldX(state.center.lon, z);
  const cy = latToWorldY(state.center.lat, z);
  return { z, left: cx - W / 2, top: cy - H / 2 };
}

function latLonToScreen(lat, lon) {
  const v = view();
  return {
    x: lonToWorldX(lon, v.z) - v.left,
    y: latToWorldY(lat, v.z) - v.top,
  };
}

function screenToLatLon(sx, sy) {
  const v = view();
  return {
    lat: worldYToLat(v.top + sy, v.z),
    lon: worldXToLon(v.left + sx, v.z),
  };
}

/* ------------------------------------------------------------- tile layer */

function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let img = tileCache.get(key);
  if (img) return img;
  img = new Image();
  img.onload = () => scheduleDraw();
  img.onerror = () => {};
  img.src = CONFIG.tileUrl(z, x, y);
  tileCache.set(key, img);
  return img;
}

function drawTiles() {
  const v = view();
  const n = 2 ** v.z;
  const x0 = Math.floor(v.left / TILE);
  const x1 = Math.floor((v.left + W) / TILE);
  const y0 = Math.floor(v.top / TILE);
  const y1 = Math.floor((v.top + H) / TILE);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue;
      const wx = ((x % n) + n) % n;
      const img = getTile(v.z, wx, y);
      if (img.complete && img.naturalWidth) {
        ctx.drawImage(img, x * TILE - v.left, y * TILE - v.top, TILE, TILE);
      }
    }
  }
}

/* ---------------------------------------------------------------- drawing */

function drawAirfield(af, highlight) {
  ctx.lineJoin = 'round';
  const pattern = af.pattern || [];
  if (pattern.length >= 2) {
    ctx.beginPath();
    pattern.forEach((p, i) => {
      const s = latLonToScreen(p.lat, p.lon);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.strokeStyle = highlight ? '#00e5ff' : '#ffffff';
    ctx.lineWidth = highlight ? 3 : 2;
    ctx.stroke();
  }
  const thr = af.thresholds || [];
  if (thr.length === 2) {
    const a = latLonToScreen(thr[0].lat, thr[0].lon);
    const b = latLonToScreen(thr[1].lat, thr[1].lon);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = highlight ? '#00e5ff' : '#ffffff';
    ctx.lineWidth = highlight ? 3 : 2;
    ctx.stroke();
  }
  if (pattern.length) {
    const c = centroid(pattern);
    const s = latLonToScreen(c.lat, c.lon);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = highlight ? '#00e5ff' : '#ffffff';
    ctx.fill();
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.strokeText(af.name, s.x + 9, s.y - 10);
    ctx.fillText(af.name, s.x + 9, s.y - 10);
  }
}

function drawCapture() {
  const order = ['pattern', 'thresholds'];
  const colors = { pattern: '#ffe000', thresholds: '#ff40ff' };
  const drawn = [];
  for (const kind of order) {
    const pts = state.capture[kind];
    for (const p of pts) drawn.push({ kind, p });
  }
  // Pattern outline as it is built.
  if (state.capture.pattern.length >= 2) {
    ctx.beginPath();
    state.capture.pattern.forEach((p, i) => {
      const s = latLonToScreen(p.lat, p.lon);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    if (state.capture.pattern.length === 4) ctx.closePath();
    ctx.strokeStyle = colors.pattern;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (state.capture.thresholds.length === 2) {
    const a = latLonToScreen(
      state.capture.thresholds[0].lat,
      state.capture.thresholds[0].lon
    );
    const b = latLonToScreen(
      state.capture.thresholds[1].lat,
      state.capture.thresholds[1].lon
    );
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = colors.thresholds;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  for (const { kind, p } of drawn) {
    const s = latLonToScreen(p.lat, p.lon);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = colors[kind];
    ctx.fill();
  }
}

function draw() {
  needDraw = false;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  drawTiles();
  for (const af of state.airfields) {
    drawAirfield(af, af.id === state.targetId);
  }
  drawCapture();
}

function scheduleDraw() {
  if (needDraw) return;
  needDraw = true;
  requestAnimationFrame(draw);
}

/* ------------------------------------------------------------------- input */

let dragging = false;
let lastX = 0;
let lastY = 0;
let moved = 0;
let pointerActive = false;

canvas.addEventListener('pointerdown', (e) => {
  pointerActive = true;
  dragging = true;
  moved = 0;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  moved += Math.abs(dx) + Math.abs(dy);
  const v = view();
  state.center.lon = worldXToLon(lonToWorldX(state.center.lon, v.z) - dx, v.z);
  state.center.lat = worldYToLat(latToWorldY(state.center.lat, v.z) - dy, v.z);
  scheduleDraw();
});

canvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  pointerActive = false;
  if (moved < 5) addPoint(e.clientX, e.clientY);
});

canvas.addEventListener('pointercancel', () => {
  dragging = false;
  pointerActive = false;
});

function addPoint(sx, sy) {
  const p = screenToLatLon(sx, sy);
  if (state.capture.pattern.length < 4) {
    state.capture.pattern.push(p);
  } else if (state.capture.thresholds.length < 2) {
    state.capture.thresholds.push(p);
  } else {
    return;
  }
  updateStatus();
  scheduleDraw();
}

function setZoom(z, anchor) {
  const clamped = Math.max(MIN_Z, Math.min(MAX_Z, z));
  if (clamped === state.zoom) return;
  // Keep the anchor point (screen position) fixed across the zoom change.
  const a = anchor || { x: W / 2, y: H / 2 };
  const before = screenToLatLon(a.x, a.y);
  state.zoom = clamped;
  const after = latLonToScreen(before.lat, before.lon);
  const v = view();
  state.center.lon = worldXToLon(
    lonToWorldX(state.center.lon, v.z) + (after.x - a.x),
    v.z
  );
  state.center.lat = worldYToLat(
    latToWorldY(state.center.lat, v.z) + (after.y - a.y),
    v.z
  );
  scheduleDraw();
}

zoomInBtn.addEventListener('click', () => setZoom(state.zoom + 1));
zoomOutBtn.addEventListener('click', () => setZoom(state.zoom - 1));
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    setZoom(state.zoom + (e.deltaY < 0 ? 1 : -1), {
      x: e.clientX,
      y: e.clientY,
    });
  },
  { passive: false }
);

/* --------------------------------------------------------------- form/list */

function centroid(points) {
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
  };
}

function updateStatus() {
  const np = state.capture.pattern.length;
  const nt = state.capture.thresholds.length;
  let text;
  if (np < 4) text = `Click the 4 pattern corners (${np}/4), in direction of travel`;
  else if (nt < 2) text = `Click the 2 runway thresholds (${nt}/2)`;
  else text = 'Ready to save';
  statusEl.textContent = text;
  saveBtn.disabled = !(np === 4 && nt === 2 && nameInput.value.trim());
}

function resetCapture() {
  state.capture = { pattern: [], thresholds: [] };
  nameInput.value = '';
  updateStatus();
  scheduleDraw();
}

function renderList() {
  listEl.innerHTML = '';
  if (!state.airfields.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No airfields saved yet.';
    listEl.appendChild(li);
    return;
  }
  for (const af of state.airfields) {
    const li = document.createElement('li');
    li.className = af.id === state.targetId ? 'item target' : 'item';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = af.name;
    li.appendChild(name);

    const actions = document.createElement('span');
    actions.className = 'actions';

    const showBtn = document.createElement('button');
    showBtn.textContent = 'Show';
    showBtn.addEventListener('click', () => {
      const c = centroid(af.pattern);
      state.center = c;
      state.zoom = Math.max(state.zoom, 15);
      scheduleDraw();
    });

    const targetBtn = document.createElement('button');
    targetBtn.textContent = af.id === state.targetId ? 'Target \u2713' : 'Set target';
    targetBtn.disabled = af.id === state.targetId;
    targetBtn.addEventListener('click', () => {
      state.targetId = af.id;
      store.setTarget(af.id);
      renderList();
      scheduleDraw();
    });

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      if (!window.confirm(`Delete ${af.name}?`)) return;
      state.airfields = state.airfields.filter((a) => a.id !== af.id);
      store.saveAirfields(state.airfields);
      if (state.targetId === af.id) {
        state.targetId = null;
        store.setTarget(null);
      }
      renderList();
      scheduleDraw();
    });

    actions.append(showBtn, targetBtn, delBtn);
    li.appendChild(actions);
    listEl.appendChild(li);
  }
}

newBtn.addEventListener('click', resetCapture);
clearBtn.addEventListener('click', resetCapture);

undoBtn.addEventListener('click', () => {
  if (state.capture.thresholds.length) state.capture.thresholds.pop();
  else if (state.capture.pattern.length) state.capture.pattern.pop();
  updateStatus();
  scheduleDraw();
});

nameInput.addEventListener('input', updateStatus);

saveBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name || state.capture.pattern.length !== 4 || state.capture.thresholds.length !== 2) {
    return;
  }
  state.airfields.push({
    id: store.uid(),
    name,
    pattern: state.capture.pattern.map((p) => ({
      lat: +p.lat.toFixed(6),
      lon: +p.lon.toFixed(6),
    })),
    thresholds: state.capture.thresholds.map((p) => ({
      lat: +p.lat.toFixed(6),
      lon: +p.lon.toFixed(6),
    })),
    created: new Date().toISOString(),
  });
  store.saveAirfields(state.airfields);
  renderList();
  resetCapture();
});

/* ------------------------------------------------------------------- boot */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleDraw();
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

document.getElementById('attribution').textContent = CONFIG.tileAttribution;

resize();
renderList();
updateStatus();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}
