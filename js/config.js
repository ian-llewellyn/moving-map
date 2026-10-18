// Shared configuration. Kept dependency-free so every page can import it.

// Per-country static datasets (built by tools/fetch_towns.py and
// tools/fetch_airfields.py). All are enabled by default; each can be
// deselected on the settings page.
export const REGIONS = [
  {
    code: 'ie',
    name: 'Ireland',
    towns: 'data/towns.ie.json',
    airfields: 'data/airfields.ie.json',
  },
  {
    code: 'gb',
    name: 'Great Britain',
    towns: 'data/towns.gb.json',
    airfields: 'data/airfields.gb.json',
  },
  {
    code: 'fr',
    name: 'France',
    towns: 'data/towns.fr.json',
    airfields: 'data/airfields.fr.json',
  },
];

export const CONFIG = {
  regions: REGIONS,

  // Satellite imagery used only on the (online) airfields page.
  mapMinZoom: 3,
  mapMaxZoom: 19,
  tileSize: 256,
  tileUrl: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  tileAttribution: 'Imagery \u00a9 Esri, Maxar, Earthstar Geographics',

  // How long a heading sample stays valid before we fall back.
  headingFreshMs: 2500,
  // Orientation sensor sampling rate (Hz).
  sensorFrequency: 60,
  // Minimum distance travelled (m) before the track-derived heading is used,
  // and the spacing at which positions are recorded into the track.
  trackMinMeters: 10,
  trackSampleMeters: 5,

  // Radius (metres) below which a screen tap counts as selecting an airfield.
  tapRadiusPx: 48,
  // Zoom is only driven by the target when the plane is within this angle of it.
  zoomAlignDeg: 60,
  // Screen fraction of the visible area the target should occupy when aligned.
  zoomTargetFraction: 0.72,
  // Fraction of the way to jump toward the fit when the target changes.
  zoomReframe: 0.6,
  minMpp: 0.3,
  maxMpp: 3000,
};
