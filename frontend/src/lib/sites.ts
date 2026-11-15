export interface SitePreset {
  key: string;
  label: string;
  lat: number;
  lon: number;
  note: string;
}

// Coordinates are approximate published values (planetocentric, east-positive).
// They are demo starting points, not surveyed landing ellipses.
export const PRESETS: SitePreset[] = [
  { key: "apollo11", label: "Apollo 11, Tranquility Base", lat: 0.6741, lon: 23.473, note: "Near-side equatorial mare." },
  { key: "apollo17", label: "Apollo 17, Taurus–Littrow", lat: 20.1908, lon: 30.7717, note: "Near-side valley; terrain walls ignored." },
  {
    key: "shackleton",
    label: "Shackleton crater, centre",
    lat: -89.67,
    lon: 129.78,
    note: "South pole. Ideal-horizon model: the real crater floor is permanently shadowed by its walls.",
  },
  { key: "peary", label: "Peary crater, north pole", lat: 88.6, lon: 33.0, note: "North polar region; terrain ignored." },
  { key: "orientale", label: "Mare Orientale, western limb", lat: -19.4, lon: -92.8, note: "Near the limb: Earth rises and sets with libration." },
  { key: "change4", label: "Chang'e 4, von Kármán (far side)", lat: -45.4446, lon: 177.5991, note: "Far side: no direct line of sight to Earth." },
];

export const DEFAULT_SITES = ["apollo11", "shackleton"] as const;
