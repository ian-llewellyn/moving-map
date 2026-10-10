import { CONFIG } from './config.js';
import * as store from './store.js';
import {
  toRad,
  normalizeDeg,
  signedAngleDiff,
  distanceMeters,
  bestFitHeading,
  pathLengthMeters,
  nearestOnPattern,
  toENU,
} from './geo.js';

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const banner = document.getElementById('banner');
const bannerText = document.getElementById('banner-text');
const bannerBtn = document.getElementById('banner-btn');
const startOverlay = document.getElementById('start');
const startBtn = document.getElementById('start-btn');
const menuBtn = document.getElementById('menu-btn');
const menu = document.getElementById('menu');
const fullscreenBtn = document.getElementById('fullscreen-btn');

const state = {
  started: false,
  plane: null,
  compassHeading: null,
  compassAt: 0,
  dispHeading: null,
  track: [],
  mpp: 0,
  targetId: store.getTarget(),
  airfields: store.getAirfields(),
  settings: store.getSettings(),
  towns: [],
  hitTargets: [],
  gpsDenied: false,
  gpsError: false,
  wakeLock: null,
  wakeLockDenied: false,
  watching: false,
  watchId: null,
};

let W = 0;
let H = 0;

/* ---------------------------------------------------------------- layout */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!state.mpp) state.mpp = 30000 / (0.9 * H);
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

/* ------------------------------------------------------------ input data */

async function loadTowns() {
  try {
    const res = await fetch(CONFIG.townDataUrl, { cache: 'force-cache' });
    const data = await res.json();
    state.towns = Array.isArray(data) ? data : data.places || [];
  } catch {
    state.towns = [];
  }
}

/* ----------------------------------------------------------- permissions */

function setBanner(text, showButton) {
  if (!text) {
    banner.hidden = true;
    return;
  }
  bannerText.textContent = text;
  bannerBtn.hidden = !showButton;
  banner.hidden = false;
}

function updateBanner() {
  if (state.gpsDenied || state.gpsError) {
    setBanner(
      state.gpsDenied
        ? 'Location permission denied.'
        : 'Waiting for GPS fix\u2026',
      true
    );
  } else if (state.wakeLockDenied) {
    setBanner('Screen wake lock unavailable.', false);
  } else {
    setBanner(null);
  }
}

async function acquireWakeLock() {
  if (!state.started) return;
  if (!('wakeLock' in navigator)) {
    state.wakeLockDenied = true;
    updateBanner();
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLockDenied = false;
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLockDenied = true;
  }
  updateBanner();
}

// Best-effort fullscreen; may be rejected without a user gesture.
function requestFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn) return;
  try {
    const result = fn.call(el, { navigationUI: 'hide' });
    if (result && result.catch) result.catch(() => {});
  } catch {
    /* ignore */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    acquireWakeLock();
    if (state.started && !document.fullscreenElement) requestFullscreen();
  }
});

function onPosition(pos) {
  const c = pos.coords;
  state.gpsError = false;
  state.plane = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy };

  const last = state.track[state.track.length - 1];
  if (
    !last ||
    distanceMeters(last.lat, last.lon, c.latitude, c.longitude) >= 8
  ) {
    state.track.push({ lat: c.latitude, lon: c.longitude });
    if (state.track.length > 12) state.track.shift();
  }
  updateBanner();
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) state.gpsDenied = true;
  else state.gpsError = true;
  updateBanner();
}

function startGeolocation() {
  if (!('geolocation' in navigator)) {
    state.gpsDenied = true;
    updateBanner();
    return;
  }
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.gpsDenied = false;
  state.gpsError = true; // until first fix
  state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 20000,
  });
  updateBanner();
}

/* -------------------------------------------------------------- heading */

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') {
    h = e.webkitCompassHeading;
  } else if (typeof e.alpha === 'number' && e.absolute !== false) {
    h = 360 - e.alpha;
  }
  if (h == null || Number.isNaN(h)) return;
  const screenAngle =
    (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  state.compassHeading = normalizeDeg(h + screenAngle);
  state.compassAt = performance.now();
}

function currentHeading() {
  if (state.compassHeading != null && performance.now() - state.compassAt < 2500) {
    return state.compassHeading;
  }
  const fit = bestFitHeading(state.track);
  if (fit != null && pathLengthMeters(state.track) >= 40) return fit;
  return null;
}

