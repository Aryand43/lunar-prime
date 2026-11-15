export function fmtDuration(s: number): string {
  if (s >= 2 * 86400) return `${(s / 86400).toFixed(1)} d`;
  if (s >= 2 * 3600) return `${(s / 3600).toFixed(1)} h`;
  if (s >= 120) return `${Math.round(s / 60)} min`;
  return `${Math.round(s)} s`;
}

export function fmtPct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

export function fmtDeg(x: number, digits = 2): string {
  return `${x.toFixed(digits)}°`;
}

/** "2026-12-01T00:30:00Z" -> "2026-12-01 00:30:00 UTC" */
export function fmtUtc(iso: string): string {
  return iso.replace("T", " ").replace("Z", "") + " UTC";
}

export function fmtLat(lat: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}`;
}

export function fmtLon(lon: number): string {
  return `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
}

export function compass(az: number): string {
  const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return pts[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}

/** Plotly treats date strings as naive; strip the Z and label axes as UTC. */
export function plotlyTime(iso: string): string {
  return iso.replace("Z", "");
}
