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
