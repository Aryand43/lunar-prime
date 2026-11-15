"""Static configuration and scientific conventions for Lunar Prime.

Every convention used in the geometry is declared here once and echoed back to
clients in the response metadata, so the UI never has to restate (or guess) it.
"""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Load KEY=VALUE lines from <repo>/.env and backend/.env without overriding the real environment.

    Minimal parser (no dependency): ignores comments, blank lines and empty values. Disabled with
    LUNAR_PRIME_NO_DOTENV=1 (the test suite does this so it never sees real credentials).
    """
    if os.environ.get("LUNAR_PRIME_NO_DOTENV") == "1":
        return
    for path in (BACKEND_DIR.parent / ".env", BACKEND_DIR / ".env"):
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip().removeprefix("export ").strip(), value.strip().strip("'\"")
            if key and value and key not in os.environ:
                os.environ[key] = value


_load_dotenv()
KERNEL_DIR = Path(os.environ.get("LUNAR_PRIME_KERNEL_DIR", BACKEND_DIR / "kernels"))
# The analytic synthetic provider exists only for the offline test suite. The live API serves SPICE only.
ALLOW_SYNTHETIC = os.environ.get("LUNAR_PRIME_ALLOW_SYNTHETIC") == "1"

# Kernels loaded at startup, in load order. (file name, kernel type, purpose)
KERNELS: list[tuple[str, str, str]] = [
    ("naif0012.tls", "LSK", "Leapseconds: UTC <-> TDB (ephemeris time) conversion"),
    ("pck00011.tpc", "PCK (text)", "IAU body constants; source of the lunar reference radius"),
    ("moon_pa_de440_200625.bpc", "PCK (binary)", "High-accuracy lunar orientation (MOON_PA_DE440) from the DE440 integration"),
    ("moon_de440_250416.tf", "FK", "Defines MOON_PA and MOON_ME frames consistent with DE440"),
    ("de440s.bsp", "SPK", "JPL DE440s planetary ephemeris: Sun, Earth, Moon positions (1849-2150)"),
]
NAIF_BASE_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"

# --- Geometry conventions -----------------------------------------------------
FRAME = "MOON_ME"  # Moon Mean-Earth/polar-axis body-fixed frame (alias of MOON_ME_DE440_ME421)
ABCORR = "LT+S"  # converged light time + stellar aberration -> apparent directions
MOON = "MOON"
BODIES = {"sun": "SUN", "earth": "EARTH"}
# IAU mean lunar radius (km). Also checked against BODY301_RADII from pck00011.tpc at startup.
MOON_RADIUS_KM = 1737.4

# --- Request bounds -------------------------------------------------------------
MAX_SAMPLES = 20_000
MIN_STEP_MINUTES = 1.0
MAX_STEP_MINUTES = 24 * 60.0
MIN_DURATION_HOURS = 1.0
MAX_DURATION_HOURS = 366 * 24.0
# Transition times are refined by bisection on elevation to this tolerance.
REFINE_TOLERANCE_S = 1.0
# |elevation| below this counts as "near the horizon" for the sensitivity metric.
NEAR_HORIZON_DEG = 1.0

CONVENTIONS = {
    "frame": (
        "MOON_ME: lunar Mean-Earth/polar-axis body-fixed frame, realised as MOON_ME_DE440_ME421 "
        "(fixed rotation from the DE440 principal-axis frame MOON_PA_DE440). This is the frame "
        "used for LRO/LOLA lunar cartography."
    ),
    "longitude": "Planetocentric latitude; east-positive longitude in degrees, normalised to (-180, 180].",
    "shape": (
        f"Sphere of radius {MOON_RADIUS_KM} km (IAU mean radius). Site altitude is zero; "
        "no topography or ellipsoid."
    ),
    "aberration": (
        "LT+S: apparent directions corrected for one-way light time and stellar aberration, "
        "computed for the Moon's centre. The observer offset (<= 1737.4 km) is then subtracted "
        "geometrically; the light-time difference this neglects is < 6 ms."
    ),
    "topocentric": (
        "Topocentric vector = (Moon-centred apparent body vector) - (site vector), both in MOON_ME, "
        "projected on the local East/North/Up basis of the sphere at the site."
    ),
    "angles": (
        "Elevation = asin(Up component / range), degrees above the ideal horizon. "
        "Azimuth = atan2(East, North), degrees clockwise from local north, in [0, 360)."
    ),
    "visibility": (
        "Geometric visibility: the body's centre has elevation > 0 deg above an ideal, "
        "terrain-free local horizon."
    ),
    "time": "Inputs and outputs are UTC; internal computations use TDB (SPICE ephemeris time) via naif0012.tls.",
}

LIMITATIONS = [
    "Terrain: by default the horizon is ideal (no topography). With the terrain option, sites south of 60°S use a horizon computed from the NASA LOLA 240 m polar DEM; features smaller than a few hundred metres, and terrain beyond the DEM edge or 300 km, are not included. Elsewhere the ideal horizon is used.",
    "Point-centre visibility: the finite discs of the Sun (~0.27 deg radius) and Earth (~0.95 deg radius) are not modelled; partial rising/setting counts by centre only.",
    "No eclipses: Earth occultation of the Sun (lunar eclipses) is not modelled, so 'sunlight' may include brief eclipse periods.",
    "Sunlight is geometric solar visibility, not electrical power: no panel orientation, efficiency, dust or thermal effects.",
    "Earth visibility is a line-of-sight condition, not a communication link: no antenna pointing, link budget, ground-station availability or relay assets.",
    "Events shorter than the sampling interval can be missed; detected transitions are refined by bisection to about 1 s.",
]

# --- Route planner -------------------------------------------------------------
# Bounds checked BEFORE any ephemeris call or large allocation.
ROUTE_MAX_BASES = 40  # start + destination + candidate waypoints
ROUTE_MAX_TIME_STEPS = 3_000  # grid steps over the planning horizon
ROUTE_MAX_TIME_STATES = 80_000  # bases x (time steps + 1)
ROUTE_MAX_SAMPLE_EVALS = 25_000_000  # elevation samples across all leg/wait edge evaluations
ROUTE_MAX_EPHEMERIS_EPOCHS = 20_000  # exact SPICE epochs in the ephemeris table
ROUTE_MAX_TRAJECTORY_POINTS = 12_000  # returned trajectory samples per route
ROUTE_MAX_LABELS = 600_000  # labels created by the time-expanded search
ROUTE_MAX_LOCAL_SEARCH_EVALS = 4_000  # itinerary evaluations in the local-improvement pass
ROUTE_EPHEMERIS_STEP_MAX_MIN = 10.0  # ephemeris table / along-track sampling step upper bound
ROUTE_MIN_HORIZON_HOURS = 1.0
ROUTE_MAX_HORIZON_HOURS = 60 * 24.0
ROUTE_MIN_SPEED_KMH = 0.01
ROUTE_MAX_SPEED_KMH = 200.0
ROUTE_MIN_GRID_MIN = 1.0
ROUTE_MAX_GRID_MIN = 360.0
# Legs whose endpoints are within this angle of antipodal have no unique great circle.
ROUTE_ANTIPODAL_MARGIN_RAD = 1e-3
ROUTE_MAX_LEG_KM = 0.9 * 3.141592653589793 * MOON_RADIUS_KM  # well short of the antipode
# Two bases closer than this are the same physical location (catches -90 deg at any longitude).
ROUTE_COINCIDENT_KM = 1e-3

ROUTE_DISCLAIMER = (
    "Conceptual spherical-surface route. Terrain, slopes, obstacles, battery/thermal limits, "
    "and communication link budgets are not modelled."
)
ROUTE_LIMITATIONS = [
    ROUTE_DISCLAIMER,
    "Travel follows great-circle arcs on a sphere of radius 1737.4 km at constant speed; no rover dynamics, turning or slopes.",
    "Waypoints are hypothetical candidate locations, not constructed or planned lunar bases.",
    "Darkness = Sun centre at or below the ideal horizon (elevation <= 0 deg); not an electrical power model.",
    "Earth-invisible = Earth centre at or below the ideal horizon; Earth visibility is not a communication link.",
    "No terrain shadowing, finite solar/terrestrial discs, eclipses or relay assets.",
    "Exposure is integrated with linear interpolation between samples; events shorter than the sampling step can be missed.",
    "The graph search is exact only over its discrete time grid and candidate network; the result is not a globally optimal continuous route and not a certified safe route.",
]
