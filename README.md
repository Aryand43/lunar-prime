# Lunar Prime

Compare two lunar landing sites by **geometric sunlight** and **direct-to-Earth visibility** over a chosen UTC window. All geometry is computed on the backend with NASA/JPL NAIF SPICE. The comparison sentences are deterministic templates filled from the computed metrics; no language model writes them.

- Pick two sites on a 3D lunar globe (or choose presets, or type coordinates).
- Choose a UTC start, duration and sampling interval. Site B can start on its own date, so you can compare one place on two dates.
- Scrub through time. The globe is lit from the computed subsolar point, and a local-horizon sky plot shows the Sun and Earth for each site, with their current elevations and how long until each one next sets or rises.
- Read the answer first: a two-sentence headline, findings and a metrics table. An "Explain" switch adds a plain sentence under each number.
- Compare synchronized elevation timelines and refined visibility intervals, and list every sunlight and Earth-contact window.
- At four south-pole presets, use **real terrain**: the horizon is the skyline computed from NASA's LOLA elevation map, and the sky plots draw it.
- Hover over a sky plot, figure, countdown, metric or button for a short explanation.
- Read the method, limitations, kernel provenance (with SHA-256), and export the full result as JSON.

> **Scope.** "Visible" means the body's **centre** is above the horizon: the **LOLA terrain skyline** at sites marked "Terrain horizon (LOLA)", and an **ideal, terrain-free horizon** (elevation > 0°) everywhere else. Sunlight is not electrical power. Earth visibility is not a guaranteed communication link. See [Limitations](#limitations).

## What's new (November 2026)

**Real terrain horizons from NASA LOLA data.** At the Shackleton rim, the de Gerlache ridge, the Shackleton crater floor and IM-2 at Mons Mouton, the Sun and Earth count as visible only when they clear the **real skyline**: the highest terrain angle in each of 720 directions, computed from NASA's LOLA 80 m south-polar elevation map (PGDA product 90, Barker et al. 2023) and seen from 2 m above the surface. The sky plots draw that skyline, so you can watch the Sun skim the actual ridgeline. This is what makes the south pole make sense: with real terrain the Shackleton rim keeps the Sun up for the whole month, while the crater floor 10.8 km away gets 0.00% sunlight over a full year, exactly as a permanently shadowed floor should. Skylines are precomputed into `backend/data/horizons/`, so the app needs no map download; `scripts/build_horizons.py` rebuilds them and `scripts/validate_terrain.py` runs the checks, including a comparison with NASA's average illumination maps.

**Opens on the most interesting comparison.** The app starts on the Shackleton rim against IM-2. A "See it" button in "Why this matters" puts the rim beside the crater floor 10.8 km away, the clearest demonstration of why small changes in place matter. New preset: IM-3 (planned) at Reiner Gamma, 7.585 N, 58.725 W, from the Lunar Vertex landing-site paper (Blewett et al., LPSC 2023).

**Tooltips.** Hover over a sky plot, an elevation figure, a countdown, a metric, a model tag, a globe view or a playback button for a short explanation.

**Picture first (V2).** The first screen now shows the headline, then the lit globe beside both sky plots, then the time scrubber, all within a 1440 x 900 window. Each sky plot is a row: the sky disc, the current Sun and Earth elevations (with the compass direction of each), the time until each next rises or sets, and the strip of the sky within 10° of the horizon. The findings and the metrics table follow, then "Why this matters", the timelines and the method. The globe opens on its south-pole view, because both default sites are near the south pole.

**Route planner removed (V1).** The challenge is about choosing where and when to land, not about driving, so the route planner tab is gone. Its last version is kept under the Git tag `route-planner-archive`.

**Design refresh.** A light page with one font (Atkinson Hyperlegible Next). Colour is used only for the two bodies: yellow for the Sun, blue for Earth. The metrics table has bars; the layout was later reordered to put the picture first (V2, below).

**Time until the next change (U1).** Under each sky plot, one line per body says how long until it sets or rises at the scrubber time, for example "Sun sets in 4.2 d", with the UTC time of that event. When the change falls after the window ends, the line says so: "Earth stays up for at least 6.0 d (to the end of the window)". The times come from the refined rise and set intervals the API already returns, so they are as accurate as those intervals (±1 s refinement). A body that rises or sets more than once between two samples can still be missed, as before.

**Elevation up front, and libration stated (U2).** Each sky plot now starts with the current Sun and Earth elevations as two large figures; a body below the horizon is shown in grey with "below horizon". The Method section has a Libration row: libration is included, because Earth's motion in the lunar sky comes from the DE440 lunar orientation and orbit. That is why Earth rises and sets at sites near the limb and the poles.

