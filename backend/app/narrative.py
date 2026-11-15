"""Deterministic plain-language comparisons derived only from computed metrics.

No language model is involved: every sentence is a template filled with
numbers from SiteMetrics, with explicit tolerance and window-boundary handling.
"""

from __future__ import annotations

from . import config
from .models import BodyMetrics, SiteMetrics, Statement


def fmt_duration(s: float) -> str:
    if s >= 2 * 86400:
        return f"{s / 86400:.1f} d"
    if s >= 2 * 3600:
        return f"{s / 3600:.1f} h"
    if s >= 120:
        return f"{s / 60:.0f} min"
    return f"{s:.0f} s"


def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _gap(m: BodyMetrics) -> tuple[float, bool]:
    """(duration, is_lower_bound) of the longest gap; 0 if the body never sets."""
    if m.longest_gap is None:
        return 0.0, False
    return m.longest_gap.duration_s, (m.longest_gap.open_start or m.longest_gap.open_end)


def _gap_str(d: float, lower_bound: bool) -> str:
    return ("at least " if lower_bound else "") + fmt_duration(d)


def build(
    a_id: str, a_label: str, a: SiteMetrics,
    b_id: str, b_label: str, b: SiteMetrics,
    window_s: float, step_s: float,
    a_terrain: bool = False, b_terrain: bool = False,
) -> tuple[str, list[Statement], float]:
    tol = max(2.0 * step_s, 0.005 * window_s)
    stmts: list[Statement] = []
    # (headline phrase without a subject, favoured id, favoured label) for each decisive comparison
    decisive: dict[str, tuple[str, str, str]] = {}

    def more_is_better(key: str, noun: str, va: float, fa: float, vb: float, fb: float, headline: str):
        if abs(va - vb) < tol:
            stmts.append(Statement(
                id=key, kind="comparison", favors=None,
                text=f"{noun.capitalize()}: similar at both sites ({_pct(fa)} vs {_pct(fb)} of the window; "
                     f"difference below the {fmt_duration(tol)} reporting tolerance).",
            ))
            return
        win_id, win, lose = (a_id, a_label, b_label) if va > vb else (b_id, b_label, a_label)
        hi, lo = (va, vb) if va > vb else (vb, va)
        fhi, flo = (fa, fb) if va > vb else (fb, fa)
        stmts.append(Statement(
            id=key, kind="comparison", favors=win_id,
            text=f"{win} has more {noun}: {fmt_duration(hi)} ({_pct(fhi)}) vs {fmt_duration(lo)} ({_pct(flo)}) at {lose}.",
        ))
        decisive[key] = (headline, win_id, win)

    def shorter_gap_is_better(key: str, noun: str, ma: BodyMetrics, mb: BodyMetrics, headline: str):
        da, la = _gap(ma)
        db, lb = _gap(mb)
        if abs(da - db) < tol and not (la or lb):
            stmts.append(Statement(
                id=key, kind="comparison", favors=None,
                text=f"Longest {noun}: similar at both sites ({fmt_duration(da)} vs {fmt_duration(db)}).",
            ))
            return
        short_id, short, s_d, s_lb, long_, l_d, l_lb = (
            (a_id, a_label, da, la, b_label, db, lb) if da < db else (b_id, b_label, db, lb, a_label, da, la)
        )
        if s_lb or abs(da - db) < tol:
            # The shorter value is only a lower bound (gap truncated by the window): cannot rank.
            stmts.append(Statement(
                id=key, kind="comparison", favors=None,
                text=f"Longest {noun}: {a_label} {_gap_str(da, la)}, {b_label} {_gap_str(db, lb)}. "
                     "These cannot be ranked because at least one gap is cut off by the window boundary; "
                     "extend the window to resolve it.",
            ))
            return
        short_txt = "none (continuous)" if s_d == 0 else fmt_duration(s_d)
        stmts.append(Statement(
            id=key, kind="comparison", favors=short_id,
            text=f"{short}'s longest {noun} is shorter: {short_txt}, against {_gap_str(l_d, l_lb)} at {long_}.",
        ))
        decisive[key] = (headline, short_id, short)

    more_is_better("sun_duration", "sunlight", a.sun.visible_duration_s, a.sun.visible_fraction,
                   b.sun.visible_duration_s, b.sun.visible_fraction, "more sunlight during this window")
    more_is_better("earth_duration", "geometric Earth visibility", a.earth.visible_duration_s,
                   a.earth.visible_fraction, b.earth.visible_duration_s, b.earth.visible_fraction,
                   "more Earth visibility")
    more_is_better("both_duration", "simultaneous sunlight and Earth visibility", a.both_duration_s,
                   a.both_fraction, b.both_duration_s, b.both_fraction, "more simultaneous sunlight and Earth visibility")
    shorter_gap_is_better("sun_gap", "night", a.sun, b.sun, "a shorter longest night")
    shorter_gap_is_better("earth_gap", "Earth outage", a.earth, b.earth,
                          "a shorter longest Earth outage")

    sites = ((a_id, a_label, a, a_terrain), (b_id, b_label, b, b_terrain))

    # Observations: absolute conditions, stated per site.
    for sid, label, m, terr in sites:
        horizon = "the local skyline" if terr else "the ideal horizon"
        for body, bm, name in (("sun", m.sun, "The Sun"), ("earth", m.earth, "Earth")):
            if bm.visible_fraction == 0.0:
                stmts.append(Statement(id=f"{sid}_{body}_never", kind="observation", favors=None,
                                       text=f"{name} never rises above {horizon} at {label} during this window "
                                            f"(maximum elevation {bm.el_max_deg:.2f}°)."))
            elif bm.longest_gap is None:
                stmts.append(Statement(id=f"{sid}_{body}_always", kind="observation", favors=None,
                                       text=f"{name} stays above {horizon} at {label} for the entire window "
                                            f"(minimum elevation {bm.el_min_deg:.2f}°)."))

    # Caveats: where results are fragile with respect to terrain and finite discs.
    for sid, label, m, terr in sites:
        if terr:
            stmts.append(Statement(
                id=f"{sid}_terrain_resolution", kind="caveat", favors=None,
                text=f"At {label}, the skyline comes from 80 m and 240 m LOLA maps, so features smaller than that are not resolved.",
            ))
            continue
        for body, bm, name in (("sun", m.sun, "the Sun"), ("earth", m.earth, "Earth")):
            if bm.near_horizon_fraction >= 0.10:
                stmts.append(Statement(
                    id=f"{sid}_{body}_horizon", kind="caveat", favors=None,
                    text=f"At {label}, {name} is within ±{config.NEAR_HORIZON_DEG:.0f}° of the ideal horizon for about "
                         f"{_pct(bm.near_horizon_fraction)} of the window, so real terrain could change this result.",
                ))

    order = ["sun_duration", "earth_gap", "earth_duration", "sun_gap", "both_duration"]
    picks = [decisive[k] for k in order if k in decisive][:2]
    if not picks:
        headline = "The two sites perform similarly on these criteria during this window."
    elif len(picks) == 1:
        headline = f"{picks[0][2]} has {picks[0][0]}."
    elif picks[0][1] == picks[1][1]:
        # Same winner on both criteria: name it once.
        headline = f"{picks[0][2]} has {picks[0][0]} and {picks[1][0]}."
    else:
        headline = f"{picks[0][2]} has {picks[0][0]}. {picks[1][2]} has {picks[1][0]}."
    return headline, stmts, tol
