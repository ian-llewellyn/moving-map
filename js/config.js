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

  // Radius (metres) below which a screen tap counts as selecting an airfield.
  tapRadiusPx: 48,
  // Zoom is only driven by the target when the plane is within this angle of it.
  zoomAlignDeg: 60,
  // Screen fraction of the visible area the target should occupy when aligned.
  zoomTargetFraction: 0.72,
  minMpp: 0.3,
  maxMpp: 3000,
};