**South-pole presets first (U3).** The preset list now has two groups. "South pole" comes first: IM-2 Athena at Mons Mouton, the Shackleton rim at its junction with the de Gerlache ridge ("Shackleton rim, ridge junction"), a sunlit point on the de Gerlache ridge ("de Gerlache ridge, sunlit point"), IM-1 Odysseus near Malapert A, Chandrayaan-3 at Statio Shiv Shakti ("Chandrayaan-3, Shiv Shakti"), and the Shackleton crater floor (permanently shadowed in reality). "Elsewhere on the Moon" holds Apollo 11, Apollo 17, Blue Ghost Mission 1 ("Blue Ghost 1, Mare Crisium"), Chang'e 4, Mare Orientale and Peary. The first screen compares IM-2 with IM-1, two real CLPS landings near the south pole; at sites poleward of 80° the sky plots and the metrics table say the model is a smooth sphere. Each coordinate's source is noted in `frontend/src/lib/sites.ts`. The de Gerlache point was checked only against the Wikipedia table that cites Gläser et al. (2017), not against the paper itself. Limitation: the ridge and rim sites are exactly where terrain matters most, and this model uses a smooth sphere. Real sunlight there can be higher than shown (a high ridge sees past the curve of the Moon) or lower (nearby peaks block the Sun), so treat these numbers as geometry, not predictions.

**Plain-language layer (U5).** An "Explain" switch in the header, on by default, adds one plain sentence under each metric and under the elevation figures. For example, under "Longest night" it says the lander must survive that stretch on batteries and stay warm. A short "Why this matters" block opens the results. Under the timelines, a collapsed section lists every sunlight and Earth-contact window for both sites (start, end, duration), up to 50 rows per table, and marks windows cut off by the window edge. The sentences are fixed text in `frontend/src/lib/explain.ts`; they explain the metrics but say nothing site-specific.

**Compare dates, not only sites (U4).** Each column is now a scenario: a site plus a start date. Tick "Site B starts on a different date" and give B its own start; "Same place as A" copies A's place into B, so you can compare one site on two dates. Duration and sampling stay shared. When the dates differ, the findings name both dates (for example "Mons Mouton (from 2026-12-15)"), the metrics table shows each start under its column, the scrubber shows the day number and both UTC times, the timeline's x axis becomes "days since each scenario's start", and the globe gets a "Light for A / Light for B" switch because it can be lit for only one date at a time. With the box unticked the request and the response's existing fields are unchanged; a regression test checks this against output captured before the change (synthetic provider). Limitation: the two scenarios must share duration and step.

**Not built: terrain horizon (U6).** U6 needs a LOLA polar elevation model from the NASA PDS Geosciences Node. That server (and NAIF, for the SPICE kernels) could not be reached from the environment this work was done in, and the spec says not to substitute invented data. So every site, including the ridge and rim presets, still uses a smooth sphere with an ideal horizon. Say so in the presentation.

## Quick start

