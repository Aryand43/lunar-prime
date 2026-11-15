"""Static configuration and scientific conventions for Lunar Prime.

Every convention used in the geometry is declared here once and echoed back to
clients in the response metadata, so the UI never has to restate (or guess) it.
"""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
KERNEL_DIR = Path(os.environ.get("LUNAR_PRIME_KERNEL_DIR", BACKEND_DIR / "kernels"))

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
    "No terrain: local topography, crater walls and distant ridges are ignored. At polar sites this dominates real illumination.",
    "Point-centre visibility: the finite discs of the Sun (~0.27 deg radius) and Earth (~0.95 deg radius) are not modelled; partial rising/setting counts by centre only.",
    "No eclipses: Earth occultation of the Sun (lunar eclipses) is not modelled, so 'sunlight' may include brief eclipse periods.",
    "Sunlight is geometric solar visibility, not electrical power: no panel orientation, efficiency, dust or thermal effects.",
    "Earth visibility is a line-of-sight condition, not a communication link: no antenna pointing, link budget, ground-station availability or relay assets.",
    "Events shorter than the sampling interval can be missed; detected transitions are refined by bisection to about 1 s.",
]
