export type PresetGroup = "South pole" | "Elsewhere on the Moon";

export interface SitePreset {
  key: string;
  label: string;
  lat: number;
  lon: number;
  note: string;
  group: PresetGroup;
  /** True when backend/data/horizons/<key>.json holds a LOLA terrain skyline for this preset. */
  terrain?: boolean;
}

export const PRESET_GROUPS: PresetGroup[] = ["South pole", "Elsewhere on the Moon"];

// Labels: 30 characters or fewer so they fit the preset menu; put any detail in the note.
// Coordinates are published values (planetocentric latitude, east-positive longitude).
// They are demo starting points, not surveyed landing ellipses. Sources are noted per preset
// so they can be re-checked; values were last checked on 15 Nov 2026.
export const PRESETS: SitePreset[] = [
  // ----- South pole -----
  {
    // LROC featured image 1408 "IM-2 Athena Seen Obliquely": 84.7906°S, 29.1957°E (where it came to rest).
    // LROC image 1401 gives the intended site as -84.78, 29.13.
    key: "im2", terrain: true,
    label: "IM-2 Athena, Mons Mouton",
    lat: -84.7906,
    lon: 29.1957,
    note: "Where Intuitive Machines' Athena lander touched down in March 2025, on a plateau about 160 km from the south pole.",
    group: "South pole",
  },
  {
    // LROC featured image 1247 "Traversing the Shackleton de Gerlache Ridge": 89.684°S, 196.739°E (= -163.261°E).
    key: "shackleton-rim", terrain: true,
    label: "Shackleton rim, ridge junction",
    lat: -89.684,
    lon: -163.261,
    note: "Real sunlight here depends on the ridge height, so this site uses the LOLA terrain skyline.",
    group: "South pole",
  },
  {
    // Gläser et al. 2017 (Planetary and Space Science 162, 170-178), point C, as tabulated on Wikipedia
    // "Peak of eternal light": 88.71°S, 68.7°W. Checked against that table only; the paper itself was not
    // accessible when this was written. Re-check against the paper before relying on it.
    key: "degerlache-ridge", terrain: true,
    label: "de Gerlache ridge, sunlit point",
    lat: -88.71,
    lon: -68.7,
    note: "Real sunlight here depends on the ridge height, so this site uses the LOLA terrain skyline.",
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
    label: "Chandrayaan-3, Shiv Shakti",
    lat: -69.373,
    lon: 32.319,
    note: "Where India's Chandrayaan-3 lander touched down in August 2023, about 600 km from the south pole.",
    group: "South pole",
  },
  {
    key: "shackleton", terrain: true,
    label: "Shackleton crater floor",
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
    label: "Blue Ghost 1, Mare Crisium",
    lat: 18.56,
    lon: 61.81,
    note: "Where Firefly's Blue Ghost lander touched down in March 2025, on the lava plains of Mare Crisium.",
    group: "Elsewhere on the Moon",
  },
  {
    // Lunar Vertex team, "Selection and characterization of the landing site for NASA CLPS PRISM1 lunar lander
    // mission CP-11" (Blewett et al., LPSC 2023, abstract 1780, NASA NTRS 20230000531): 7.585 N, 58.725 W.
    key: "im3",
    label: "IM-3 (planned), Reiner Gamma",
    lat: 7.585,
    lon: -58.725,
    note: "The planned landing site of Intuitive Machines' IM-3 mission, inside the Reiner Gamma lunar swirl.",
    group: "Elsewhere on the Moon",
  },
  { key: "change4", label: "Chang'e 4, von Kármán", lat: -45.4446, lon: 177.5991, note: "Far side: no direct line of sight to Earth.", group: "Elsewhere on the Moon" },
  { key: "orientale", label: "Mare Orientale, western limb", lat: -19.4, lon: -92.8, note: "Near the limb: Earth rises and sets with libration.", group: "Elsewhere on the Moon" },
  { key: "peary", label: "Peary crater, north pole", lat: 88.6, lon: 33.0, note: "North polar region; terrain ignored.", group: "Elsewhere on the Moon" },
];

// The first screen compares the Shackleton rim with IM-2's landing site. Both have LOLA terrain skylines,
// so the rim's real advantage (height above the surrounding terrain) shows up.
export const DEFAULT_SITES = ["shackleton-rim", "im2"] as const;