Prerequisites: [uv](https://docs.astral.sh/uv/) (it provisions Python 3.12), Node 20+.

On a Mac, double-click `run-lunar-prime.command`: it fetches the SPICE kernels once, downloads a private Node if none is installed, and starts both servers. Or step by step:

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

Terrain skylines for the presets are committed in `backend/data/horizons/`, so the app needs no map download. To rebuild them or run the terrain checks, fetch the LOLA maps (about 390 MB, plus about 260 MB of NASA illumination maps for validation; `--no-validation` skips those):

```bash
./scripts/fetch_terrain.sh
cd backend && uv run python ../scripts/build_horizons.py && uv run python ../scripts/validate_terrain.py
```

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
scripts/fetch_terrain.sh   LOLA elevation maps (PGDA product 90) and NASA illumination maps, resumable
scripts/build_horizons.py  precompute terrain skylines for the south-pole presets
scripts/validate_terrain.py permanent-shadow check and comparison with NASA's illumination maps
backend/data/horizons/     committed skyline files (720 directions each)
backend/app/
  config.py      conventions, limits, kernel list (single source of truth, echoed in responses)
  kernels.py     load kernels once at startup, coverage window, SHA-256, global SPICE lock
  geometry.py    site vector, ENU basis, topocentric az/el; SPICE and synthetic providers
  analysis.py    visibility intervals, bisection refinement, gaps, intersections
  narrative.py   deterministic comparison statements with tolerances
  service.py     request orchestration; terrain skyline lookup per site
  terrain.py     LOLA map loading, projection, bilinear heights, 720-direction horizon profiles
  models.py      typed Pydantic request/response contracts
  main.py        FastAPI: GET /api/health, POST /api/compare
frontend/src/
  components/    LunarPrimeApp, MoonGlobe (R3F), Timelines (Plotly), HorizonView (SVG), Controls, Results, Scrubber
  lib/           API types/client, presets, events, explanations, formatting, frame mapping
```

No database, authentication, or chatbot.

## Scientific method

| Item | Convention |
|---|---|
| Reference frame | `MOON_ME`: Mean-Earth/polar-axis lunar body-fixed frame, realized as `MOON_ME_DE440_ME421` (a fixed rotation from the DE440 principal-axis frame). This is the LRO/LOLA cartographic frame. |
| Coordinates | Planetocentric latitude; **east-positive** longitude in (−180°, 180°]. |
| Lunar shape | Sphere, R = 1737.4 km (IAU mean radius, checked against `BODY301_RADII` at startup). Site altitude 0, except at terrain sites, where the observer is at 1737.4 km + LOLA surface height + 2 m. |
| Aberration | `LT+S` (light time plus stellar aberration), applied to Moon-centred Sun/Earth vectors. |
| Topocentric | `r_topo = r_body(Moon-centred, MOON_ME) − r_site`, projected onto the site's East/North/Up basis. |
| Angles | Elevation = asin(U/|r|). Azimuth = atan2(E, N), clockwise from local north, in [0°, 360°). |
| Visibility | Body centre above the horizon: the LOLA terrain skyline in that direction at terrain sites (linear interpolation between 720 directions), 0° elsewhere. |
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
- **Terrain.**
  - A skyline of 0° with zero heights reproduces the smooth-sphere result exactly (test). A +5° skyline removes all sunlight at a polar site (test).
  - Flat synthetic ground gives the expected horizon dip for a 2 m observer (−0.087°); a synthetic peak due north gives the highest skyline at azimuth 0° (tests).
  - Heights: the 80 m map gives 2,592 m at IM-1's landing point; NASA's LRO release gives 2,579 m.
  - The Shackleton crater floor gets 0.00% sunlight over 2027 at hourly steps (`scripts/validate_terrain.py`).
  - Next: the same script compares every terrain preset with NASA's average Sun and Earth visibility maps once those maps are downloaded.

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
    {"id": "B", "label": "Shackleton", "lat_deg": -89.67, "lon_deg": 129.78,
     "start_utc": "2026-12-15T00:00:00Z"}
  ],
  "start_utc": "2026-12-01T00:00:00Z",
  "duration_hours": 708.7,
  "step_minutes": 30,
  "mode": "spice"
}
```

`sites[].start_utc` is optional. Leave it out and the site uses the request's `start_utc`. Give it and that site's window starts there (same duration and step).

The response contains:

- `timestamps_utc`, `elapsed_s`
- per site:
  - `sun` / `earth` `{az_deg, el_deg}`
  - `masks` (sample-wise `sun` / `earth` / `both`)
  - refined `intervals`
  - `metrics`: visible duration and fraction, longest visible interval, longest gap with window-edge flags, elevation range, near-horizon fraction, and duration/fraction with both visible
  - `start_utc`, `timestamps_utc`, `subpoints`: this site's own window start, sample times and sub-points
- `subpoints`: subsolar and sub-Earth latitude/longitude, Earth distance (top-level `timestamps_utc`, `subpoints` and window times describe site A; `elapsed_s` is shared)
- `comparison`: `headline`, typed `statements` (comparison / observation / caveat), and the reporting `tolerance_s`
- `metadata`: mode, provenance, conventions (including libration), limitations, kernels with SHA-256, toolkit version, sampling, refinement count, compute time, and `starts_differ`

The full schema is at http://localhost:8000/docs.

**Validation:**

- latitude must be in [−90, 90] and longitude in [−180, 360] (normalized)
- `start_utc` and any `sites[].start_utc` must be timezone-aware UTC
- 1 h ≤ duration ≤ 366 d; 1 min ≤ step ≤ 24 h
- at most **20,000 samples**
- the two site ids must differ
- each site's window must be within kernel coverage

Errors return `{"error": {"code", "message", "details": [{field, message}]}}` with HTTP 422, 503, or 500.

## Limitations

These are not modelled. Each one is also listed in every response and in the UI.

- **Terrain.** Real LOLA skylines at the four presets marked "Terrain horizon (LOLA)"; other sites use a smooth sphere, and the "near horizon" metric flags where terrain could matter. Skylines use the 80 m map, seen from 2 m above the surface.
- **Finite discs.** The Sun's ~0.27° and Earth's ~0.95° angular radii are not modelled. Visibility is judged by the centre only.
- **Eclipses.** Earth occultation of the Sun is not modelled.
- **Power.** No panel geometry, efficiency, dust, or thermal effects.
- **Communications.** No antenna pointing, link budget, ground stations, or relays.
- **Two dates, one duration.** Site B can start on a different date, but both scenarios share the same duration and sampling step.
- **Overall ranking.** There is no universal "best site". Findings compare single criteria within the chosen window only.

## Credits

- Ephemerides and orientation: NASA/JPL NAIF generic kernels.
- Terrain: NASA GSFC PGDA product 90, "A New View of the Lunar South Pole from LOLA" (Barker et al. 2023, Planet. Sci. J. 4, 183).
- Globe basemap: NASA Scientific Visualization Studio *CGI Moon Kit*: LRO LROC WAC colour mosaic and LOLA elevation (public domain), in `frontend/public/textures/`.
