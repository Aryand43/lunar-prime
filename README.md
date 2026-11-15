# Lunar Prime

Compare two lunar landing sites by **geometric sunlight** and **direct-to-Earth visibility** over a chosen UTC window. All geometry is computed on the backend with NASA/JPL NAIF SPICE. The comparison sentences are deterministic templates filled from the computed metrics; no language model writes them.

- Pick two sites on a 3D lunar globe (or choose presets, or type coordinates).
- Choose a UTC start, duration and sampling interval.
- Scrub through time. The globe is lit from the computed subsolar point, and a local-horizon sky plot shows the Sun and Earth for each site.
- Compare synchronized elevation timelines and refined visibility intervals, summary metrics, and plain-language findings.
- Read the method, limitations, kernel provenance (with SHA-256), and export the full result as JSON.
- **Route Planner tab:** plan a conceptual surface journey to the lunar south pole through optional candidate waypoints. Routes are optimized for distance, darkness exposure and Earth-invisible exposure. See [South Pole Route Planner](#south-pole-route-planner).

> **Scope.** "Visible" means the body's **centre** is above an **ideal, terrain-free horizon** (elevation > 0°). Sunlight is not electrical power. Earth visibility is not a guaranteed communication link. See [Limitations](#limitations).

## What's new (November 2026)

**Design refresh.** A light page with one font (Atkinson Hyperlegible Next). Colour is used only for the two bodies: yellow for the Sun, blue for Earth. The answer comes first: a two-sentence headline, the findings and a metrics table with bars, then the globe and sky plots, then the timelines.

**Time until the next change (U1).** Under each sky plot, one line per body says how long until it sets or rises at the scrubber time, for example "Sun sets in 4.2 d", with the UTC time of that event. When the change falls after the window ends, the line says so: "Earth stays up for at least 6.0 d (to the end of the window)". The times come from the refined rise and set intervals the API already returns, so they are as accurate as those intervals (±1 s refinement). A body that rises or sets more than once between two samples can still be missed, as before.

**Elevation up front, and libration stated (U2).** Each sky plot now starts with the current Sun and Earth elevations as two large figures; a body below the horizon is shown in grey with "below horizon". The Method section has a Libration row: libration is included, because Earth's motion in the lunar sky comes from the DE440 lunar orientation and orbit. That is why Earth rises and sets at sites near the limb and the poles.

**South-pole presets first (U3).** The preset list now has two groups. "South pole" comes first: IM-2 Athena at Mons Mouton, the Shackleton rim where it meets the de Gerlache ridge, a high-illumination point on the de Gerlache ridge, IM-1 Odysseus near Malapert A, Chandrayaan-3 at Statio Shiv Shakti, and the Shackleton crater floor. "Elsewhere on the Moon" holds Apollo 11, Apollo 17, Blue Ghost Mission 1, Chang'e 4, Mare Orientale and Peary. The first screen now compares IM-2 with the Shackleton rim. Each coordinate's source is noted in `frontend/src/lib/sites.ts`. The de Gerlache point was checked only against the Wikipedia table that cites Gläser et al. (2017), not against the paper itself. Limitation: the ridge and rim sites are exactly where terrain matters most, and this model uses a smooth sphere, so their sunlight numbers are geometric upper bounds, not predictions.

## Quick start

Prerequisites: [uv](https://docs.astral.sh/uv/) (it provisions Python 3.12), Node 20+.

```bash
./scripts/fetch_kernels.sh
```

```bash
cd backend && uv sync && uv run uvicorn app.main:app --port 8000
```

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:3000. Next.js proxies `/api/*` to the backend. Set `BACKEND_URL` if the backend is not at `http://127.0.0.1:8000`.

Tests:

```bash
cd backend && uv run pytest
```

```bash
cd frontend && npm run lint && npx tsc --noEmit && npm run build
```

## Architecture

```
scripts/fetch_kernels.sh   reproducible kernel download from naif.jpl.nasa.gov
backend/app/
  config.py      conventions, limits, kernel list (single source of truth, echoed in responses)
  kernels.py     load kernels once at startup, coverage window, SHA-256, global SPICE lock
  geometry.py    site vector, ENU basis, topocentric az/el; SPICE and synthetic providers
  analysis.py    visibility intervals, bisection refinement, gaps, intersections
  narrative.py   deterministic comparison statements with tolerances
  service.py     request orchestration
  models.py      typed Pydantic request/response contracts
  routing.py         route planner: spherical legs, exposure integration, time-expanded search, local refinement, baselines
  routing_models.py  typed /api/route contracts
  routing_service.py response assembly, baseline comparison, deterministic route explanation
  main.py        FastAPI: GET /api/health, POST /api/compare, POST /api/route
frontend/src/
  components/    LunarPrimeApp (tabs), MoonGlobe (R3F), Timelines (Plotly), HorizonView (SVG), Controls, Results, Scrubber,
                 RoutePlanner, RouteControls, RouteResults
  lib/           API types/client, presets, route demo network, formatting, frame mapping and great-circle arcs
```

No database, authentication, or chatbot.

## Scientific method

| Item | Convention |
|---|---|
| Reference frame | `MOON_ME`: Mean-Earth/polar-axis lunar body-fixed frame, realized as `MOON_ME_DE440_ME421` (a fixed rotation from the DE440 principal-axis frame). This is the LRO/LOLA cartographic frame. |
| Coordinates | Planetocentric latitude; **east-positive** longitude in (−180°, 180°]. |
| Lunar shape | Sphere, R = 1737.4 km (IAU mean radius, checked against `BODY301_RADII` at startup). Site altitude 0. |
| Aberration | `LT+S` (light time plus stellar aberration), applied to Moon-centred Sun/Earth vectors. |
| Topocentric | `r_topo = r_body(Moon-centred, MOON_ME) − r_site`, projected onto the site's East/North/Up basis. |
| Angles | Elevation = asin(U/|r|). Azimuth = atan2(E, N), clockwise from local north, in [0°, 360°). |
| Visibility | Body centre elevation > 0° above the ideal horizon. |
| Time | UTC in and out; TDB internally via `naif0012.tls`. |

**Sampling and refinement.** Elevations are sampled every `step_minutes`. Whenever visibility changes between two samples, the crossing time is refined by bisection on the true elevation function to ±1 s. Durations are sums of refined interval lengths, which is real elapsed time, not a count of samples. Events shorter than the sampling step can be missed, and the response reports both the step and the refinement tolerance.

**Window edges.** A gap that touches the start or end of the window is reported as a lower bound (`open_start` / `open_end`, shown as "≥" in the UI). The comparison text refuses to rank two gaps when the shorter one is only a lower bound.

### Validation

- **Independent cross-check.** Elevations are compared against SPICE's own constant-position az/el routine `azlcpo` (light time from the site itself; surface normal from the loaded PCK sphere). Over 5 sites × 2 bodies × 720 hourly epochs, the maximum |Δel| is **2.7 × 10⁻⁵°**. This check is a test (`tests/test_geometry.py`).
- **Physical sanity tests.**
  - The sub-Earth point stays within the libration bounds.
  - Earth stays above the horizon at Apollo 11 and never rises at Chang'e 4 (far side).
  - Apollo 11 gets about 50% sunlight over a lunation.
- **Sampling independence.** The sunrise time at 2-hour sampling agrees with 5-minute sampling to within 3 s.
- **Interval logic.** Tested against analytic sine crossings, irregular final samples, gaps, and intersections.

## Kernels

`scripts/fetch_kernels.sh` downloads these from `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/` into `backend/kernels/` (git-ignored, ~45 MB) and writes local SHA-256 sums. The backend loads them once at startup.

| File | Type | Purpose |
|---|---|---|
| `naif0012.tls` | LSK | Leap seconds, UTC ↔ TDB |
| `pck00011.tpc` | Text PCK | IAU constants, lunar radius |
| `moon_pa_de440_200625.bpc` | Binary PCK | High-accuracy lunar orientation (`MOON_PA_DE440`) |
| `moon_de440_250416.tf` | FK | Defines `MOON_PA` / `MOON_ME` for DE440 |
| `de440s.bsp` | SPK | Sun, Earth, and Moon ephemeris, 1849–2150 |

Usable window (intersection of SPK and PCK coverage, minus 1 day of margin at each end): about **1849-12-27 to 2150-01-20 UTC**. Requests outside it are rejected with a clear message.

If the kernels are missing, `/api/health` reports `degraded` with the exact fix, and `/api/compare` in SPICE mode returns `503 spice_unavailable`. There is a **synthetic demo mode**, but only if you select it explicitly. It uses a crude analytic model for UI development. Every response, the header badge, and a banner label it as *not SPICE and not NASA data*. It never replaces SPICE silently.

## API

`POST /api/compare`

```json
{
  "sites": [
    {"id": "A", "label": "Apollo 11", "lat_deg": 0.6741, "lon_deg": 23.473},
    {"id": "B", "label": "Shackleton", "lat_deg": -89.67, "lon_deg": 129.78}
  ],
  "start_utc": "2026-12-01T00:00:00Z",
  "duration_hours": 708.7,
  "step_minutes": 30,
  "mode": "spice"
}
```

The response contains:

- `timestamps_utc`, `elapsed_s`
- per site:
  - `sun` / `earth` `{az_deg, el_deg}`
  - `masks` (sample-wise `sun` / `earth` / `both`)
  - refined `intervals`
  - `metrics`: visible duration and fraction, longest visible interval, longest gap with window-edge flags, elevation range, near-horizon fraction, and duration/fraction with both visible
- `subpoints`: subsolar and sub-Earth latitude/longitude, Earth distance
- `comparison`: `headline`, typed `statements` (comparison / observation / caveat), and the reporting `tolerance_s`
- `metadata`: mode, provenance, conventions, limitations, kernels with SHA-256, toolkit version, sampling, refinement count, compute time

The full schema is at http://localhost:8000/docs.

**Validation:**

- latitude must be in [−90, 90] and longitude in [−180, 360] (normalized)
- `start_utc` must be timezone-aware UTC
- 1 h ≤ duration ≤ 366 d; 1 min ≤ step ≤ 24 h
- at most **20,000 samples**
- the two site ids must differ
- the window must be within kernel coverage

Errors return `{"error": {"code", "message", "details": [{field, message}]}}` with HTTP 422, 503, or 500.

## Limitations

These are not modelled. Each one is also listed in every response and in the UI.

- **Terrain.** Crater walls and ridges are ignored. At polar sites terrain dominates real illumination. For example, the "Shackleton crater floor" preset uses the crater centre, whose real floor is permanently shadowed, and the ridge and rim presets depend on local heights the model does not have. The "near horizon" metric flags results that terrain could overturn.
- **Finite discs.** The Sun's ~0.27° and Earth's ~0.95° angular radii are not modelled. Visibility is judged by the centre only.
- **Eclipses.** Earth occultation of the Sun is not modelled.
- **Power.** No panel geometry, efficiency, dust, or thermal effects.
- **Communications.** No antenna pointing, link budget, ground stations, or relays.
- **Overall ranking.** There is no universal "best site". Findings compare single criteria within the chosen window only.
- **Route Planner.** Route-specific limitations are listed under [Planner limitations](#planner-limitations).

## South Pole Route Planner

> **Conceptual spherical-surface route. Terrain, slopes, obstacles, battery/thermal limits, and communication link budgets are not modelled.**

Open the **Route Planner** tab. It runs the demo network on load. To plan your own route:

1. Edit the start and destination. The destination defaults to the geographic south pole (−90°, 0°).
2. Edit the candidate waypoints: change their coordinates, add or remove them, or place them on the globe with ⌖.
3. Set the departure (UTC), horizon, speed, maximum leg, time grid, per-stop waiting limit, and the objective weights.
4. Press **Optimize route**.

On the polar close-up globe:

- the optimized path is a teal line of great-circle arcs, and visited waypoints are numbered
- the shortest-distance baseline is a toggleable dashed line
- candidate legs are faint lines
- the destination is marked in red

Playback moves a marker along the returned trajectory. The UTC time, solar lighting and the Sun/Earth elevation chart stay in sync with it. The results show:

- the itinerary, including waits and grid-alignment waits
- per-segment distance and exposure
- optimized vs baseline metrics, with absolute differences, and percentages only when the baseline value is non-zero
- a number-only explanation
- method, limitations and provenance, plus JSON export

### Demo network (hypothetical)

The waypoints are **hypothetical candidate locations**, not real or planned bases, and every coordinate can be edited. They form three corridors from a start at (−86°, 0°E) toward the pole:

- direct: C1, C2
- east: E1–E3
- west: W1–W3

Defaults: speed 3 km/h, maximum leg 55 km, horizon 240 h, grid 30 min, wait limit 24 h per stop. These are mutually consistent:

- Every neighbouring hop is under 55 km.
- The direct start-to-pole distance (121.3 km) is **not** a valid single leg, so it shows as an infeasible direct baseline.
- The longest corridor (≈185 km ≈ 62 h at 3 km/h) fits easily in the horizon.

The default departure is **2027-02-13 00:00 UTC**. At that time the subsolar latitude is ≈0°, so sunlight near the pole depends strongly on which side of the pole you are on. With weights (distance 1, darkness 1, Earth-invisible 0.5), the SPICE result takes the east corridor S→E1→E2→E3→pole. Compared with the shortest-distance route S→C1→C2→pole, it is **63.6 km longer** but has **29.2 h less darkness** (cost 2.148 vs 2.730).

### Objective and units

```
cost = w_distance        * total_distance_km           / distance_scale_km      (default 100 km)
     + w_darkness        * total_darkness_hours        / exposure_scale_hours   (default 24 h)
     + w_earth_invisible * total_earth_invisible_hours / exposure_scale_hours
```

- Darkness means Sun centre elevation ≤ 0°. Earth-invisible means Earth centre elevation ≤ 0°.
- Both are integrated over moving **and** waiting time, in elapsed seconds.
- The scales are fixed for the request and reported in the response, so every candidate route and the baseline share them.
- Weights must be ≥ 0, and not all zero.
- Ties are broken by earliest arrival, then by the stable ordering of base sequences.

### Geometry, exposure and time discretization

**Geometry**

- Bases are MOON_ME unit vectors on a sphere with R = `config.MOON_RADIUS_KM`, using planetocentric latitude and east-positive longitude.
- Distance is `R·atan2(|a×b|, a·b)`, which is robust for tiny and large separations and handles longitude wraparound.
- Positions along a leg come from SLERP and are renormalized onto the sphere.
- The poles map to one exact point, so (−90°, 0°) and (−90°, 45°) are rejected as duplicate locations.
- A leg within 10⁻³ rad of antipodal is rejected with an explicit error instead of producing NaNs. The maximum leg is capped at 0.9·πR.

**Exposure**

- The Sun and Earth are evaluated at the **actual position and time** along every leg: every ≤10 min (`sampling_minutes`), plus the exact partial final sample.
- Waits are evaluated at the base's fixed coordinates.
- Elevation crossings are interpolated linearly inside each sample interval. Events shorter than the sampling step can be missed.
- Sun/Earth vectors come from an exact SPICE table at the sampling step and are linearly interpolated between epochs. A test checks this against exact SPICE: the elevation error is < 10⁻³°.

**Time**

- Movement time = distance / speed.
- The graph search departs only on the time grid.
- Arrival at an intermediate base is rounded up to the next grid time. The remainder is modelled as **alignment waiting** at that base: it counts in elapsed time, in exposure, and toward the waiting limit, and is reported separately.
- Arrival at the destination ends the journey at the exact arrival time.
- There is no teleporting, no dropped time, and no zero-time cycles.

### Search method and optimality scope

1. **Exact label-setting dynamic programming over a time-expanded graph.**
   - A state is (base, time index, dwell used at the current visit).
   - Wait edges advance one grid step, within the per-stop waiting limit.
   - Travel edges use every feasible leg (≤ max leg) at every grid departure.
   - Labels keep a Pareto front over (cost, dwell used), so the per-visit waiting limit is enforced exactly.
   - The result is optimal only over that grid, that candidate network, and this sampled exposure model.
2. **Bounded continuous-time local refinement.**
   - The moves are: remove a stop, replace a stop with another candidate, and shift a departure by ±1, 2, 4 or 8 sampling steps.
   - These itineraries are not representable on the grid (no alignment waiting), so this is a genuinely different search space, not a redundant pass over the same one.
   - It starts from both the graph optimum and the shortest-distance baseline, re-evaluates downstream timing and feasibility for every proposal, and accepts only strict improvements.
   - It is capped at 4,000 evaluations.
   - The response lists every accepted move and the selected seed. The final route is **locally improved, not globally optimal**.
3. **Baselines.**
   - The shortest-distance network route (Dijkstra under the same leg limit) departs immediately and is evaluated with the identical evaluator: same speed, departure, sampling and Sun/Earth model.
   - The direct great circle is evaluated when it is within the leg limit. Otherwise it is marked infeasible, not compared.

If no route satisfies the constraints, the response is a normal `200` with `status: "infeasible"` and a specific reason (unreachable network, horizon too short, or waiting limits). No route is invented.

### `POST /api/route`

```json
{
  "start": {"id": "S", "label": "Hypothetical start site", "lat_deg": -86, "lon_deg": 0},
  "destination": {"id": "south-pole", "label": "Geographic south pole", "lat_deg": -90, "lon_deg": 0},
  "waypoints": [{"id": "E1", "label": "Hypothetical waypoint E1", "lat_deg": -86.4, "lon_deg": 25}],
  "departure_utc": "2027-02-13T00:00:00Z",
  "horizon_hours": 240, "speed_kmh": 3, "max_leg_km": 55, "grid_minutes": 30, "max_wait_hours": 24,
  "weights": {"distance": 1, "darkness": 1, "earth_invisible": 0.5},
  "distance_scale_km": 100, "exposure_scale_hours": 24, "local_search": true, "mode": "spice"
}
```

The response (abridged):

```json
{
  "status": "feasible", "reason": null,
  "bases": [...], "candidate_legs": [{"from_id": "S", "to_id": "C1", "distance_km": 39.42}, ...],
  "route": {
    "visited": ["S", "E1", "E2", "E3", "south-pole"],
    "stops": [{"order": 1, "base_id": "E1", "arrive_utc": "2027-02-13T17:04:39Z", "depart_utc": "2027-02-13T17:10:00Z",
               "wait_s": 320.6, "alignment_wait_s": 0.0}, ...],
    "legs": [{"from_id": "S", "to_id": "E1", "distance_km": 51.233, "movement_s": 61479.4, "darkness_s": 20983.4, ...}, ...],
    "segments": [...],
    "metrics": {"distance_km": 184.877, "elapsed_s": 222504.4, "movement_s": 221852.4, "waiting_s": 652.0,
                "darkness_s": 25850.3, "earth_invisible_s": 0.0, "both_visible_s": 196654.1, "longest_darkness_s": 20983.4,
                "cost": {"distance": 1.849, "darkness": 0.299, "earth_invisible": 0.0, "total": 2.148}},
    "trajectory": {"time_utc": [...], "lat_deg": [...], "lon_deg": [...], "sun_el_deg": [...], "earth_el_deg": [...],
                   "status": ["move", "wait", ...], "subsolar_lat_deg": [...], ...}
  },
  "baseline": {"name": "Shortest-distance network route", "feasible": true, "plan": {...}},
  "direct": {"name": "Direct great circle", "feasible": false, "reason": "Direct great-circle distance 121.3 km exceeds ..."},
  "comparison": [{"metric": "Darkness exposure", "unit": "h", "optimized": 7.180639, "baseline": 36.406944,
                  "difference": -29.226306, "percent_change": -80.277, "lower_is_better": true}, ...],
  "explanation": ["The selected route visits 3 intermediate bases (E1, E2, E3), ..."],
  "objective": {"formula": "...", "weights": {...}, "distance_scale_km": 100, "exposure_scale_hours": 24},
  "search": {"method": "...", "optimality_scope": "...", "grid_minutes": 30, "sampling_minutes": 10,
             "n_time_steps": 480, "n_states_expanded": ..., "n_labels": ..., "local_search": {...}, "compute_time_ms": ...},
  "metadata": {"mode": "spice", "provenance": "...", "disclaimer": "Conceptual spherical-surface route. ...",
               "conventions": {...}, "limitations": [...], "kernels": [...]}
}
```

Errors follow the `/api/compare` conventions:

- **422** for malformed or unsupported input. This includes non-finite numbers, duplicate base ids, coincident bases, non-UTC times, all-zero weights, a window outside kernel coverage, and exceeded computational limits.
- **503** when SPICE is requested but unavailable. There is never a silent synthetic fallback.
- Explicit `"mode": "synthetic"` works without kernels, and every result is labelled as *not SPICE and not NASA data*.

### Computational limits

These are checked **before** any ephemeris call or large allocation (`config.py`):

| Limit | Value |
|---|---|
| Bases (start + destination + waypoints) | 40 |
| Time-grid steps | 3,000 |
| Time-expanded states (bases × steps) | 80,000 |
| Estimated elevation samples over all edges | 25,000,000 |
| Exact ephemeris epochs | 20,000 |
| Returned trajectory points | 12,000 |
| Search labels | 600,000 |
| Local-search evaluations | 4,000 |

The demo solves in about 1 s. SPICE is called once per request to build the ephemeris table, under a single acquisition of the global `SPICE_LOCK`. The routing code never takes the lock itself.

### Planner limitations

- The surface is an ideal sphere. There is no terrain, no slopes, no obstacles, and no crater avoidance. Nothing is inferred from the globe texture.
- Travel is constant speed along great circles. There are no vehicle dynamics, battery, thermal, charging or rest models.
- Sun/Earth visibility uses body centres on an ideal horizon. There are no finite discs, terrain shadows or eclipses. Sunlight is not power, and Earth visibility is not a communication link (no link budgets or relays).
- Waypoints are hypothetical.
- Optimality is bounded by the time grid, the candidate network, the sampling resolution, and a local continuous-time refinement. The result is not a globally optimal continuous route and not a certified safe route.
- Revisiting a base is allowed in the graph search, as physically legitimate waiting/back-tracking. Routes are reported as the sequence actually travelled.

## Credits

- Ephemerides and orientation: NASA/JPL NAIF generic kernels.
- Globe basemap: NASA Scientific Visualization Studio *CGI Moon Kit*: LRO LROC WAC colour mosaic and LOLA elevation (public domain), in `frontend/public/textures/`.
