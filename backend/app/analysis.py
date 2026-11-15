"""Interval analysis of visibility time series.

Visibility intervals are built from sampled elevations, then each detected
transition is refined by bisection on the elevation function itself. Durations
are measured from refined interval endpoints (real elapsed time), never by
counting samples.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

Interval = tuple[float, float]


@dataclass
class Gap:
    start: float
    end: float
    open_start: bool  # gap begins at the window start: true gap may be longer
    open_end: bool  # gap runs to the window end: true gap may be longer

    @property
    def duration(self) -> float:
        return self.end - self.start


def refine_crossing(f: Callable[[float], float], t_lo: float, t_hi: float, tol_s: float) -> float:
    """Bisection for f(t) = 0 on [t_lo, t_hi], assuming a sign change between the ends."""
    f_lo = f(t_lo)
    while t_hi - t_lo > tol_s:
        mid = 0.5 * (t_lo + t_hi)
        f_mid = f(mid)
        if (f_mid > 0) == (f_lo > 0):
            t_lo, f_lo = mid, f_mid
        else:
            t_hi = mid
    return 0.5 * (t_lo + t_hi)


def visible_intervals(
    ets: np.ndarray,
    elevation_deg: np.ndarray,
    elevation_fn: Callable[[float], float] | None,
    tol_s: float,
) -> tuple[list[Interval], int]:
    """Intervals within [ets[0], ets[-1]] where elevation > 0. Returns (intervals, n_refined)."""
    vis = elevation_deg > 0.0
    intervals: list[Interval] = []
    n_refined = 0
    n = len(ets)
    i = 0
    while i < n:
        if not vis[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and vis[j + 1]:
            j += 1
        if i == 0:
            start = float(ets[0])
        elif elevation_fn is not None:
            start = refine_crossing(elevation_fn, float(ets[i - 1]), float(ets[i]), tol_s)
            n_refined += 1
        else:  # linear interpolation fallback
            e0, e1 = elevation_deg[i - 1], elevation_deg[i]
            start = float(ets[i - 1] + (ets[i] - ets[i - 1]) * (-e0) / (e1 - e0))
        if j == n - 1:
            end = float(ets[-1])
        elif elevation_fn is not None:
            end = refine_crossing(elevation_fn, float(ets[j]), float(ets[j + 1]), tol_s)
            n_refined += 1
        else:
            e0, e1 = elevation_deg[j], elevation_deg[j + 1]
            end = float(ets[j] + (ets[j + 1] - ets[j]) * e0 / (e0 - e1))
        intervals.append((start, end))
        i = j + 1
    return intervals, n_refined


def total_duration(intervals: list[Interval]) -> float:
    return float(sum(e - s for s, e in intervals))


def intersect(a: list[Interval], b: list[Interval]) -> list[Interval]:
    out: list[Interval] = []
    i = j = 0
    while i < len(a) and j < len(b):
        s = max(a[i][0], b[j][0])
        e = min(a[i][1], b[j][1])
        if e > s:
            out.append((s, e))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


def gaps(intervals: list[Interval], t0: float, t1: float) -> list[Gap]:
    """Complement of sorted, disjoint intervals within [t0, t1]."""
    out: list[Gap] = []
    cursor = t0
    for s, e in intervals:
        if s > cursor:
            out.append(Gap(cursor, s, cursor == t0, False))
        cursor = max(cursor, e)
    if cursor < t1:
        out.append(Gap(cursor, t1, cursor == t0, True))
    return out


def longest_gap(intervals: list[Interval], t0: float, t1: float) -> Gap | None:
    g = gaps(intervals, t0, t1)
    return max(g, key=lambda x: x.duration) if g else None


def longest_interval(intervals: list[Interval]) -> Interval | None:
    return max(intervals, key=lambda x: x[1] - x[0]) if intervals else None


def near_horizon_fraction(ets: np.ndarray, elevation_deg: np.ndarray, threshold_deg: float) -> float:
    """Time-weighted (trapezoid on sample intervals) fraction with |elevation| < threshold. Approximate."""
    near = (np.abs(elevation_deg) < threshold_deg).astype(float)
    dt = np.diff(ets)
    if dt.sum() <= 0:
        return 0.0
    return float(np.sum(0.5 * (near[:-1] + near[1:]) * dt) / dt.sum())
