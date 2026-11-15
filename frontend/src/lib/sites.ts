export type PresetGroup = "South pole" | "Elsewhere on the Moon";

export interface SitePreset {
  key: string;
  label: string;
  lat: number;
  lon: number;
  note: string;
  group: PresetGroup;
}

export const PRESET_GROUPS: PresetGroup[] = ["South pole", "Elsewhere on the Moon"];

// Coordinates are published values (planetocentric latitude, east-positive longitude).
// They are demo starting points, not surveyed landing ellipses. Sources are noted per preset
// so they can be re-checked; values were last checked on 15 Nov 2026.
export const PRESETS: SitePreset[] = [
  // ----- South pole -----
  {
    // LROC featured image 1408 "IM-2 Athena Seen Obliquely": 84.7906°S, 29.1957°E (where it came to rest).
    // LROC image 1401 gives the intended site as -84.78, 29.13.
    key: "im2",
    label: "IM-2 Athena, Mons Mouton",
    lat: -84.7906,
    lon: 29.1957,
    note: "Where Intuitive Machines' Athena lander touched down in March 2025, on a plateau about 160 km from the south pole.",
    group: "South pole",
  },
  {
    // LROC featured image 1247 "Traversing the Shackleton de Gerlache Ridge": 89.684°S, 196.739°E (= -163.261°E).
    key: "shackleton-rim",
    label: "Shackleton rim at the ridge junction",
    lat: -89.684,
    lon: -163.261,
    note: "Real sunlight here depends on the ridge height. This model uses a smooth sphere.",
    group: "South pole",
  },
  {
    // Gläser et al. 2017 (Planetary and Space Science 162, 170-178), point C, as tabulated on Wikipedia
    // "Peak of eternal light": 88.71°S, 68.7°W. Checked against that table only; the paper itself was not
    // accessible when this was written. Re-check against the paper before relying on it.
    key: "degerlache-ridge",
    label: "de Gerlache ridge, high-illumination point",
    lat: -88.71,
    lon: -68.7,
    note: "Real sunlight here depends on the ridge height. This model uses a smooth sphere.",
    group: "South pole",
  },
  {
    // NASA "NASA's LRO Images Intuitive Machines' Odysseus Lander" (Feb 2024): 80.13°S, 1.44°E.
    key: "im1",
    label: "IM-1 Odysseus, Malapert A",
    lat: -80.13,
    lon: 1.44,
    note: "Where Intuitive Machines' Odysseus lander touched down in February 2024, on a sloping site near Malapert A crater.",
    group: "South pole",
  },
  {
    // USGS Gazetteer of Planetary Nomenclature, "Statio Shiv Shakti": 69.373°S, 32.319°E.
    key: "chandrayaan3",
    label: "Chandrayaan-3, Statio Shiv Shakti",
    lat: -69.373,
    lon: 32.319,
    note: "Where India's Chandrayaan-3 lander touched down in August 2023, about 600 km from the south pole.",
    group: "South pole",
  },
  {
    key: "shackleton",
    label: "Shackleton crater floor (permanently shadowed in reality)",
    lat: -89.67,
    lon: 129.78,
    note: "The centre of Shackleton crater. On a smooth sphere it gets sunlight, but the real floor is permanently shadowed by the crater walls.",
    group: "South pole",
  },
  // ----- Elsewhere on the Moon -----
  { key: "apollo11", label: "Apollo 11, Tranquility Base", lat: 0.6741, lon: 23.473, note: "Near-side equatorial mare.", group: "Elsewhere on the Moon" },
  { key: "apollo17", label: "Apollo 17, Taurus–Littrow", lat: 20.1908, lon: 30.7717, note: "Near-side valley; terrain walls ignored.", group: "Elsewhere on the Moon" },
  {
    // LROC featured image 1400 "Firefly Blue Ghost Landing Region": 18.56°N, 61.81°E
    // (LROC image 1407 locates the lander at 18.5623°N, 61.8103°E).
    key: "blueghost1",
    label: "Blue Ghost Mission 1, Mare Crisium",
    lat: 18.56,
    lon: 61.81,
    note: "Where Firefly's Blue Ghost lander touched down in March 2025, on the lava plains of Mare Crisium.",
    group: "Elsewhere on the Moon",
  },
  { key: "change4", label: "Chang'e 4, von Kármán (far side)", lat: -45.4446, lon: 177.5991, note: "Far side: no direct line of sight to Earth.", group: "Elsewhere on the Moon" },
  { key: "orientale", label: "Mare Orientale, western limb", lat: -19.4, lon: -92.8, note: "Near the limb: Earth rises and sets with libration.", group: "Elsewhere on the Moon" },
  { key: "peary", label: "Peary crater, north pole", lat: 88.6, lon: 33.0, note: "North polar region; terrain ignored.", group: "Elsewhere on the Moon" },
];

// The first screen compares two real CLPS landings at the south pole (the brief's focus).
// The ridge and rim presets stay in the menu, but are not the default: their real sunlight depends on
// terrain height, which the smooth-sphere model cannot show.
export const DEFAULT_SITES = ["im2", "im1"] as const;
