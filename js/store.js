// localStorage-backed persistence for airfields, settings and the target.

import { REGIONS } from './config.js';

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
  // Which per-country datasets to load and draw.
  regions: REGIONS.map((r) => r.code),
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
  const settings = Object.assign({}, DEFAULT_SETTINGS, read(KEYS.settings, {}));
  // Keep only known region codes; an unrecognised list falls back to default.
  const known = new Set(REGIONS.map((r) => r.code));
  if (Array.isArray(settings.regions)) {
    const kept = settings.regions
      .map((c) => String(c).toLowerCase())
      .filter((c) => known.has(c));
    settings.regions =
      kept.length || settings.regions.length === 0
        ? kept
        : DEFAULT_SETTINGS.regions.slice();
  } else {
    settings.regions = DEFAULT_SETTINGS.regions.slice();
  }
  return settings;
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
