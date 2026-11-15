"""Headline wording from narrative.build, using hand-made metrics (no SPICE needed)."""

from app import narrative
from app.models import BodyMetrics, GapOut, SiteMetrics

DAY = 86400.0
WINDOW = 30 * DAY
STEP = 1800.0


def body(visible_days: float, gap_days: float | None) -> BodyMetrics:
    """Metrics for one body: visible for `visible_days`, longest closed gap of `gap_days` (None = never sets)."""
    gap = None if gap_days is None else GapOut(
        start_utc="2026-12-05T00:00:00Z", end_utc="2026-12-10T00:00:00Z",
        duration_s=gap_days * DAY, open_start=False, open_end=False,
    )
    return BodyMetrics(
        visible_duration_s=visible_days * DAY, visible_fraction=visible_days * DAY / WINDOW,
        longest_visible_s=visible_days * DAY, longest_gap=gap, n_intervals=1,
        el_min_deg=-5.0, el_max_deg=5.0, near_horizon_fraction=0.0,
    )


def site(sun_days: float, sun_gap: float, earth_days: float, earth_gap: float | None) -> SiteMetrics:
    both = min(sun_days, earth_days)
    return SiteMetrics(sun=body(sun_days, sun_gap), earth=body(earth_days, earth_gap),
                       both_duration_s=both * DAY, both_fraction=both * DAY / WINDOW)


def headline(a: SiteMetrics, b: SiteMetrics) -> str:
    return narrative.build("A", "Alpha site", a, "B", "Beta site", b, WINDOW, STEP)[0]


def test_same_winner_named_once():
    # Alpha: more sunlight and a shorter Earth outage. Earth time and the "both" time are equal at both sites.
    a = site(sun_days=18, sun_gap=8, earth_days=15, earth_gap=2)
    b = site(sun_days=15, sun_gap=10, earth_days=15, earth_gap=6)
    h = headline(a, b)
    assert h.count("Alpha site") == 1 and "Beta site" not in h
    assert " and " in h
    assert h == "Alpha site has more sunlight during this window and a shorter longest Earth outage."


def test_different_winners_two_sentences():
    # Alpha: more sunlight. Beta: shorter Earth outage. Everything else equal.
    a = site(sun_days=18, sun_gap=8, earth_days=15, earth_gap=6)
    b = site(sun_days=15, sun_gap=8, earth_days=15, earth_gap=2)
    b = b.model_copy(update={"both_duration_s": a.both_duration_s, "both_fraction": a.both_fraction})
    h = headline(a, b)
    assert h.count("Alpha site") == 1 and h.count("Beta site") == 1
    assert h == "Alpha site has more sunlight during this window. Beta site has a shorter longest Earth outage."


def test_all_equal_is_similar():
    a = site(sun_days=15, sun_gap=8, earth_days=15, earth_gap=6)
    h = headline(a, a.model_copy())
    assert h == "The two sites perform similarly on these criteria during this window."
