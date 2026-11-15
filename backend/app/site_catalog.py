"""Versioned, source-cited lunar site catalogue (backend/data/sites.json). Separate from SPICE geometry."""

from __future__ import annotations

import json
import math
from functools import lru_cache
from typing import Literal, Optional

from pydantic import BaseModel

from . import config
from .routing import central_angle, unit_vector

PATH = config.BACKEND_DIR / "data" / "sites.json"
Category = Literal["crewed_landing", "robotic_landing", "proposed_region", "planning_waypoint", "user_defined"]


class Site(BaseModel):
    id: str
    name: str
    mission: str
    agency: str
    category: Category
    status: str
    lat_deg: Optional[float]
    lon_deg: Optional[float]
    frame: Optional[str]
    source_title: str
    source_url: str
    source_date: Optional[str]
    retrieved: str
    precision_note: str
    region: Optional[dict] = None


class Catalogue(BaseModel):
    version: str
    note: str
    sites: list[Site]


@lru_cache(maxsize=1)
def load() -> Catalogue:
    return Catalogue(**json.loads(PATH.read_text()))


def get(site_id: str) -> Optional[Site]:
    return next((s for s in load().sites if s.id == site_id), None)


def sites_near_corridor(lat0, lon0, lat1, lon1, corridor_km: float, limit: int) -> list[Site]:
    """Point sites within corridor_km of the start->destination great circle segment (approximate test)."""
    a, b = unit_vector(lat0, lon0), unit_vector(lat1, lon1)
    total = central_angle(a, b)
    out = []
    for s in load().sites:
        if s.lat_deg is None:
            continue
        p = unit_vector(s.lat_deg, s.lon_deg)
        if central_angle(a, p) + central_angle(p, b) - total <= corridor_km / config.MOON_RADIUS_KM * 0.5 + 1e-12:
            out.append(s)
    return out[:limit]
