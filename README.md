# Lunar Prime

Compare two lunar landing sites by **geometric sunlight** and **direct-to-Earth visibility** over a chosen UTC window. All geometry is computed on the backend with NASA/JPL NAIF SPICE. The comparison sentences are deterministic templates filled from the computed metrics; no language model writes them.

- Pick two sites on a 3D lunar globe (or choose presets, or type coordinates).
- Choose a UTC start, duration and sampling interval.
- Scrub through time. The globe is lit from the computed subsolar point, and a local-horizon sky plot shows the Sun and Earth for each site.
- Compare synchronized elevation timelines and refined visibility intervals, summary metrics, and plain-language findings.
- Read the method, limitations, kernel provenance (with SHA-256), and export the full result as JSON.
- **Site Navigator (default tab):** compare up to four scenarios (landing site + start date) side by side. Scorecards for **power** (sunlight share, longest night, peak Sun elevation) and **direct-to-Earth communication** (Earth-in-view share, longest blackout, peak Earth elevation), plus both together and a near-horizon terrain-sensitivity flag. A lit 3D globe, a local sky view per scenario and window strips stay synchronised with one time control. "Best" is marked only when the lead exceeds the sampling tolerance and is not a window-edge lower bound. Sites come from the verified catalogue, pasted coordinates or a globe click; "same site, half a lunar day later" compares dates. `POST /api/compare` now accepts 1–4 sites (the pairwise narrative is produced for exactly two).
- **Route simulator:** start anywhere on the Moon (typed N/S/E/W, pasted decimal degrees, globe pick, or a verified mission site) and get candidate routes to the geographic South Pole. A deterministic planning-waypoint network is generated automatically. See [Route simulator](#route-simulator-start-anywhere).
- **Verified mission-site layer:** historical crewed and robotic landing sites and NASA's candidate Artemis III regions, each with a cited NASA/NSSDCA source. See [Site catalogue](#site-catalogue).
- **Mission analyst:** a persistent, grounded chat drawer that answers follow-up questions from stored run data and project documentation. See [Mission analyst](#mission-analyst).

> **Scope.** "Visible" means the body's **centre** is above an **ideal, terrain-free horizon** (elevation > 0°). Sunlight is not electrical power. Earth visibility is not a guaranteed communication link. See [Limitations](#limitations).

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

To enable the mission analyst, put your Anthropic API key in `.env` at the repo root (`ANTHROPIC_API_KEY=...`; git-ignored, loaded by the backend at startup), or pass it inline (see [.env.example](.env.example) for every option):

```bash
cd backend && ANTHROPIC_API_KEY=sk-ant-... uv run uvicorn app.main:app --port 8000
```

Without a key everything else works and the analyst drawer explains why it is unavailable. Runs and conversations persist in `backend/.data/` (SQLite and Qdrant local mode, git-ignored).

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
  routing_service.py response assembly, baseline comparison, deterministic route explanation, diagnostics
  route_network.py   automatic planning-waypoint corridors, preflight work estimate, coarse planning
  site_catalog.py    versioned, source-cited site catalogue (data/sites.json)
  persistence.py     SQLite: immutable runs, sessions, messages, rolling summaries, proposals, FTS5 index
  retrieval.py       Qdrant (local/server) + FTS5 hybrid retrieval behind small interfaces; embedders
  chat_tools.py      read-only analyst tools over stored runs, citation resolution, grounding check
  chat_service.py    provider abstraction (Anthropic), bounded context, streaming tool loop, proposals
  chat_api.py        /api/chat/* endpoints (SSE), session tokens, rate limits
  main.py        FastAPI app and routes
backend/data/
  sites.json     the catalogue        docs/*.md   method documentation indexed for the analyst
frontend/src/
  components/    LunarPrimeApp (tabs), MoonGlobe (R3F), Timelines (Plotly), HorizonView (SVG), Controls, Results, Scrubber,
                 RoutePlanner (console), StartPicker, SiteDetails, MissionAnalyst, Markdown, RouteControls, RouteResults
  lib/           API types/clients (api, chatApi), coordinate parsing (coords), site types, formatting, geo helpers
```

There is no user authentication: see [Public deployment](#public-deployment-security).

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

Errors return `{"error": {"code", "message", "details": [{field, message}]}}` with HTTP 422, 503, 429 (rate limit), or 500.

## Limitations

These are not modelled. Each one is also listed in every response and in the UI.

- **Terrain.** Crater walls and ridges are ignored. At polar sites terrain dominates real illumination. For example, the Shackleton preset uses the crater centre, whose real floor is permanently shadowed. The "near horizon" metric flags results that terrain could overturn.
- **Finite discs.** The Sun's ~0.27° and Earth's ~0.95° angular radii are not modelled. Visibility is judged by the centre only.
- **Eclipses.** Earth occultation of the Sun is not modelled.
- **Power.** No panel geometry, efficiency, dust, or thermal effects.
- **Communications.** No antenna pointing, link budget, ground stations, or relays.
- **Overall ranking.** There is no universal "best site". Findings compare single criteria within the chosen window only.
- **Route Planner.** Route-specific limitations are listed under [Planner limitations](#planner-limitations).

## South Pole Route Planner

> **Conceptual spherical-surface route. Terrain, slopes, obstacles, battery/thermal limits, and communication link budgets are not modelled.**

The planner described below is the engine behind the [route simulator](#route-simulator-start-anywhere). With the automatic network the waypoints are generated; the hypothetical demo network can still be loaded from **Advanced settings → Reset demo network**. To plan with your own waypoints:

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

## Route simulator (start anywhere)

**Coordinates.** Planetocentric latitude and **east-positive** longitude (MOON_ME), always **latitude first**. The start can be set by:

- typing magnitudes with explicit N/S and E/W toggles;
- pasting decimal degrees (`-86.2, 35.4`, or `86.2S 35.4E`; with letters on both values either order is accepted);
- **Pick on globe** (a drag rotates the globe and never places a point; Esc cancels);
- searching the verified site catalogue, or **Use as start** on a site card.

Malformed, ambiguous (for example `120, 10`, or a minus sign together with a hemisphere letter), out-of-range and non-finite input is rejected with a specific message. Longitudes are normalised to (−180°, 180°]. Values keep full precision internally and are rounded only for display. The destination defaults to the geographic South Pole (−90°, 0°); a custom destination is under **Advanced settings**. A start already at the destination returns a successful zero-distance, zero-duration itinerary.

**Automatic network** (`auto_network: true`, default in the UI). `route_network.py` builds a deterministic, bounded candidate network:

- a central great-circle corridor plus two lateral corridors (`planning_mode: "exact"`), or one corridor (`"coarse"`);
- along-track spacing ≤ 0.7 × max leg and lateral offset 0.4 × max leg, so straight and diagonal hops respect `max_leg_km`;
- nodes are labelled **"Planning waypoint"** (hypothetical; no terrain safety, power, supplies or communications implied);
- near-antipodal endpoints (including North Pole → South Pole) use an explicit, deterministic anchor 90° from the start instead of SLERP across the antipode; the response discloses that other equally short corridors exist;
- `include_catalog_sites: true` adds catalogue landing sites near the corridor as candidate positions (labelled "Catalogue site").

The existing time-expanded search, exposure integration, waiting/grid-alignment rules, local refinement and baselines are unchanged and are applied to the generated network.

**Preflight and work limits.** `POST /api/route/preflight` (pure geometry, no SPICE) returns the great-circle distance, the distance/speed lower bound on travel time, the estimated network size, time states and sample evaluations, and the binding constraints with specific suggestions. The planner rejects oversized exact searches before any ephemeris work. **Coarse planning** is used only when explicitly selected: a single corridor and, if needed, a coarser time grid; every approximation is listed in `network.approximations`. Speed, horizon, leg limit and mode are never changed silently. Examples measured with SPICE on this machine (exact grid, 2 s – 4 s): Apollo 11 area → pole (2,750 km at 20 km/h, legs ≤ 400 km); North Pole → South Pole (5,458 km, legs ≤ 800 km, 2 h grid).

**Infeasible requests** return `200` with `status: "infeasible"`, the reason, and `diagnostics` (`great_circle_km`, `min_travel_hours`, `binding_constraint` = horizon / max_leg_km / max_wait_hours, and a concrete `suggestion`).

**Run records.** Every computed route is stored as an immutable run (`run.run_id`, `input_hash`, `result_hash`) so the analyst can cite it later. `GET /api/runs/{run_id}` returns the stored request (`?full=1` includes the response).

**Interface.** Globe-first console: compact start/destination/departure controls with everything else under Advanced; a floating playback bar (speed control; scrubbing moves the rover, UTC, lighting and the exposure chart together); Frame route and Follow rover; layer toggles (mission sites, planning waypoints, candidate network — hidden by default — and baseline); hover a route segment for its times and exposure, click it or an itinerary row to highlight it; idle / computing / success / infeasible / error / stale states, with stale requests aborted and late responses ignored. Animation honours `prefers-reduced-motion`. On narrow screens the globe stays on top with Plan / Results / Analyst tabs below.

## Site catalogue

`backend/data/sites.json` (version `2026-11-15.1`), served by `GET /api/sites`. Categories: `crewed_landing`, `robotic_landing`, `proposed_region` (plus `planning_waypoint` and `user_defined` for non-catalogue points). **None is an operational base**, and the SPICE kernels are not a catalogue of bases: catalogue positions are independent of the SPICE Sun/Earth geometry.

| Records | Source (verified 2026-11-15) | Frame / precision |
|---|---|---|
| Apollo 11, 12, 14, 15, 16, 17 lunar modules | [NSSDCA Apollo Landing Sites](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html) (updated 2017-03-06; LRO measurements, Wagner et al. 2017) | DE421 mean Earth/polar axis; 4–5 decimals |
| Surveyor 1, 3; Luna 16, 24; Chang'e 3, 4, 5, 6; Chandrayaan-3; SLIM; IM-2 | [NSSDCA Table of Anthropogenic Impacts and Spacecraft on the Moon](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html) (updated 2025-08-13) | DE421 ME; 0.001° ≈ 30 m |
| Nine Artemis III candidate regions | [NASA RELEASE24-136](https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/) (2024-10-28) | **No coordinates or boundaries published, so none are plotted** |

Unverified: NASA has since re-scoped Artemis III; whether these nine regions now apply to a later mission was not confirmed, so they remain labelled as the October 2024 Artemis III candidate regions.

**Refresh procedure.** Re-read each source page, update the records and `retrieved` dates, bump `version`, and run `uv run pytest` (tests check that every record has a source and that broad regions carry no invented point). Do not add a point for a region unless the source publishes one. Restart the backend; catalogue text is re-indexed automatically (content-hash deduplicated).

## Mission analyst

A drawer ("Ask mission analyst") for follow-up questions about the current simulation. It distinguishes:

1. **Computed results**: only from typed, read-only tools over the stored run: `get_run_summary`, `get_route_segments`, `get_baseline_comparison`, `get_visibility_intervals`, `get_site_details`, `list_session_runs`.
2. **Documentation and sources**: `search_documents` over `backend/data/docs/*.md`, the method/limitation text in `config.py`, and catalogue records.
3. **Explanations not simulated**: the model must label them "Not simulated:".

Answers cite with `[ref:…]` markers that the backend resolves to actual run fields, segments, visibility intervals, catalogue records or ingested chunks; unresolvable references are removed. Computed references (teal) and source references (blue) are shown separately and are clickable (a segment reference highlights it on the globe; an interval moves the scrubber). A heuristic grounding check flags any number in an answer that does not appear in the tool data. Synthetic-mode runs are labelled as not SPICE/NASA data.

**Counterfactuals.** "What if I depart later?" is never answered by guessing: the model calls `propose_comparison` with explicit, allow-listed changes, validated against the normal request contract and preflight work limits. Nothing runs until the user clicks **Run comparison**; the comparison executes through the same route function (same limits, SPICE handling and persistence), is stored as a new run with `parent_run_id`, and its comparison text is generated deterministically (no LLM). No shell, code execution or URL fetching is exposed to the model.

**Run binding.** Each user message is permanently bound to the run shown when it was sent; new runs never overwrite the run an earlier answer discussed. Older runs remain queryable within the conversation.

**Conversation memory.** No UI turn cap. History is paginated. Model context is bounded: stable system prompt + rolling summary (written when ≥ 24 messages are unsummarised; also indexed) + lexically recalled older messages + the 12 most recent messages + retrieved documents. Provider context-limit, rate-limit, timeout and authentication failures are reported as explicit error events; partial answers are kept on cancellation.

**Provider.** `chat_service.AnthropicProvider` (official Anthropic Python SDK, async streaming, server-side only). Default model `claude-opus-5-5` at `medium` effort, with Anthropic's server-side refusal fallback enabled (`LUNAR_PRIME_LLM_FALLBACKS=off` disables it). Usage is billed per token by Anthropic; nothing here is free or unlimited. Per request: ≤ 4,000-character message, ≤ 16,000 output tokens per call, ≤ 8 tool rounds, a 300,000-token budget across rounds, 90 s timeout with 2 SDK retries. Chat runs on async handlers and never holds the SPICE lock; LLM and embedding calls never happen inside routing.

**Retrieval.** Qdrant is the default vector store because it offers a persistent embedded mode for single-process development and the same API against a Qdrant server for concurrent deployment, with exact payload filters. That is a fit for this project, not a claim that it is the best vector database. Access is behind a small `VectorStore` interface. Retrieval is hybrid: Qdrant semantic results fused (reciprocal rank) with SQLite FTS5 BM25. Chunks are deduplicated by content hash; the collection name contains the embedding model and dimension, so changing either re-indexes into a new collection without mixing vectors. Searches are scoped structurally (global documents, this session only, this run only). Trajectory samples are never embedded and vector similarity is never used for numbers. If Qdrant or the embedding provider fails, retrieval degrades to lexical search and reports it in `/api/chat/status`. Without an embedding provider, a local hashing embedder (lexical similarity only) is used.

**Persistence.** SQLite (`LUNAR_PRIME_DB_PATH`, WAL mode): runs, sessions, messages, rolling summaries, proposals, FTS indexes. History survives restarts. Deleting a conversation deletes its messages, summaries, proposals and indexed vectors.

**Endpoints.** `GET /api/chat/status`; `POST /api/chat/sessions` → `{session_id, token}`; `GET /api/chat/sessions/{id}/messages?before_id=&limit=`; `POST /api/chat/sessions/{id}/messages` (`{content, run_id}`, `text/event-stream` events `meta`, `delta`, `tool`, `proposal`, `error`, `done`); `POST …/proposals/{pid}/run` and `/reject`; `DELETE /api/chat/sessions/{id}`. All session endpoints require the `X-Session-Token` header.

## Public deployment security

The current setup is for local, single-user use. Before any public or multi-user deployment you need, at minimum:

- real user authentication and per-user authorisation for sessions **and stored runs** (session tokens only isolate conversations; run ids are unguessable but not access-controlled);
- TLS, a restricted `LUNAR_PRIME_CORS`, and secrets in a secret manager (never in the frontend bundle or logs);
- a shared rate limiter and per-user spending limits (the built-in limiter is in-process and per-IP);
- Qdrant in server mode with an API key, and a multi-worker-safe SQLite replacement or a single writer;
- monitoring of provider spend, and a data-retention policy for conversations.

## Credits

- Ephemerides and orientation: NASA/JPL NAIF generic kernels.
- Globe basemap: NASA Scientific Visualization Studio *CGI Moon Kit*: LRO LROC WAC colour mosaic and LOLA elevation (public domain), in `frontend/public/textures/`.
