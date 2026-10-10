// Geodesy helpers. Distances use a spherical earth; good enough for a
// hand-held moving map over a single island.

export const R_EARTH = 6371000;

export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;

export function normalizeDeg(d) {
  return ((d % 360) + 360) % 360;
}

// Smallest signed difference a-b in (-180, 180].
export function signedAngleDiff(a, b) {
  let d = normalizeDeg(a - b);
  if (d > 180) d -= 360;
  return d;
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Initial bearing from point 1 to point 2, degrees clockwise from north.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

// Local east/north offset (metres) of (lat,lon) from (lat0,lon0).
export function toENU(lat, lon, lat0, lon0) {
  return {
    e: toRad(lon - lon0) * R_EARTH * Math.cos(toRad(lat0)),
    n: toRad(lat - lat0) * R_EARTH,
  };
}

// Best-fit direction of travel over a chronological track. Uses total least
// squares (principal axis) and resolves the sign against net displacement.
export function pathLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceMeters(
      points[i - 1].lat,
      points[i - 1].lon,
      points[i].lat,
      points[i].lon
    );
  }
  return total;
}

export function bestFitHeading(points) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const pts = points.map((p) => toENU(p.lat, p.lon, last.lat, last.lon));

  let me = 0;
  let mn = 0;
  for (const p of pts) {
    me += p.e;
    mn += p.n;
  }
  me /= pts.length;
  mn /= pts.length;

  let see = 0;
  let snn = 0;
  let sen = 0;
  for (const p of pts) {
    const de = p.e - me;
    const dn = p.n - mn;
    see += de * de;
    snn += dn * dn;
    sen += de * dn;
  }

  const theta = 0.5 * Math.atan2(2 * sen, see - snn);
  let e = Math.cos(theta);
  let n = Math.sin(theta);

  const first = pts[0];
  const end = pts[pts.length - 1];
  const de = end.e - first.e;
  const dn = end.n - first.n;
  if (e * de + n * dn < 0) {
    e = -e;
    n = -n;
  }
  return normalizeDeg(toDeg(Math.atan2(e, n)));
}

function closestOnSegment(p, a, b) {
  const abx = b.e - a.e;
  const aby = b.n - a.n;
  const len2 = abx * abx + aby * aby;
  let t = len2 ? ((p.e - a.e) * abx + (p.n - a.n) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { e: a.e + t * abx, n: a.n + t * aby };
}

// Nearest point on a closed pattern polygon to the plane. Returns an ENU
// offset (metres) plus its distance and bearing.
export function nearestOnPattern(planeLat, planeLon, pattern) {
  if (!pattern || pattern.length < 2) return null;
  const verts = pattern.map((p) => toENU(p.lat, p.lon, planeLat, planeLon));
  let best = null;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const c = closestOnSegment({ e: 0, n: 0 }, a, b);
    const d = Math.hypot(c.e, c.n);
    if (!best || d < best.distance) {
      best = { east: c.e, north: c.n, distance: d };
    }
  }
  if (best) {
    best.bearing = normalizeDeg(toDeg(Math.atan2(best.east, best.north)));
  }
  return best;
}
