import numpy as np
import pytest

from app import analysis


def sine_case(period=100.0, step=7.0, total=350.0):
    ets = np.arange(0, total + 1e-9, step)
    if ets[-1] < total:
        ets = np.append(ets, total)
    f = lambda t: float(np.sin(2 * np.pi * t / period))  # noqa: E731
    return ets, np.array([f(t) for t in ets]), f


def test_refined_intervals_match_analytic_crossings():
    ets, el, f = sine_case()
    ivs, n_ref = analysis.visible_intervals(ets, el, f, tol_s=1e-3)
    # sin > 0 on (0,50), (100,150), (200,250), (300,350)
    expected = [(0, 50), (100, 150), (200, 250), (300, 350)]
    assert len(ivs) == 4
    for (s, e), (es, ee) in zip(ivs, expected):
        assert s == pytest.approx(es, abs=2e-3) and e == pytest.approx(ee, abs=2e-3)
    assert analysis.total_duration(ivs) == pytest.approx(200, abs=1e-2)
    assert n_ref == 7  # first start is the window start, not a refined crossing


def test_duration_uses_elapsed_time_not_sample_count():
    # Non-uniform final sample: counting samples would give the wrong answer.
    ets = np.array([0.0, 10.0, 20.0, 25.0])
    el = np.array([1.0, 1.0, 1.0, 1.0])
    ivs, _ = analysis.visible_intervals(ets, el, None, 1.0)
    assert analysis.total_duration(ivs) == 25.0


def test_gaps_flags_window_boundaries():
    g = analysis.gaps([(10.0, 20.0), (30.0, 40.0)], 0.0, 50.0)
    assert [(x.start, x.end, x.open_start, x.open_end) for x in g] == [
        (0.0, 10.0, True, False), (20.0, 30.0, False, False), (40.0, 50.0, False, True)]
    lg = analysis.longest_gap([(0.0, 50.0)], 0.0, 50.0)
    assert lg is None
    lg = analysis.longest_gap([], 0.0, 50.0)
    assert lg.duration == 50.0 and lg.open_start and lg.open_end


def test_intersect():
    a = [(0.0, 10.0), (20.0, 30.0)]
    b = [(5.0, 25.0)]
    assert analysis.intersect(a, b) == [(5.0, 10.0), (20.0, 25.0)]
    assert analysis.intersect(a, []) == []


def test_linear_fallback():
    ets = np.array([0.0, 10.0, 20.0])
    el = np.array([-1.0, 1.0, -3.0])
    ivs, _ = analysis.visible_intervals(ets, el, None, 1.0)
    assert ivs[0][0] == pytest.approx(5.0) and ivs[0][1] == pytest.approx(12.5)
