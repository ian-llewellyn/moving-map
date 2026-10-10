import * as store from './store.js';

const form = document.getElementById('settings');
const savedEl = document.getElementById('saved');
const settings = store.getSettings();

const FIELDS = [
  ['showTownPoints', 'Show town / village circles'],
  ['showTownNames', 'Show town / village names'],
  ['showAirfields', 'Show airfields and patterns'],
  ['showAirfieldNames', 'Show airfield names'],
];

let savedTimer = null;

function render() {
  form.innerHTML = '';
  for (const [key, label] of FIELDS) {
    const row = document.createElement('label');
    row.className = 'row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!settings[key];
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      store.saveSettings(settings);
      flashSaved();
    });
    const span = document.createElement('span');
    span.textContent = label;
    row.append(input, span);
    form.appendChild(row);
  }
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
