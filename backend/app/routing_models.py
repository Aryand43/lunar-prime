"""Typed request/response contracts for POST /api/route (the South Pole Route Planner)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, field_validator, model_validator

from . import config
from .geometry import normalize_lon
from .models import KernelOut


class RouteBaseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_\-]+$")
    label: str = Field(..., min_length=1, max_length=64)
    lat_deg: FiniteFloat = Field(..., ge=-90.0, le=90.0, description="Planetocentric latitude, degrees")
    lon_deg: FiniteFloat = Field(..., ge=-180.0, le=360.0, description="East-positive longitude, degrees")

    @field_validator("label")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("label must not be blank")
        return v

    @field_validator("lon_deg")
    @classmethod
    def _norm(cls, v: float) -> float:
        return normalize_lon(v)


class RouteWeights(BaseModel):
    model_config = ConfigDict(extra="forbid")

    distance: FiniteFloat = Field(1.0, ge=0.0, le=1e6)
    darkness: FiniteFloat = Field(1.0, ge=0.0, le=1e6)
    earth_invisible: FiniteFloat = Field(0.5, ge=0.0, le=1e6)

    @model_validator(mode="after")
    def _nonzero(self) -> "RouteWeights":
        if self.distance == 0 and self.darkness == 0 and self.earth_invisible == 0:
            raise ValueError("at least one objective weight must be positive")
        return self


SOUTH_POLE = RouteBaseInput(id="south-pole", label="Geographic south pole", lat_deg=-90.0, lon_deg=0.0)


class RouteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: RouteBaseInput
    destination: RouteBaseInput = SOUTH_POLE
    waypoints: list[RouteBaseInput] = Field(default_factory=list, max_length=config.ROUTE_MAX_BASES - 2)
    departure_utc: datetime
    horizon_hours: FiniteFloat = Field(..., ge=config.ROUTE_MIN_HORIZON_HOURS, le=config.ROUTE_MAX_HORIZON_HOURS)
    speed_kmh: FiniteFloat = Field(..., ge=config.ROUTE_MIN_SPEED_KMH, le=config.ROUTE_MAX_SPEED_KMH)
    max_leg_km: FiniteFloat = Field(..., gt=0.0, le=round(config.ROUTE_MAX_LEG_KM, 1))
    grid_minutes: FiniteFloat = Field(..., ge=config.ROUTE_MIN_GRID_MIN, le=config.ROUTE_MAX_GRID_MIN)
    max_wait_hours: FiniteFloat = Field(..., ge=0.0, le=config.ROUTE_MAX_HORIZON_HOURS)
    weights: RouteWeights = Field(default_factory=RouteWeights)
    distance_scale_km: FiniteFloat = Field(100.0, gt=0.0, le=1e5)
    exposure_scale_hours: FiniteFloat = Field(24.0, gt=0.0, le=1e5)
    local_search: bool = True
    mode: Literal["spice", "synthetic"] = "spice"

    @field_validator("departure_utc")
    @classmethod
    def _utc(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("departure_utc must include a UTC designator, e.g. '2026-12-01T00:00:00Z'")
        if v.utcoffset() != timezone.utc.utcoffset(None):
            raise ValueError("departure_utc must be in UTC (offset +00:00 or 'Z')")
        return v.astimezone(timezone.utc)

    @model_validator(mode="after")
    def _check(self) -> "RouteRequest":
        ids = [self.start.id, self.destination.id] + [w.id for w in self.waypoints]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"base ids must be unique (duplicated: {', '.join(dupes)})")
        if self.grid_minutes > self.horizon_hours * 60.0:
            raise ValueError("grid_minutes must not exceed the planning horizon")
        if self.max_wait_hours > self.horizon_hours:
            raise ValueError("max_wait_hours must not exceed the planning horizon")
        return self


# ----------------------------------------------------------------------------- response


class BaseOut(BaseModel):
    id: str
    label: str
    lat_deg: float
    lon_deg: float
    role: Literal["start", "waypoint", "destination"]


class LegOut(BaseModel):
    from_id: str
    to_id: str
    distance_km: float


class SegmentOut(BaseModel):
    kind: Literal["move", "wait"]
    base_id: str = Field(..., description="Base where the segment starts (wait: where it happens)")
    to_id: Optional[str] = None
    start_utc: str
    end_utc: str
    start_elapsed_s: float
    duration_s: float
    alignment_wait_s: float = Field(0.0, description="Part of a wait caused by rounding arrival up to the time grid")
    distance_km: float
    darkness_s: float
    earth_invisible_s: float
    both_visible_s: float


class ItineraryLegOut(BaseModel):
    from_id: str
    to_id: str
    depart_utc: str
    arrive_utc: str
    distance_km: float
    movement_s: float
    darkness_s: float
    earth_invisible_s: float
    both_visible_s: float


class StopOut(BaseModel):
    order: int
    base_id: str
    arrive_utc: Optional[str]
    depart_utc: Optional[str]
    wait_s: float
    alignment_wait_s: float


class Trajectory(BaseModel):
    time_utc: list[str]
    elapsed_s: list[float]
    lat_deg: list[float]
    lon_deg: list[float]
    sun_az_deg: list[float]
    sun_el_deg: list[float]
    earth_az_deg: list[float]
    earth_el_deg: list[float]
    status: list[Literal["move", "wait"]]
    segment_index: list[int]
    subsolar_lat_deg: list[float]
    subsolar_lon_deg: list[float]
    sub_earth_lat_deg: list[float]
    sub_earth_lon_deg: list[float]


class CostBreakdown(BaseModel):
    distance: float
    darkness: float
    earth_invisible: float
    total: float


class RouteMetrics(BaseModel):
    distance_km: float
    departure_utc: str
    arrival_utc: str
    elapsed_s: float
    movement_s: float
    waiting_s: float
    alignment_wait_s: float
    discretionary_wait_s: float
    darkness_s: float
    earth_invisible_s: float
    both_visible_s: float
    longest_darkness_s: float
    longest_earth_invisible_s: float
    cost: CostBreakdown


class RoutePlan(BaseModel):
    visited: list[str]
    stops: list[StopOut]
    legs: list[ItineraryLegOut]
    segments: list[SegmentOut]
    metrics: RouteMetrics
    trajectory: Optional[Trajectory] = None


class AlternativeOut(BaseModel):
    name: str
    feasible: bool
    reason: Optional[str]
    distance_km: float
    plan: Optional[RoutePlan]


class ComparisonRow(BaseModel):
    metric: str
    unit: str
    optimized: Optional[float]
    baseline: Optional[float]
    difference: Optional[float] = Field(None, description="optimized - baseline")
    percent_change: Optional[float] = Field(None, description="(optimized - baseline) / baseline * 100; null if baseline is 0")
    lower_is_better: bool


class LocalSearchOut(BaseModel):
    performed: bool
    explanation: str
    evaluations: int
    selected_seed: Optional[str] = None
    seeds: list[dict]
    accepted: list[dict]


class SearchOut(BaseModel):
    method: str
    optimality_scope: str
    grid_minutes: float
    sampling_minutes: float
    n_time_steps: int
    n_bases: int
    n_candidate_legs: int
    n_states_expanded: int
    n_labels: int
    n_edges_relaxed: int
    estimated_sample_evaluations: int
    ephemeris_epochs: int
    graph_status: Literal["feasible", "infeasible"]
    graph_cost: Optional[float]
    local_search: LocalSearchOut
    compute_time_ms: float


class ObjectiveOut(BaseModel):
    formula: str
    weights: RouteWeights
    distance_scale_km: float
    exposure_scale_hours: float


class RouteMetadata(BaseModel):
    mode: Literal["spice", "synthetic"]
    provenance: str
    disclaimer: str
    computed_at_utc: str
    conventions: dict[str, str]
    limitations: list[str]
    kernels: list[KernelOut]
    toolkit_version: Optional[str]


class RouteResponse(BaseModel):
    status: Literal["feasible", "infeasible"]
    reason: Optional[str]
    bases: list[BaseOut]
    candidate_legs: list[LegOut]
    route: Optional[RoutePlan]
    baseline: AlternativeOut
    direct: AlternativeOut
    comparison: list[ComparisonRow]
    explanation: list[str]
    objective: ObjectiveOut
    search: SearchOut
    metadata: RouteMetadata
