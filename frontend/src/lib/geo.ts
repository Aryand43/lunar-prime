// MOON_ME (x toward mean sub-Earth point, z north) -> three.js world (y up).
// Chosen so that the standard equirectangular texture on THREE.SphereGeometry lines up:
// three = (x_me, z_me, -y_me).
export function latLonToVec3(latDeg: number, lonDeg: number, r = 1): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const x = Math.cos(lat) * Math.cos(lon);
  const y = Math.cos(lat) * Math.sin(lon);
  const z = Math.sin(lat);
  return [r * x, r * z, -r * y];
}

export function vec3ToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const xm = x;
  const ym = -z;
  const zm = y;
  const r = Math.hypot(xm, ym, zm);
  return { lat: (Math.asin(zm / r) * 180) / Math.PI, lon: (Math.atan2(ym, xm) * 180) / Math.PI };
}

function toUnit(latDeg: number, lonDeg: number): [number, number, number] {
  if (Math.abs(latDeg) >= 90) return [0, 0, Math.sign(latDeg)];
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

/**
 * Points along the minor great-circle arc (SLERP in MOON_ME), returned in three.js world
 * coordinates at radius r using the same mapping as latLonToVec3.
 */
export function greatCircleArc(a: [number, number], b: [number, number], r = 1.002, n = 64): [number, number, number][] {
  const u = toUnit(a[0], a[1]);
  const v = toUnit(b[0], b[1]);
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  const om = Math.acos(dot);
  const out: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    let p: [number, number, number];
    if (om < 1e-9) p = u;
    else {
      const s = Math.sin(om);
      const ka = Math.sin((1 - f) * om) / s;
      const kb = Math.sin(f * om) / s;
      p = [ka * u[0] + kb * v[0], ka * u[1] + kb * v[1], ka * u[2] + kb * v[2]];
    }
    const len = Math.hypot(p[0], p[1], p[2]);
    out.push([(r * p[0]) / len, (r * p[2]) / len, (-r * p[1]) / len]);
  }
  return out;
}
