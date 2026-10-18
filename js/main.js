import { CONFIG } from './config.js';
import * as store from './store.js';
import {
  toRad,
  toDeg,
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
const debugBtn = document.getElementById('debug-btn');
const debugOverlay = document.getElementById('debug');
const debugReason = document.getElementById('debug-reason');
const debugBody = document.getElementById('debug-body');
const debugLogEl = document.getElementById('debug-log');
const debugCopyBtn = document.getElementById('debug-copy');
const debugCloseBtn = document.getElementById('debug-close');
const debugCopied = document.getElementById('debug-copied');

const state = {
  started: false,
  plane: null,
  compassHeading: null,
  compassAt: 0,
  dispHeading: null,
  track: [],
  mpp: 0,
  targetId: store.getTarget(),
  zoomTargetId: undefined,
  airfields: store.getAirfields(),
  settings: store.getSettings(),
  towns: [],
  staticAirfields: [],
  regionCounts: {},
  hitTargets: [],
  gpsDenied: false,
  gpsError: false,
  wakeLock: null,
  wakeLockDenied: false,
  watching: false,
  watchId: null,
  // Diagnostics.
  geoPermission: 'unknown',
  lastError: null,
  lastPos: null,
  fixCount: 0,
  lastFixAt: 0,
  orientationListener: 'none',
  orientationPermission: 'unknown',
  orientationCount: 0,
  lastOrientation: null,
  // AbsoluteOrientationSensor (fused accel + gyro + magnetometer).
  orientationSensor: null,
  sensorStatus: 'idle',
  sensorError: null,
  sensorHeading: null,
  sensorAt: 0,
  sensorCount: 0,
  sensorFirstAt: 0,
  log: [],
  lastDebugRender: 0,
};

function logEvent(msg) {
  state.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (state.log.length > 40) state.log.shift();
}

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

// Load the static datasets for every region enabled in settings. A region
// that fails to load (offline before it was ever cached) is simply skipped.
function regionItems(doc, key) {
  if (Array.isArray(doc)) return doc;
  return doc[key] || [];
}

async function loadRegionData() {
  const enabled = CONFIG.regions.filter((r) => state.settings.regions.includes(r.code));
  const towns = [];
  const airfields = [];
  state.regionCounts = {};
  await Promise.all(
    enabled.map(async (region) => {
      try {
        const [townDoc, airfieldDoc] = await Promise.all([
          fetch(region.towns, { cache: 'force-cache' }).then((r) => r.json()),
          fetch(region.airfields, { cache: 'force-cache' }).then((r) => r.json()),
        ]);
        const regionTowns = regionItems(townDoc, 'places');
        const regionAirfields = regionItems(airfieldDoc, 'airfields');
        towns.push(...regionTowns);
        airfields.push(...regionAirfields);
        state.regionCounts[region.code] = {
          towns: regionTowns.length,
          airfields: regionAirfields.length,
        };
      } catch {
        state.regionCounts[region.code] = null;
        logEvent(`region ${region.code} data unavailable`);
      }
    })
  );
  state.towns = towns;
  state.staticAirfields = airfields;
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
  if (state.orientationPermission === 'denied') {
    setBanner(
      'Motion access denied. Enable Motion & Orientation Access for this browser, then Retry.',
      true
    );
  } else if (state.gpsDenied || state.gpsError) {
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

if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((status) => {
      state.geoPermission = status.state;
      status.onchange = () => {
        state.geoPermission = status.state;
        logEvent(`geolocation permission: ${status.state}`);
      };
    })
    .catch(() => {});
}

function onPosition(pos) {
  const c = pos.coords;
  const first = !state.plane;
  state.gpsError = false;
  state.plane = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy };
  state.lastPos = {
    heading: c.heading,
    speed: c.speed,
    accuracy: c.accuracy,
    altitude: c.altitude,
  };
  state.fixCount++;
  state.lastFixAt = performance.now();
  if (first) logEvent('first GPS fix');

  const last = state.track[state.track.length - 1];
  if (
    !last ||
    distanceMeters(last.lat, last.lon, c.latitude, c.longitude) >=
      CONFIG.trackSampleMeters
  ) {
    state.track.push({ lat: c.latitude, lon: c.longitude });
    if (state.track.length > 12) state.track.shift();
  }
  updateBanner();
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) state.gpsDenied = true;
  else state.gpsError = true;
  state.lastError = { code: err.code, message: err.message };
  logEvent(`GPS error ${err.code}: ${err.message}`);
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
  const firstEvent = state.orientationCount === 0;
  state.orientationCount++;
  state.lastOrientation = {
    type: e.type,
    alpha: e.alpha,
    beta: e.beta,
    gamma: e.gamma,
    absolute: e.absolute,
    webkitCompassHeading: e.webkitCompassHeading,
    webkitCompassAccuracy: e.webkitCompassAccuracy,
  };
  if (firstEvent) logEvent(`orientation events: ${e.type} (absolute=${e.absolute})`);

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

// AbsoluteOrientationSensor gives a fused, high-rate quaternion (device ->
// East-North-Up). The bearing of the screen's top edge, projected onto the
// horizontal plane, is the heading we want; tilt is ignored.
function headingFromQuaternion(q) {
  if (!q) return null;
  const [x, y, z, w] = q;
  const east = 2 * (x * y - z * w);
  const north = 1 - 2 * (x * x + z * z);
  if (east === 0 && north === 0) return null;
  return normalizeDeg((Math.atan2(east, north) * 180) / Math.PI);
}

function onSensorReading() {
  const sensor = state.orientationSensor;
  if (!state.sensorFirstAt) state.sensorFirstAt = performance.now();
  const h = headingFromQuaternion(sensor.quaternion);
  if (h == null) return;
  state.sensorHeading = h;
  state.sensorAt = performance.now();
  state.sensorCount++;
}

function startOrientationSensor() {
  if (!('AbsoluteOrientationSensor' in window)) {
    state.sensorStatus = 'unsupported';
    return;
  }
  try {
    state.orientationSensor = new AbsoluteOrientationSensor({
      frequency: CONFIG.sensorFrequency,
      referenceFrame: 'screen',
    });
  } catch (err) {
    state.sensorStatus = 'error';
    state.sensorError = `${err.name}: ${err.message}`;
    logEvent(`orientation sensor failed: ${state.sensorError}`);
    return;
  }
  state.orientationSensor.onreading = onSensorReading;
  state.orientationSensor.onerror = (e) => {
    state.sensorStatus = 'error';
    state.sensorError = (e.error && e.error.name) || 'error';
    logEvent(`orientation sensor error: ${state.sensorError}`);
  };
  try {
    state.orientationSensor.start();
    state.sensorStatus = 'started';
  } catch (err) {
    state.sensorStatus = 'error';
    state.sensorError = err.name;
    logEvent(`orientation sensor start failed: ${state.sensorError}`);
  }
}

function currentHeading() {
  const now = performance.now();
  if (
    state.sensorHeading != null &&
    now - state.sensorAt < CONFIG.headingFreshMs
  ) {
    return state.sensorHeading;
  }
  if (
    state.compassHeading != null &&
    now - state.compassAt < CONFIG.headingFreshMs
  ) {
    return state.compassHeading;
  }
  const fit = bestFitHeading(state.track);
  if (fit != null && pathLengthMeters(state.track) >= CONFIG.trackMinMeters) {
    return fit;
  }
  return null;
}

function headingSource() {
  const now = performance.now();
  if (
    state.sensorHeading != null &&
    now - state.sensorAt < CONFIG.headingFreshMs
  ) {
    return 'orientation sensor';
  }
  if (
    state.compassHeading != null &&
    now - state.compassAt < CONFIG.headingFreshMs
  ) {
    return 'deviceorientation';
  }
  const fit = bestFitHeading(state.track);
  if (fit != null && pathLengthMeters(state.track) >= CONFIG.trackMinMeters) {
    return 'track best-fit';
  }
  return 'none';
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

// Lat/lon window covering everything that can land on screen (plus margin).
// Lets the per-frame loops reject distant points with plain comparisons
// instead of a projection per point.
function viewWindow(marginPx) {
  const m = marginPx == null ? 120 : marginPx;
  const radius = (Math.hypot(W, H) * 0.5 + m) * state.mpp;
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.max(0.05, Math.cos(toRad(state.plane.lat))));
  return {
    latMin: state.plane.lat - dLat,
    latMax: state.plane.lat + dLat,
    lonMin: state.plane.lon - dLon,
    lonMax: state.plane.lon + dLon,
  };
}

function inWindow(p, w) {
  return p.lat >= w.latMin && p.lat <= w.latMax && p.lon >= w.lonMin && p.lon <= w.lonMax;
}

function drawTowns(heading) {
  if (!state.settings.showTownPoints && !state.settings.showTownNames) return;
  const circleMinM = Number(state.settings.townCircleMinM) || 0;
  const nameMinM = Number(state.settings.townNameMinM) || 0;
  const window = viewWindow(120);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const t of state.towns) {
    if (!inWindow(t, window)) continue;
    const p = enuScreen(t.lat, t.lon, heading);
    if (!onScreen(p, 120)) continue;
    if (state.settings.showTownPoints && t.radiusKm * 1000 >= circleMinM) {
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
    if (state.settings.showTownNames && t.radiusKm * 1000 >= nameMinM) {
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

// Simple aeroplane glyph pointing "up" then rotated by `angle` (radians,
// clockwise on screen).
function drawPlaneGlyph(x, y, angle, size, colour) {
  const s = size / 16;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -16 * s);
  ctx.lineTo(-11 * s, 12 * s);
  ctx.lineTo(0, 6 * s);
  ctx.lineTo(11 * s, 12 * s);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.restore();
}

// Static OSM airfields: aeroplane marker plus one fixed-length line per
// runway (deliberately not to scale).
function drawStaticAirfields(heading) {
  const show = state.settings.showStaticAirfields;
  const showNames = state.settings.showStaticAirfieldNames;
  if (!show && !showNames) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const colour = '#f4f';
  const window = viewWindow(120);
  for (const af of state.staticAirfields) {
    if (!inWindow(af, window)) continue;
    const c = enuScreen(af.lat, af.lon, heading);
    if (!onScreen(c, 120)) continue;
    const isTarget = af.id === state.targetId;
    const runways = af.runways || [];
    if (show) {
      for (const rw of runways) {
        const a = toRad(rw.hdg - heading);
        const dx = Math.sin(a) * 22;
        const dy = -Math.cos(a) * 22;
        ctx.beginPath();
        ctx.moveTo(c.x - dx, c.y - dy);
        ctx.lineTo(c.x + dx, c.y + dy);
        ctx.strokeStyle = colour;
        ctx.lineWidth = isTarget ? 3 : 2;
        ctx.stroke();
      }
      let glyphAngle = 0;
      if (runways.length) {
        const longest = runways.reduce((m, r) => (r.lengthM > m.lengthM ? r : m));
        glyphAngle = toRad(longest.hdg - heading);
      }
      drawPlaneGlyph(c.x, c.y, glyphAngle, isTarget ? 15 : 12, colour);
      if (isTarget) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    state.hitTargets.push({
      x: c.x,
      y: c.y,
      id: af.id,
      name: af.name || af.icao || 'unnamed airfield',
    });
    if (showNames && af.name) {
      ctx.font = '500 13px system-ui, sans-serif';
      ctx.fillStyle = colour;
      ctx.fillText(af.name, c.x + 8, c.y - 10);
    }
  }
}

function findAirfield(id) {
  return (
    state.airfields.find((a) => a.id === id) ||
    state.staticAirfields.find((a) => a.id === id) ||
    null
  );
}

// Position of the target relative to the plane: nearest point on the traced
// pattern, else the field centre (static OSM fields). Shared by the guide
// line and the dynamic zoom so they always agree.
function targetRelative(af) {
  if (!state.plane || !af) return null;
  const pattern = af.pattern || [];
  if (pattern.length >= 2) {
    const near = nearestOnPattern(state.plane.lat, state.plane.lon, pattern);
    if (near) return near;
  }
  if (typeof af.lat !== 'number' || typeof af.lon !== 'number') return null;
  const enu = toENU(af.lat, af.lon, state.plane.lat, state.plane.lon);
  const distance = Math.hypot(enu.e, enu.n);
  return {
    east: enu.e,
    north: enu.n,
    distance,
    bearing: normalizeDeg(toDeg(Math.atan2(enu.e, enu.n))),
  };
}

function drawTrackLine(heading) {
  if (!state.plane) return;
  const af = findAirfield(state.targetId);
  if (!af) return;
  const rel0 = targetRelative(af);
  if (!rel0) return;
  const rel = Math.atan2(rel0.east, rel0.north) - toRad(heading);
  const x = W * 0.5 + (rel0.distance / state.mpp) * Math.sin(rel);
  const y = H * 0.9 - (rel0.distance / state.mpp) * Math.cos(rel);
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
  drawPlaneGlyph(W * 0.5, H * 0.9, 0, 16, '#ffffff');
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

  // Dynamic zoom, for any target (traced pattern point or static field
  // centre). When the target changes, jump part of the way immediately so
  // selection has a visible effect; otherwise servo while aligned.
  if (state.plane && state.mpp) {
    if (state.targetId !== state.zoomTargetId) {
      state.zoomTargetId = state.targetId;
      const rel = targetRelative(findAirfield(state.targetId));
      if (rel) {
        const fit = rel.distance / (CONFIG.zoomTargetFraction * 0.9 * H);
        const clamped = Math.max(CONFIG.minMpp, Math.min(CONFIG.maxMpp, fit));
        state.mpp += (clamped - state.mpp) * CONFIG.zoomReframe;
      }
    }
    const af = findAirfield(state.targetId);
    const rel = af && rawHeading != null ? targetRelative(af) : null;
    if (
      rel &&
      rel.distance > 30 &&
      Math.abs(signedAngleDiff(heading, rel.bearing)) <= CONFIG.zoomAlignDeg
    ) {
      const desired = rel.distance / (CONFIG.zoomTargetFraction * 0.9 * H);
      const clamped = Math.max(CONFIG.minMpp, Math.min(CONFIG.maxMpp, desired));
      const k = 1 - Math.pow(0.3, dt);
      state.mpp += (clamped - state.mpp) * k;
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
    drawStaticAirfields(heading);
    drawTrackLine(heading);
  }
  drawPlane();
  drawCompass(heading);
  if (state.started && !state.plane) drawWaiting();

  if (!debugOverlay.hidden && now - state.lastDebugRender > 250) {
    state.lastDebugRender = now;
    renderDebug();
  }

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ taps */

function onCanvasTap(clientX, clientY) {
  if (!state.hitTargets.length) return;
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

// iOS 13+ gates DeviceOrientation behind a permission prompt that must be
// requested from inside a user gesture, before any await. Without it iOS
// delivers no orientation events at all and heading falls back to GPS track.
async function requestOrientationPermission() {
  if (
    typeof DeviceOrientationEvent === 'undefined' ||
    typeof DeviceOrientationEvent.requestPermission !== 'function'
  ) {
    state.orientationPermission = 'not-required';
    return;
  }
  try {
    state.orientationPermission =
      await DeviceOrientationEvent.requestPermission();
  } catch {
    state.orientationPermission = 'denied';
  }
  logEvent(`orientation permission: ${state.orientationPermission}`);
}

// Listen to both events where available: WebKit uses plain deviceorientation
// (with webkitCompassHeading), Chromium also offers deviceorientationabsolute.
function attachOrientationListeners() {
  if (typeof DeviceOrientationEvent === 'undefined') {
    state.orientationListener = 'unsupported';
    return;
  }
  window.addEventListener('deviceorientation', onOrientation, true);
  state.orientationListener = 'deviceorientation';
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    state.orientationListener = 'deviceorientation+absolute';
  }
}

async function start() {
  if (state.started) return;
  state.started = true;
  startOverlay.hidden = true;
  // requestFullscreen stays first and synchronous (needs the gesture);
  // the permission prompt is then the first await, still inside the gesture.
  requestFullscreen();
  await requestOrientationPermission();
  await acquireWakeLock();
  startGeolocation();
  attachOrientationListeners();
  startOrientationSensor();
  updateBanner();
  logEvent(
    `started; orientation=${state.orientationListener}` +
      ` (${state.orientationPermission}); sensor=${state.sensorStatus}`
  );
}

startBtn.addEventListener('click', start);

bannerBtn.addEventListener('click', async () => {
  state.gpsDenied = false;
  if (state.orientationPermission === 'denied') {
    await requestOrientationPermission();
    attachOrientationListeners();
  }
  startGeolocation();
  acquireWakeLock();
  updateBanner();
});

menuBtn.addEventListener('click', () => {
  menu.hidden = !menu.hidden;
});
menu.addEventListener('click', (e) => {
  if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') menu.hidden = true;
});

/* ----------------------------------------------------------------- debug */

function msAgo(t) {
  return t == null ? 'n/a' : Math.round(performance.now() - t) + ' ms ago';
}

function rateHz(count, firstAt) {
  if (!count || !firstAt) return 'n/a';
  const secs = (performance.now() - firstAt) / 1000;
  return secs > 0 ? (count / secs).toFixed(1) + ' Hz' : 'n/a';
}

function displayMode() {
  if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen';
  if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
  return 'browser';
}

function buildReport() {
  const now = performance.now();
  const compassFresh =
    state.compassHeading != null &&
    now - state.compassAt < CONFIG.headingFreshMs;
  const sensorFresh =
    state.sensorHeading != null && now - state.sensorAt < CONFIG.headingFreshMs;
  const pathLen = pathLengthMeters(state.track);
  const fit = bestFitHeading(state.track);
  const heading = state.started ? currentHeading() : null;
  const source = state.started ? headingSource() : 'none';
  const unavailable = state.started && state.plane && heading == null;

  let reason;
  let reasonCls = '';
  if (!state.started) {
    reason = 'Not started.';
  } else if (!state.plane) {
    reason = 'No GPS fix yet.';
  } else if (heading != null) {
    reasonCls = 'ok';
    reason = `Heading OK (${source}).`;
  } else {
    reasonCls = 'bad';
    const why = [];
    if (state.orientationPermission === 'denied')
      why.push(
        'motion access denied (enable Motion & Orientation Access, then retry)'
      );
    else if (state.orientationListener === 'none' && state.sensorStatus === 'idle')
      why.push('sensors not started');
    else if (state.sensorStatus === 'error')
      why.push(`orientation sensor ${state.sensorError || 'error'}`);
    else if (state.orientationCount === 0 && state.sensorCount === 0)
      why.push('0 orientation events received');
    else if (!compassFresh && !sensorFresh) why.push('all sensors stale');
    why.push(
      `track ${state.track.length} pts / ${Math.round(pathLen)} m (need 2 pts / ${
        CONFIG.trackMinMeters
      } m)`
    );
    reason =
      'HEADING UNAVAILABLE \u2192 screen flashes red.\n\u2022 ' + why.join('\n\u2022 ');
  }

  const lo = state.lastOrientation || {};
  const rows = [
    { h: 'Environment' },
    { l: 'Secure context', v: String(window.isSecureContext), c: window.isSecureContext ? 'ok' : 'bad' },
    { l: 'Protocol / display', v: `${location.protocol} \u00b7 ${displayMode()}` },
    { l: 'Fullscreen element', v: document.fullscreenElement ? document.fullscreenElement.tagName : 'none' },
    { l: 'Service worker', v: navigator.serviceWorker && navigator.serviceWorker.controller ? 'active' : 'none' },
    { l: 'Online', v: String(navigator.onLine) },
    { h: 'Geolocation' },
    { l: 'Permission', v: state.geoPermission, c: state.geoPermission === 'granted' ? 'ok' : 'warn' },
    { l: 'Fixes', v: String(state.fixCount) },
    { l: 'Last fix', v: msAgo(state.lastFixAt || null) },
    { l: 'Accuracy', v: state.lastPos && state.lastPos.accuracy != null ? Math.round(state.lastPos.accuracy) + ' m' : 'n/a' },
    { l: 'coords.heading', v: state.lastPos ? String(state.lastPos.heading) : 'n/a' },
    { l: 'Speed', v: state.lastPos && state.lastPos.speed != null ? state.lastPos.speed + ' m/s' : 'n/a' },
    { l: 'Last error', v: state.lastError ? `code ${state.lastError.code}: ${state.lastError.message}` : 'none', c: state.lastError ? 'bad' : '' },
    { h: 'Orientation sensor' },
    { l: 'AbsoluteOrientationSensor', v: state.sensorStatus, c: state.sensorStatus === 'started' ? 'ok' : state.sensorStatus === 'unsupported' ? 'warn' : 'bad' },
    { l: 'Sensor error', v: state.sensorError || 'none', c: state.sensorError ? 'bad' : '' },
    { l: 'Readings', v: String(state.sensorCount), c: state.sensorCount ? 'ok' : 'bad' },
    { l: 'Rate', v: rateHz(state.sensorCount, state.sensorFirstAt) },
    { l: 'Last reading', v: msAgo(state.sensorAt || null) },
    { l: 'Sensor heading', v: state.sensorHeading == null ? 'null' : state.sensorHeading.toFixed(1), c: sensorFresh ? 'ok' : 'warn' },
    { h: 'DeviceOrientation' },
    { l: 'Listener', v: state.orientationListener },
    { l: 'Permission', v: state.orientationPermission, c: state.orientationPermission === 'denied' ? 'bad' : state.orientationPermission === 'not-required' ? 'ok' : 'warn' },
    { l: 'Events', v: String(state.orientationCount), c: state.orientationCount ? 'ok' : 'warn' },
    { l: 'Last event', v: msAgo(state.compassAt || null) },
    { l: 'alpha / beta / gamma', v: `${lo.alpha} / ${lo.beta} / ${lo.gamma}` },
    { l: 'absolute', v: String(lo.absolute) },
    { l: 'webkitCompassHeading', v: String(lo.webkitCompassHeading) },
    { l: 'webkitCompassAccuracy', v: String(lo.webkitCompassAccuracy) },
    { l: 'Computed compassHeading', v: state.compassHeading == null ? 'null' : state.compassHeading.toFixed(1), c: compassFresh ? 'ok' : 'warn' },
    { h: 'Heading logic' },
    { l: 'Track points', v: String(state.track.length) },
    { l: 'Path length', v: Math.round(pathLen) + ` m (need ${CONFIG.trackMinMeters})` },
    { l: 'Best-fit heading', v: fit == null ? 'null' : fit.toFixed(1) },
    { l: 'currentHeading()', v: heading == null ? 'null' : heading.toFixed(1), c: heading == null ? 'bad' : 'ok' },
    { l: 'Source', v: source, c: source === 'none' ? 'bad' : 'ok' },
    { l: 'Red flash active', v: String(unavailable), c: unavailable ? 'bad' : 'ok' },
    { h: 'Storage' },
    { l: 'Airfields (traced)', v: String(state.airfields.length) },
    { l: 'Airfields (OSM)', v: String(state.staticAirfields.length) },
    { l: 'Towns / villages', v: String(state.towns.length) },
    ...CONFIG.regions.map((region) => {
      const counts = state.regionCounts[region.code];
      if (counts === undefined) return { l: region.name, v: 'off' };
      if (counts === null) return { l: region.name, v: 'unavailable', c: 'warn' };
      return {
        l: region.name,
        v: `${counts.towns} towns / ${counts.airfields} airfields`,
        c: 'ok',
      };
    }),
    { l: 'Target', v: (findAirfield(state.targetId) || {}).name || 'none' },
  ];

  const textLines = [reason, ''];
  for (const r of rows) {
    if (r.h) textLines.push(`[${r.h}]`);
    else textLines.push(`${r.l}: ${r.v}`);
  }
  textLines.push('', 'Log:', ...state.log);

  return { reason, reasonCls, rows, text: textLines.join('\n') };
}

function renderDebug() {
  const { reason, reasonCls, rows } = buildReport();
  debugReason.textContent = reason;
  debugReason.className = 'debug-reason' + (reasonCls ? ' ' + reasonCls : '');

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.h) {
      const th = document.createElement('th');
      th.colSpan = 2;
      th.textContent = r.h;
      tr.appendChild(th);
    } else {
      const td1 = document.createElement('td');
      td1.textContent = r.l;
      const td2 = document.createElement('td');
      const span = document.createElement('span');
      if (r.c) span.className = r.c;
      span.textContent = r.v;
      td2.appendChild(span);
      tr.append(td1, td2);
    }
    frag.appendChild(tr);
  }
  debugBody.replaceChildren(frag);
  debugLogEl.textContent = state.log.join('\n');
}

debugBtn.addEventListener('click', () => {
  debugOverlay.hidden = false;
  renderDebug();
});

debugCloseBtn.addEventListener('click', () => {
  debugOverlay.hidden = true;
});

debugCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(buildReport().text);
    debugCopied.textContent = 'Copied';
  } catch {
    debugCopied.textContent = 'Copy failed';
  }
  setTimeout(() => {
    debugCopied.textContent = '';
  }, 1500);
});

/* ------------------------------------------------------------------ boot */

resize();
loadRegionData();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}
