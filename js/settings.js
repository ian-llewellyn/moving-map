import * as store from './store.js';
import { REGIONS } from './config.js';

const form = document.getElementById('settings');
const savedEl = document.getElementById('saved');
const settings = store.getSettings();

const MIN_M = 0;
const MAX_M = 20000;

// Each row is a checkbox; town rows also carry a minimum-radius threshold.
const FIELDS = [
  {
    key: 'showTownPoints',
    label: 'Show town / village circles',
    threshold: { key: 'townCircleMinM', label: 'hide circles below' },
  },
  {
    key: 'showTownNames',
    label: 'Show town / village names',
    threshold: { key: 'townNameMinM', label: 'hide names below' },
  },
  { key: 'showAirfields', label: 'Show airfields and patterns' },
  { key: 'showAirfieldNames', label: 'Show airfield names' },
  { key: 'showStaticAirfields', label: 'Show OSM airfields (magenta)' },
  { key: 'showStaticAirfieldNames', label: 'Show OSM airfield names' },
];

let savedTimer = null;

function clampM(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MIN_M;
  return Math.max(MIN_M, Math.min(MAX_M, n));
}

function render() {
  form.innerHTML = '';
  for (const field of FIELDS) {
    const id = 'set-' + field.key;
    const row = document.createElement('div');
    row.className = 'row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = !!settings[field.key];

    const label = document.createElement('label');
    label.className = 'row-label';
    label.htmlFor = id;
    label.textContent = field.label;

    row.append(cb, label);

    let syncDisabled = null;
    if (field.threshold) {
      const box = document.createElement('div');
      box.className = 'threshold';

      const caption = document.createElement('label');
      caption.className = 'threshold-label';
      caption.htmlFor = id + '-min';
      caption.textContent = field.threshold.label;

      const num = document.createElement('input');
      num.type = 'number';
      num.id = id + '-min';
      num.inputMode = 'numeric';
      num.min = String(MIN_M);
      num.max = String(MAX_M);
      num.step = '50';
      num.value = String(clampM(settings[field.threshold.key]));
      num.setAttribute('aria-label', `${field.threshold.label} (metres)`);

      const unit = document.createElement('span');
      unit.className = 'threshold-unit';
      unit.textContent = 'm';

      num.addEventListener('input', () => {
        settings[field.threshold.key] = clampM(num.value);
        store.saveSettings(settings);
        flashSaved();
      });
      num.addEventListener('blur', () => {
        num.value = String(clampM(num.value));
      });

      box.append(caption, num, unit);
      row.appendChild(box);
      syncDisabled = () => {
        num.disabled = !settings[field.key];
      };
    }

    inputListener(cb, field.key, syncDisabled);

    if (syncDisabled) syncDisabled();
    form.appendChild(row);
  }
  renderRegions();
}

// Per-country datasets. All are downloaded by the service worker; these
// checkboxes only control which are drawn (applied on next map load).
function renderRegions() {
  const heading = document.createElement('div');
  heading.className = 'group';
  heading.textContent = 'Map data';
  form.appendChild(heading);

  for (const region of REGIONS) {
    const id = 'set-region-' + region.code;
    const row = document.createElement('div');
    row.className = 'row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = settings.regions.includes(region.code);

    const label = document.createElement('label');
    label.className = 'row-label';
    label.htmlFor = id;
    label.textContent = region.name;

    cb.addEventListener('change', () => {
      const set = new Set(settings.regions);
      if (cb.checked) set.add(region.code);
      else set.delete(region.code);
      settings.regions = REGIONS.map((r) => r.code).filter((c) => set.has(c));
      store.saveSettings(settings);
      flashSaved();
    });

    row.append(cb, label);
    form.appendChild(row);
  }

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'Applies when the map is reloaded.';
  form.appendChild(note);
}

function inputListener(cb, key, syncDisabled) {
  cb.addEventListener('change', () => {
    settings[key] = cb.checked;
    store.saveSettings(settings);
    flashSaved();
    if (syncDisabled) syncDisabled();
  });
}

function flashSaved() {
  savedEl.textContent = 'Saved';
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedEl.textContent = '';
  }, 1200);
}

render();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}
