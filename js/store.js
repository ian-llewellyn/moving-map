// localStorage-backed persistence for airfields, settings and the target.

const KEYS = {
  airfields: 'hsi.airfields.v1',
  settings: 'hsi.settings.v1',
  target: 'hsi.target.v1',
};

export const DEFAULT_SETTINGS = {
  showTownPoints: true,
  showTownNames: true,
  // Hide circles below this town radius (metres).
  townCircleMinM: 350,
  // Hide names below this town radius (metres).
  townNameMinM: 500,
  showAirfields: true,
  showAirfieldNames: true,
  // Static OSM airfields (aeroplane markers + runway lines).
  showStaticAirfields: true,
  showStaticAirfieldNames: true,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function uid() {
  return 'af_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function getAirfields() {
  const list = read(KEYS.airfields, []);
  return Array.isArray(list) ? list : [];
}

export function saveAirfields(list) {
  return write(KEYS.airfields, list);
}

export function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, read(KEYS.settings, {}));
}

export function saveSettings(settings) {
  return write(KEYS.settings, settings);
}

export function getTarget() {
  return read(KEYS.target, null);
}

export function setTarget(id) {
  return write(KEYS.target, id);
}
