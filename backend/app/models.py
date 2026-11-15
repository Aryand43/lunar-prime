"""Typed request/response contracts for the Lunar Prime API."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import config
from .geometry import normalize_lon


def _check_utc(v: datetime) -> datetime:
    """Shared validator: an aware datetime in UTC (offset +00:00 or 'Z')."""
    if v.tzinfo is None:
        raise ValueError("start_utc must include a UTC designator, e.g. '2026-12-01T00:00:00Z'")
    if v.utcoffset() != timezone.utc.utcoffset(None):
        raise ValueError("start_utc must be in UTC (offset +00:00 or 'Z')")
    return v.astimezone(timezone.utc)


class SiteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_\-]+$")
    label: str = Field(..., min_length=1, max_length=64)
    lat_deg: float = Field(..., ge=-90.0, le=90.0, description="Planetocentric latitude, degrees")
    lon_deg: float = Field(..., ge=-180.0, le=360.0, description="East-positive longitude, degrees")
    start_utc: Optional[datetime] = Field(
        None, description="This scenario's start (ISO 8601 UTC). None means the request's start_utc."
    )
    horizon_key: Optional[str] = Field(
        None, max_length=64, pattern=r"^[A-Za-z0-9\-]+$",
        description="Preset key of a precomputed terrain skyline. Ignored if no such file exists, in synthetic mode, "
                    "or if the coordinates differ from the preset's.",
    )

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("label must not be blank")
        return v

    @field_validator("lon_deg")
    @classmethod
    def _norm_lon(cls, v: float) -> float:
        return normalize_lon(v)

    @field_validator("start_utc")
    @classmethod
    def _utc(cls, v: Optional[datetime]) -> Optional[datetime]:
        return None if v is None else _check_utc(v)


class CompareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sites: list[SiteInput] = Field(..., min_length=2, max_length=2)
    start_utc: datetime = Field(..., description="ISO 8601 UTC start, e.g. 2026-12-01T00:00:00Z")
    duration_hours: float = Field(..., ge=config.MIN_DURATION_HOURS, le=config.MAX_DURATION_HOURS)
    step_minutes: float = Field(..., ge=config.MIN_STEP_MINUTES, le=config.MAX_STEP_MINUTES)
    mode: Literal["spice", "synthetic"] = "spice"

    @field_validator("start_utc")
    @classmethod
    def _utc(cls, v: datetime) -> datetime:
        return _check_utc(v)

    @model_validator(mode="after")
    def _check(self) -> "CompareRequest":
        if self.sites[0].id == self.sites[1].id:
            raise ValueError("the two sites must have different ids")
        n = int(self.duration_hours * 60.0 // self.step_minutes) + 2
        if n > config.MAX_SAMPLES:
            raise ValueError(
                f"request needs about {n:,} samples; the limit is {config.MAX_SAMPLES:,}. "
                "Increase step_minutes or shorten duration_hours."
            )
        if self.step_minutes > self.duration_hours * 60.0:
            raise ValueError("step_minutes must not exceed the duration")
        return self


class AzEl(BaseModel):
    az_deg: list[float]
    el_deg: list[float]


class IntervalOut(BaseModel):
    start_utc: str
    end_utc: str
    duration_s: float
    starts_at_window_start: bool
    ends_at_window_end: bool


class GapOut(BaseModel):
    start_utc: str
    end_utc: str
    duration_s: float
    open_start: bool = Field(..., description="Gap begins at window start; true duration may be longer")
    open_end: bool = Field(..., description="Gap reaches window end; true duration may be longer")


class BodyMetrics(BaseModel):
    visible_duration_s: float
    visible_fraction: float
    longest_visible_s: float
    longest_gap: Optional[GapOut] = Field(None, description="None when the body is visible throughout")
    n_intervals: int
    el_min_deg: float
    el_max_deg: float
    near_horizon_fraction: float = Field(
        ..., description=f"Approximate fraction of time with |elevation| < {config.NEAR_HORIZON_DEG} deg"
    )


class SiteMetrics(BaseModel):
    sun: BodyMetrics
    earth: BodyMetrics
    both_duration_s: float
    both_fraction: float


class SubPoints(BaseModel):
    subsolar_lat_deg: list[float]
    subsolar_lon_deg: list[float]
    sub_earth_lat_deg: list[float]
    sub_earth_lon_deg: list[float]
    earth_distance_km: list[float]


class HorizonOut(BaseModel):
    az_deg: list[float]
    el_deg: list[float] = Field(..., description="Skyline elevation angle (deg) above the local horizontal")
    site_height_m: float = Field(..., description="Surface height above the 1737.4 km sphere")
    observer_height_m: float
    source: str


class SiteResult(BaseModel):
    id: str
    label: str
    lat_deg: float
    lon_deg: float
    position_me_km: list[float]
    sun: AzEl
    earth: AzEl
    masks: dict[str, list[bool]]  # sun, earth, both (sample-wise, elevation > 0)
    intervals: dict[str, list[IntervalOut]]  # sun, earth, both (refined)
    metrics: SiteMetrics
    start_utc: str = Field(..., description="This scenario's window start (UTC)")
    timestamps_utc: list[str] = Field(..., description="This scenario's sample times (UTC)")
    subpoints: SubPoints = Field(..., description="Subsolar and sub-Earth points at this scenario's sample times")
    model: Literal["terrain", "sphere"] = Field(..., description="Horizon model used for this site")
    horizon: Optional[HorizonOut] = Field(None, description="Terrain skyline when model is 'terrain'")


class Statement(BaseModel):
    id: str
    text: str
    favors: Optional[str] = Field(None, description="Site id this statement favours, or None if similar/neutral")
    kind: Literal["comparison", "observation", "caveat"]


class Comparison(BaseModel):
    headline: str
    statements: list[Statement]
    tolerance_s: float = Field(..., description="Differences smaller than this are reported as similar")


class KernelOut(BaseModel):
    name: str
    kind: str
    purpose: str
    source_url: str
    sha256: Optional[str]


class Metadata(BaseModel):
    mode: Literal["spice", "synthetic"]
    provenance: str
    computed_at_utc: str
    window_start_utc: str
    window_end_utc: str
    window_duration_s: float
    starts_differ: bool = Field(..., description="True when the two sites use different start times")
    step_s: float
    n_samples: int
    refinement_tolerance_s: float
    n_refined_transitions: int
    conventions: dict[str, str]
    limitations: list[str]
    kernels: list[KernelOut]
    toolkit_version: Optional[str]
    compute_time_ms: float


class CompareResponse(BaseModel):
    timestamps_utc: list[str]
    elapsed_s: list[float]
    sites: list[SiteResult]
    subpoints: SubPoints
    comparison: Comparison
    metadata: Metadata


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    spice_available: bool
    synthetic_available: bool
    error: Optional[str]
    toolkit_version: str
    coverage_start_utc: Optional[str]
    coverage_end_utc: Optional[str]
    kernels: list[KernelOut]
    limits: dict[str, float]
    conventions: dict[str, str]
    limitations: list[str]
