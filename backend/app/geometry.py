"""Site geometry: Moon-fixed positions, local ENU basis, topocentric az/el.

All vectors are in the Moon-fixed MOON_ME frame, in kilometres.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Protocol

import numpy as np
import spiceypy as spice

from . import config


def normalize_lon(lon_deg: float) -> float:
    """Map any longitude to the (-180, 180] east-positive convention."""
    lon = math.fmod(lon_deg, 360.0)
    if lon <= -180.0:
        lon += 360.0
    elif lon > 180.0:
        lon -= 360.0
    return lon


def site_vector(lat_deg: float, lon_deg: float, radius_km: float = config.MOON_RADIUS_KM) -> np.ndarray:
    """Moon-fixed position of a point on the reference sphere (planetocentric lat, east lon)."""
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    return radius_km * np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])


def enu_basis(lat_deg: float, lon_deg: float) -> np.ndarray:
    """Rows are the unit East, North, Up vectors at the site, in MOON_ME.

    Written analytically from (lat, lon) so it stays well defined at the poles,
    where the supplied longitude fixes the orientation of "north".
    """
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    sl, cl = math.sin(lat), math.cos(lat)
    so, co = math.sin(lon), math.cos(lon)
    east = np.array([-so, co, 0.0])
    north = np.array([-sl * co, -sl * so, cl])
    up = np.array([cl * co, cl * so, sl])
    return np.vstack([east, north, up])


def topocentric_az_el(body_vectors_km: np.ndarray, site_km: np.ndarray, basis: np.ndarray):
    """Azimuth (deg, from north through east, [0,360)) and elevation (deg) of bodies seen from a site.

    body_vectors_km: (N, 3) Moon-centred body positions in MOON_ME.
    """
    topo = np.atleast_2d(body_vectors_km) - site_km  # subtract the observer's position
    enu = topo @ basis.T  # (N, 3) components along E, N, U
    rng = np.linalg.norm(enu, axis=1)
    el = np.degrees(np.arcsin(np.clip(enu[:, 2] / rng, -1.0, 1.0)))
    az = np.degrees(np.arctan2(enu[:, 0], enu[:, 1])) % 360.0
    return az, el, rng


def sub_point(body_vectors_km: np.ndarray):
    """Planetocentric lat/lon (deg) of the point directly beneath each body, plus distance (km)."""
    v = np.atleast_2d(body_vectors_km)
    r = np.linalg.norm(v, axis=1)
    lat = np.degrees(np.arcsin(v[:, 2] / r))
    lon = np.degrees(np.arctan2(v[:, 1], v[:, 0]))
    return lat, lon, r


class EphemerisProvider(Protocol):
    mode: str

    def utc_to_et(self, dt: datetime) -> float: ...
    def et_to_utc(self, ets: np.ndarray) -> list[str]: ...
    def body_vectors(self, body: str, ets: np.ndarray) -> np.ndarray: ...


class SpiceProvider:
    """Apparent Moon-centred Sun/Earth vectors from NAIF SPICE (caller holds SPICE_LOCK)."""

    mode = "spice"

    def utc_to_et(self, dt: datetime) -> float:
        return float(spice.str2et(dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f") + " UTC"))

    def et_to_utc(self, ets: np.ndarray) -> list[str]:
        return [spice.et2utc(float(et), "ISOC", 0) + "Z" for et in np.atleast_1d(ets)]

    def body_vectors(self, body: str, ets: np.ndarray) -> np.ndarray:
        ets = np.atleast_1d(np.asarray(ets, dtype=float))
        pos, _lt = spice.spkpos(config.BODIES[body], ets, config.FRAME, config.ABCORR, config.MOON)
        return np.atleast_2d(np.asarray(pos, dtype=float))


class SyntheticProvider:
    """Crude analytic Sun/Earth model for UI development ONLY. Not SPICE, not NASA data.

    Sun: circular orbit, synodic period, fixed 1.54 deg lunar obliquity to the ecliptic.
    Earth: fixed sub-Earth point plus sinusoidal optical libration (+/-7.9 deg lon, +/-6.7 deg lat).
    "ET" here is simply UTC seconds since 2000-01-01T12:00:00 (no leap seconds).
    """

    mode = "synthetic"
    _EPOCH = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)
    _NEW_MOON = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
    SYNODIC_S = 29.530589 * 86400
    ANOMALISTIC_S = 27.554550 * 86400
    DRACONIC_S = 27.212221 * 86400
    AU_KM = 149_597_870.7
    EARTH_KM = 384_400.0

    def utc_to_et(self, dt: datetime) -> float:
        return (dt.astimezone(timezone.utc) - self._EPOCH).total_seconds()

    def et_to_utc(self, ets: np.ndarray) -> list[str]:
        return [
            (self._EPOCH + timedelta(seconds=round(float(et)))).strftime("%Y-%m-%dT%H:%M:%SZ")
            for et in np.atleast_1d(ets)
        ]

    def body_vectors(self, body: str, ets: np.ndarray) -> np.ndarray:
        t = np.atleast_1d(np.asarray(ets, dtype=float))
        t_nm = (self._NEW_MOON - self._EPOCH).total_seconds()
        if body == "sun":
            lon = np.radians(180.0 - 360.0 * (t - t_nm) / self.SYNODIC_S)
            lat = np.radians(1.54) * np.sin(2 * np.pi * (t - t_nm) / self.DRACONIC_S)
            r = self.AU_KM
        else:
            lon = np.radians(7.9) * np.sin(2 * np.pi * (t - t_nm) / self.ANOMALISTIC_S)
            lat = np.radians(6.7) * np.sin(2 * np.pi * (t - t_nm) / self.DRACONIC_S)
            r = self.EARTH_KM
        return r * np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])




# --- Vectorised helpers (used by the route planner; compare uses the scalar forms above) ---


def enu_bases(lat_deg: np.ndarray, lon_deg: np.ndarray) -> np.ndarray:
    """(M, 3, 3) stack of East/North/Up rows, same convention as enu_basis()."""
    lat, lon = np.radians(np.asarray(lat_deg, float)), np.radians(np.asarray(lon_deg, float))
    sl, cl, so, co = np.sin(lat), np.cos(lat), np.sin(lon), np.cos(lon)
    zero = np.zeros_like(lat)
    east = np.stack([-so, co, zero], axis=-1)
    north = np.stack([-sl * co, -sl * so, cl], axis=-1)
    up = np.stack([cl * co, cl * so, sl], axis=-1)
    return np.stack([east, north, up], axis=-2)


def topocentric_az_el_many(body_km: np.ndarray, site_km: np.ndarray, bases: np.ndarray):
    """Azimuth/elevation (deg) for bodies seen from many sites at many epochs.

    body_km: (K, M, 3) Moon-centred body vectors; site_km: (M, 3); bases: (M, 3, 3).
    Identical maths to topocentric_az_el(): subtract the observer, project on E/N/U.
    """
    topo = body_km - site_km[None, :, :]
    enu = np.einsum("kmj,mij->kmi", topo, bases)
    rng = np.linalg.norm(enu, axis=-1)
    el = np.degrees(np.arcsin(np.clip(enu[..., 2] / rng, -1.0, 1.0)))
    az = np.degrees(np.arctan2(enu[..., 0], enu[..., 1])) % 360.0
    return az, el
