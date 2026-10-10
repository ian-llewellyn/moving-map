// Shared configuration. Kept dependency-free so every page can import it.

export const CONFIG = {
  // Static villages/towns/cities dataset (built by tools/fetch_towns.py).
  townDataUrl: 'data/towns.json',

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
  minMpp: 0.3,
  maxMpp: 3000,
};
