// Coordinate entry for "start anywhere on the Moon".
//
// Convention (matches the backend): planetocentric latitude, east-positive longitude.
// Order is always LATITUDE FIRST, then LONGITUDE. Values keep full precision internally; rounding is
// only applied when formatting for display.

export interface LatLon {
  lat: number;
  lon: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Map any longitude to (-180, 180]. */
export function normalizeLon(lon: number): number {
  let x = ((lon % 360) + 360) % 360; // [0, 360)
  if (x > 180) x -= 360;
  return x === -180 ? 180 : x;
}

const HEM: Record<string, "lat" | "lon"> = { N: "lat", S: "lat", E: "lon", W: "lon" };

interface Token {
  value: number;
  hem: "N" | "S" | "E" | "W" | null;
  signed: boolean;
}

function tokenize(text: string): Parsed<Token[]> {
  const cleaned = text.replace(/[°º˚]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: false, error: "Enter coordinates." };
  const re = /([NSEW])?\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([NSEW])?/gi;
  const out: Token[] = [];
  for (const m of cleaned.matchAll(re)) {
    if (!m[0].trim()) continue;
    const pre = m[1]?.toUpperCase() as Token["hem"] | undefined;
    const post = m[3]?.toUpperCase() as Token["hem"] | undefined;
    if (pre && post) return { ok: false, error: "Use one hemisphere letter per value." };
    const v = Number(m[2]);
    if (!Number.isFinite(v)) return { ok: false, error: "Coordinates must be finite numbers." };
    out.push({ value: v, hem: pre ?? post ?? null, signed: /^[+-]/.test(m[2]) });
  }
  const leftover = cleaned.replace(re, "").replace(/[,;\s]/g, "");
  if (leftover) return { ok: false, error: `Unrecognised text: “${leftover.slice(0, 12)}”.` };
  if (!out.length) return { ok: false, error: "Enter coordinates." };
  return { ok: true, value: out };
}

function applyHem(t: Token, axis: "lat" | "lon"): Parsed<number> {
  if (t.hem) {
    if (HEM[t.hem] !== axis) return { ok: false, error: axis === "lat" ? "Latitude takes N or S." : "Longitude takes E or W." };
    if (t.signed && t.value < 0) return { ok: false, error: "Use either a minus sign or a hemisphere letter, not both." };
    const mag = Math.abs(t.value);
    if (axis === "lat" && mag > 90) return { ok: false, error: "Latitude must be at most 90°." };
    if (axis === "lon" && mag > 180) return { ok: false, error: "Longitude with E/W must be at most 180°." };
    const v = t.hem === "S" || t.hem === "W" ? -mag : mag;
    return { ok: true, value: axis === "lon" ? normalizeLon(v) : v };
  }
  if (axis === "lat") {
    if (t.value < -90 || t.value > 90) return { ok: false, error: "Latitude must be between −90° and 90°." };
    return { ok: true, value: t.value };
  }
  if (t.value < -180 || t.value > 360) return { ok: false, error: "Longitude must be between −180° and 360° (east positive)." };
  return { ok: true, value: normalizeLon(t.value) };
}

/** Parse a single latitude or longitude ("86.2 S", "-86.2", "S86.2", "35.4°E"). */
export function parseAngle(text: string, axis: "lat" | "lon"): Parsed<number> {
  const t = tokenize(text);
  if (!t.ok) return t;
  if (t.value.length !== 1) return { ok: false, error: "Enter a single value." };
  return applyHem(t.value[0], axis);
}

/**
 * Parse a pasted pair. Without letters the order is latitude, longitude ("-86.2, 35.4").
 * With letters either order is accepted ("35.4E 86.2S"). Ambiguous input is rejected.
 */
export function parsePair(text: string): Parsed<LatLon> {
  const t = tokenize(text);
  if (!t.ok) return t;
  if (t.value.length !== 2) return { ok: false, error: "Paste two values: latitude, longitude." };
  let [a, b] = t.value;
  if (a.hem && b.hem) {
    if (HEM[a.hem] === HEM[b.hem]) return { ok: false, error: "Give one latitude (N/S) and one longitude (E/W)." };
    if (HEM[a.hem] === "lon") [a, b] = [b, a];
  } else if (a.hem || b.hem) {
    const lettered = a.hem ? a : b;
    if ((lettered === a && HEM[a.hem!] === "lon") || (lettered === b && HEM[b.hem!] === "lat"))
      return { ok: false, error: "Ambiguous order: use latitude first, or add letters to both values." };
  } else if (Math.abs(a.value) > 90 && Math.abs(b.value) <= 90) {
    return { ok: false, error: "The first value exceeds 90°: enter latitude first, then longitude." };
  }
  const lat = applyHem(a, "lat");
  if (!lat.ok) return lat;
  const lon = applyHem(b, "lon");
  if (!lon.ok) return lon;
  return { ok: true, value: { lat: lat.value, lon: lon.value } };
}

export function fmtLatLon(p: LatLon, digits = 4): string {
  const lat = `${Math.abs(p.lat).toFixed(digits)}° ${p.lat >= 0 ? "N" : "S"}`;
  const lon = Math.abs(p.lat) >= 90 ? "any lon." : `${Math.abs(p.lon).toFixed(digits)}° ${p.lon >= 0 ? "E" : "W"}`;
  return `${lat}, ${lon}`;
}

/** Magnitude string for an input field (more digits than the readout, trailing zeros trimmed). */
export function magString(v: number, digits = 6): string {
  return String(Number(Math.abs(v).toFixed(digits)));
}
