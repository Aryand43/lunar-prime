// Optional hypothetical south-polar demo network (Advanced > Custom waypoints). The default planner
// generates its own planning-waypoint corridors from any start position instead.
// Hypothetical south-polar demo network. These are NOT real or planned lunar bases: they are
// editable candidate waypoints arranged as three corridors (direct, east, west) toward the pole.
// Spacing is chosen so every neighbouring hop is < 55 km (the default leg limit), the direct
// start-to-pole distance (~121 km) is NOT a valid single leg, and the slowest corridor
// (~185 km at 3 km/h ~ 62 h) fits comfortably inside the 240 h horizon.

export interface BaseDraft {
  uid: string;
  id: string;
  label: string;
  lat: string;
  lon: string;
}

export const DEMO_START: BaseDraft = { uid: "start", id: "S", label: "Hypothetical start site", lat: "-86", lon: "0" };

export const SOUTH_POLE: BaseDraft = { uid: "dest", id: "south-pole", label: "Geographic south pole", lat: "-90", lon: "0" };

const wp = (id: string, lat: number, lon: number): BaseDraft => ({
  uid: `wp-${id}`,
  id,
  label: `Hypothetical waypoint ${id}`,
  lat: String(lat),
  lon: String(lon),
});

export const DEMO_WAYPOINTS: BaseDraft[] = [
  wp("C1", -87.3, 0),
  wp("C2", -88.6, 0),
  wp("E1", -86.4, 25),
  wp("E2", -87.4, 50),
  wp("E3", -88.7, 70),
  wp("W1", -86.4, -25),
  wp("W2", -87.4, -50),
  wp("W3", -88.7, -70),
];

export interface PlannerParams {
  departure: string; // YYYY-MM-DDTHH:mm, UTC
  horizonHours: string;
  speedKmh: string;
  maxLegKm: string;
  gridMinutes: number;
  maxWaitHours: string;
  wDistance: string;
  wDarkness: string;
  wEarth: string;
  distanceScaleKm: string;
  exposureScaleHours: string;
  localSearch: boolean;
  mode: "spice" | "synthetic";
  /** Generate planning-waypoint corridors automatically (default on). */
  autoNetwork: boolean;
  /** Add verified catalogue sites near the corridor as candidate positions. */
  includeCatalog: boolean;
  planningMode: "exact" | "coarse";
}

// 2027-02-13: subsolar latitude ~0 deg, so near-pole sunlight depends strongly on longitude.
export const DEMO_PARAMS: PlannerParams = {
  departure: "2027-02-13T00:00",
  horizonHours: "240",
  speedKmh: "3",
  maxLegKm: "55",
  gridMinutes: 30,
  maxWaitHours: "24",
  wDistance: "1",
  wDarkness: "1",
  wEarth: "0.5",
  distanceScaleKm: "100",
  exposureScaleHours: "24",
  localSearch: true,
  mode: "spice",
  autoNetwork: true,
  includeCatalog: false,
  planningMode: "exact",
};

export const GRID_OPTIONS = [10, 15, 30, 60, 120];