/* -------------------------------------------------------------- render */

function enuScreen(lat, lon, heading) {
  const { e, n } = toENU(lat, lon, state.plane.lat, state.plane.lon);
  const d = Math.hypot(e, n);
  const rel = Math.atan2(e, n) - toRad(heading);
  return {
    x: W * 0.5 + (d / state.mpp) * Math.sin(rel),
    y: H * 0.9 - (d / state.mpp) * Math.cos(rel),
    d,
  };
}

function onScreen(p, margin) {
  const m = margin == null ? 60 : margin;
  return p.x >= -m && p.x <= W + m && p.y >= -m && p.y <= H + m;
}

function drawTowns(heading) {
  if (!state.settings.showTownPoints && !state.settings.showTownNames) return;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const t of state.towns) {
    const p = enuScreen(t.lat, t.lon, heading);
    if (!onScreen(p, 120)) continue;
    if (state.settings.showTownPoints) {
      const r = (t.radiusKm * 1000) / state.mpp;
      ctx.beginPath();
      if (r < 2) {
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
      } else {
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.stroke();
      }
    }
    if (state.settings.showTownNames) {
      ctx.font = '500 12px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(t.name, p.x + 4, p.y - 4);
    }
  }
}

function drawAirfields(heading) {
  state.hitTargets = [];
  if (!state.settings.showAirfields && !state.settings.showAirfieldNames) return;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  for (const af of state.airfields) {
    const isTarget = af.id === state.targetId;
    const pattern = af.pattern || [];
    if (state.settings.showAirfields && pattern.length >= 2) {
      ctx.beginPath();
      for (let i = 0; i < pattern.length; i++) {
        const p = enuScreen(pattern[i].lat, pattern[i].lon, heading);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.strokeStyle = isTarget ? '#ffffff' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = isTarget ? 2.5 : 1.25;
      ctx.stroke();
    }

    const thr = af.thresholds || [];
    if (state.settings.showAirfields && thr.length === 2) {
      const a = enuScreen(thr[0].lat, thr[0].lon, heading);
      const b = enuScreen(thr[1].lat, thr[1].lon, heading);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = isTarget ? '#ffffff' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = isTarget ? 2.5 : 1.25;
      ctx.stroke();
    }

    // Anchor (centroid of pattern) for the point/name/tap target.
    let lat = af.lat;
    let lon = af.lon;
    if (pattern.length >= 1) {
      lat = pattern.reduce((s, p) => s + p.lat, 0) / pattern.length;
      lon = pattern.reduce((s, p) => s + p.lon, 0) / pattern.length;
    }
    const c = enuScreen(lat, lon, heading);
    if (onScreen(c, 200)) {
      state.hitTargets.push({ x: c.x, y: c.y, id: af.id, name: af.name });
      if (state.settings.showAirfields) {
        ctx.beginPath();
        ctx.arc(
          c.x,
          c.y,
          isTarget ? 6 : 4,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        if (isTarget) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      if (state.settings.showAirfieldNames && af.name) {
        ctx.font = (isTarget ? '700 15px' : '600 13px') + ' system-ui, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(af.name, c.x + 9, c.y - 9);
      }
    }
  }
}

function drawTrackLine(heading) {
  const af = state.airfields.find((a) => a.id === state.targetId);
  if (!af || !af.pattern || af.pattern.length < 2) return;
  const near = nearestOnPattern(state.plane.lat, state.plane.lon, af.pattern);
  if (!near) return;
  const rel = Math.atan2(near.east, near.north) - toRad(heading);
  const x = W * 0.5 + (near.distance / state.mpp) * Math.sin(rel);
  const y = H * 0.9 - (near.distance / state.mpp) * Math.cos(rel);
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(W * 0.5, H * 0.9);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.restore();
}

function drawPlane() {
  const x = W * 0.5;
  const y = H * 0.9;
  ctx.beginPath();
  ctx.moveTo(x, y - 16);
  ctx.lineTo(x - 11, y + 12);
  ctx.lineTo(x, y + 6);
  ctx.lineTo(x + 11, y + 12);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// Figures slide around the outer edge of the display, one every 10 degrees.
function drawCompass(heading) {
  const cx = W * 0.5;
  const cy = H * 0.5;
  const margin = 24;
  const hx = Math.max(1, W * 0.5 - margin);
  const hy = Math.max(1, H * 0.5 - margin);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 16px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let deg = 0; deg < 360; deg += 10) {
    const rel = toRad(deg - heading);
    const dx = Math.sin(rel);
    const dy = -Math.cos(rel);
    // Scale the ray until it meets the inset screen border.
    const t = Math.min(
      hx / Math.max(Math.abs(dx), 1e-6),
      hy / Math.max(Math.abs(dy), 1e-6)
    );
    ctx.fillText(String(deg), cx + t * dx, cy + t * dy);
  }
}

function drawWaiting() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('Waiting for GPS\u2026', W * 0.5, H * 0.45);
}

let lastTime = performance.now();
let lastFlash = 0;
let flashOn = false;

function frame(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  const rawHeading = state.started ? currentHeading() : null;
  if (rawHeading != null) {
    if (state.dispHeading == null) state.dispHeading = rawHeading;
    else {
      const k = 1 - Math.pow(0.001, dt); // ~responsive, frame-rate independent
      state.dispHeading = normalizeDeg(
        state.dispHeading + signedAngleDiff(rawHeading, state.dispHeading) * k
      );
    }
  }
  const unavailable = state.started && state.plane && rawHeading == null;
  const heading = state.dispHeading == null ? 0 : state.dispHeading;

  // Dynamic zoom when aligned with the target.
  if (state.plane && state.mpp) {
    const af = state.airfields.find((a) => a.id === state.targetId);
    if (af && af.pattern && af.pattern.length >= 2 && rawHeading != null) {
      const near = nearestOnPattern(state.plane.lat, state.plane.lon, af.pattern);
      if (
        near &&
        near.distance > 30 &&
        Math.abs(signedAngleDiff(heading, near.bearing)) <= CONFIG.zoomAlignDeg
      ) {
        const desired = near.distance / (CONFIG.zoomTargetFraction * 0.9 * H);
        const clamped = Math.max(CONFIG.minMpp, Math.min(CONFIG.maxMpp, desired));
        const k = 1 - Math.pow(0.3, dt);
        state.mpp += (clamped - state.mpp) * k;
      }
    }
  }

  // Background, with the heading-unavailable flash.
  if (unavailable) {
    if (now - lastFlash >= 500) {
      flashOn = !flashOn;
      lastFlash = now;
    }
  } else {
    flashOn = false;
  }
  ctx.fillStyle = flashOn ? 'rgb(128,0,0)' : '#000000';
  ctx.fillRect(0, 0, W, H);

  if (state.started && state.plane) {
    drawTowns(heading);
    drawAirfields(heading);
    drawTrackLine(heading);
  }
  drawPlane();
  drawCompass(heading);
  if (state.started && !state.plane) drawWaiting();

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ taps */

function onCanvasTap(clientX, clientY) {
  if (!state.airfields.length) return;
  let best = null;
  for (const t of state.hitTargets) {
    const d = Math.hypot(t.x - clientX, t.y - clientY);
    if (d <= CONFIG.tapRadiusPx && (!best || d < best.d)) {
      best = { d, ...t };
    }
  }
  if (!best || best.id === state.targetId) return;
  if (window.confirm(`Set new target: ${best.name}?`)) {
    state.targetId = best.id;
    store.setTarget(best.id);
  }
}

canvas.addEventListener('click', (e) => onCanvasTap(e.clientX, e.clientY));

/* ----------------------------------------------------------------- start */

async function start() {
  if (state.started) return;
  state.started = true;
  startOverlay.hidden = true;
  requestFullscreen();
  await acquireWakeLock();
  startGeolocation();
  if ('DeviceOrientationEvent' in window) {
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
    } else {
      window.addEventListener('deviceorientation', onOrientation, true);
    }
  }
}

startBtn.addEventListener('click', start);

bannerBtn.addEventListener('click', () => {
  state.gpsDenied = false;
  startGeolocation();
  acquireWakeLock();
});

menuBtn.addEventListener('click', () => {
  menu.hidden = !menu.hidden;
});
fullscreenBtn.addEventListener('click', requestFullscreen);
menu.addEventListener('click', (e) => {
  if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') menu.hidden = true;
});

/* ------------------------------------------------------------------ boot */

resize();
loadTowns();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}
