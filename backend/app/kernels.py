"""SPICE kernel loading (once, at startup) and coverage reporting."""

from __future__ import annotations

import hashlib
import logging
import threading
from dataclasses import dataclass, field

import spiceypy as spice

from . import config

log = logging.getLogger("lunar_prime.kernels")

# CSPICE keeps global state and is not thread-safe. Every SPICE call made while
# serving a request must hold this lock.
SPICE_LOCK = threading.Lock()


@dataclass
class KernelInfo:
    name: str
    kind: str
    purpose: str
    source_url: str
    present: bool
    size_bytes: int | None = None
    sha256: str | None = None


@dataclass
class KernelStatus:
    loaded: bool = False
    error: str | None = None
    kernels: list[KernelInfo] = field(default_factory=list)
    toolkit_version: str = ""
    coverage_start_utc: str | None = None
    coverage_end_utc: str | None = None
    coverage_start_et: float | None = None
    coverage_end_et: float | None = None
    moon_radius_km: float = config.MOON_RADIUS_KM


STATUS = KernelStatus()


def _sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _source_url(name: str) -> str:
    sub = {
        ".tls": "lsk",
        ".tpc": "pck",
        ".bpc": "pck",
        ".tf": "fk/satellites",
        ".bsp": "spk/planets",
    }
    for ext, folder in sub.items():
        if name.endswith(ext):
            return f"{config.NAIF_BASE_URL}/{folder}/{name}"
    return config.NAIF_BASE_URL


def _window_bounds(cell) -> tuple[float, float]:
    n = spice.wncard(cell)
    if n == 0:
        raise RuntimeError("empty coverage window")
    start, _ = spice.wnfetd(cell, 0)
    _, end = spice.wnfetd(cell, n - 1)
    return start, end


def load_kernels() -> KernelStatus:
    """Load all configured kernels once. Never raises; failures are recorded in STATUS."""
    global STATUS
    status = KernelStatus(toolkit_version=spice.tkvrsn("TOOLKIT"))
    missing = []
    for name, kind, purpose in config.KERNELS:
        path = config.KERNEL_DIR / name
        info = KernelInfo(name, kind, purpose, _source_url(name), path.is_file())
        if info.present:
            info.size_bytes = path.stat().st_size
            info.sha256 = _sha256(path)
        else:
            missing.append(name)
        status.kernels.append(info)

    if missing:
        status.error = (
            f"Missing SPICE kernels in {config.KERNEL_DIR}: {', '.join(missing)}. "
            "Run scripts/fetch_kernels.sh to download them from NAIF."
        )
        log.warning(status.error)
        STATUS = status
        return status

    with SPICE_LOCK:
        try:
            spice.kclear()
            for name, _, _ in config.KERNELS:
                spice.furnsh(str(config.KERNEL_DIR / name))

            # Sanity: the radius we use should match the loaded PCK.
            radii = spice.bodvrd("MOON", "RADII", 3)[1]
            if abs(float(radii[0]) - config.MOON_RADIUS_KM) > 1e-6:
                log.warning("PCK lunar radius %s differs from configured %s", radii, config.MOON_RADIUS_KM)

            # Coverage = intersection of the SPK coverage of Sun, Earth, Moon
            # and the binary PCK coverage of the lunar orientation frame.
            spk = str(config.KERNEL_DIR / "de440s.bsp")
            bpc = str(config.KERNEL_DIR / "moon_pa_de440_200625.bpc")
            starts, ends = [], []
            for body in (10, 399, 301, 3):
                cov = spice.spkcov(spk, body, spice.cell_double(2000))
                s, e = _window_bounds(cov)
                starts.append(s)
                ends.append(e)
            pck_cov = spice.cell_double(2000)
            frame_id = spice.namfrm("MOON_PA_DE440")
            spice.pckcov(bpc, frame_id, pck_cov)
            s, e = _window_bounds(pck_cov)
            starts.append(s)
            ends.append(e)
            # Keep a one-day safety margin from both ends for light-time lookups.
            status.coverage_start_et = max(starts) + 86400.0
            status.coverage_end_et = min(ends) - 86400.0
            status.coverage_start_utc = spice.et2utc(status.coverage_start_et, "ISOC", 0) + "Z"
            status.coverage_end_utc = spice.et2utc(status.coverage_end_et, "ISOC", 0) + "Z"

            # Smoke test: a known evaluation in the target frame must succeed.
            spice.spkpos("EARTH", status.coverage_start_et + 1e6, config.FRAME, config.ABCORR, config.MOON)
            status.loaded = True
            log.info(
                "SPICE kernels loaded (%s); coverage %s .. %s",
                status.toolkit_version,
                status.coverage_start_utc,
                status.coverage_end_utc,
            )
        except Exception as exc:  # SpiceyPy raises SpiceyError subclasses
            spice.kclear()
            status.loaded = False
            status.error = f"Failed to load SPICE kernels: {exc}"
            log.error(status.error)

    STATUS = status
    return status
