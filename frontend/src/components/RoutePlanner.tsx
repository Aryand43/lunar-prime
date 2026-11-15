"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, fetchHealth, postRoute } from "@/lib/api";
import { fmtUtc } from "@/lib/format";
import { greatCircleArc } from "@/lib/geo";
import { DEMO_PARAMS, DEMO_START, DEMO_WAYPOINTS, SOUTH_POLE, type BaseDraft, type PlannerParams } from "@/lib/routeDemo";
import type { RouteRequest, RouteResponse } from "@/lib/routeTypes";
import type { HealthResponse } from "@/lib/types";
import type { GlobePath, GlobeSite, GlobeView } from "./MoonGlobe";
import { EndpointCard, ObjectiveCard, ScheduleCard, WaypointList, idErr, latErr, lonErr, paramErrors } from "./RouteControls";
import { Icon } from "./Scrubber";
import { ComparisonTable, Itinerary, LegTable, RouteMethod, RouteSummary, TrajectoryChart } from "./RouteResults";

const MoonGlobe = dynamic(() => import("./MoonGlobe"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-black text-[13px] text-[#D9DAD8]">Loading 3D globe…</div>,
});

const DISCLAIMER =
  "Conceptual spherical-surface route. Terrain, slopes, obstacles, battery/thermal limits, and communication link budgets are not modelled.";

function toInput(b: BaseDraft) {
  return { id: b.id.trim(), label: b.label.trim(), lat_deg: Number(b.lat), lon_deg: Number(b.lon) };
}

function buildRequest(start: BaseDraft, dest: BaseDraft, wps: BaseDraft[], p: PlannerParams): RouteRequest {
  return {
    start: toInput(start),
    destination: toInput(dest),
    waypoints: wps.map(toInput),
    departure_utc: `${p.departure}:00Z`,
    horizon_hours: Number(p.horizonHours),
    speed_kmh: Number(p.speedKmh),
    max_leg_km: Number(p.maxLegKm),
    grid_minutes: p.gridMinutes,
    max_wait_hours: Number(p.maxWaitHours),
    weights: { distance: Number(p.wDistance), darkness: Number(p.wDarkness), earth_invisible: Number(p.wEarth) },
    distance_scale_km: Number(p.distanceScaleKm),
    exposure_scale_hours: Number(p.exposureScaleHours),
    local_search: p.localSearch,
    mode: p.mode,
  };
}

function Panel({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="" aria-label={title}>
      <header className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-[18px] leading-[24px] font-bold">{title}</h2>
        {aside}
      </header>
      <div className="p-0">{children}</div>
    </section>
  );
}

function nearest(ts: string[], ms: number) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < ts.length; i++) {
    const d = Math.abs(Date.parse(ts[i]) - ms);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

const PLAY_SECONDS = 20;

function RouteScrubber({ res, index, onIndex }: { res: RouteResponse; index: number; onIndex: (i: number) => void }) {
  const tr = res.route!.trajectory!;
  const n = tr.elapsed_s.length;
  const [playing, setPlaying] = useState(false);
  const idxRef = useRef(index);
  useEffect(() => {
    idxRef.current = index;
  }, [index]);
  const bounds = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < n; i++) if (tr.segment_index[i] !== tr.segment_index[i - 1]) out.push(i);
    return out;
  }, [tr, n]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = idxRef.current;
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * (n / PLAY_SECONDS);
      last = now;
      const next = Math.floor(acc);
      if (next >= n - 1) {
        onIndex(n - 1);
        setPlaying(false);
        return;
      }
      if (next !== idxRef.current) onIndex(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, n, onIndex]);

  const seg = res.route!.segments[tr.segment_index[index]];
  const prev = [...bounds].reverse().find((b) => b < index);
  const next = bounds.find((b) => b > index);
  const btn = "flex h-7 min-w-7 items-center justify-center rounded-[2px] border border-line bg-field px-1.5 text-text hover:border-text disabled:opacity-40";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-line bg-bg/95 py-2">
      <div className="flex items-center gap-1">
        <button type="button" className={btn} onClick={() => { if (!playing && index >= n - 1) onIndex(0); setPlaying((p) => !p); }} aria-label={playing ? "Pause route playback" : "Play route"}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button type="button" className={btn} disabled={prev === undefined} onClick={() => prev !== undefined && onIndex(prev)} aria-label="Previous segment"><Icon name="prev" /></button>
        <button type="button" className={btn} disabled={next === undefined} onClick={() => next !== undefined && onIndex(next)} aria-label="Next segment"><Icon name="next" /></button>
      </div>
      <input type="range" min={0} max={n - 1} value={index} onChange={(e) => { setPlaying(false); onIndex(Number(e.target.value)); }} className="min-w-[140px] flex-1" aria-label="Route time" aria-valuetext={fmtUtc(tr.time_utc[index])} />
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] tabular-nums">
        <span className="text-text">{fmtUtc(tr.time_utc[index])}</span>
        <span className="text-muted">day {(tr.elapsed_s[index] / 86400).toFixed(1)}</span>
        <span className={tr.status[index] === "move" ? "text-text font-bold" : "text-muted"}>
          {seg ? (seg.kind === "move" ? `moving ${seg.base_id}→${seg.to_id}` : `waiting at ${seg.base_id}`) : ""}
        </span>
        <span className={tr.sun_el_deg[index] > 0 ? "text-sun-ink" : "text-muted"}>Sun {tr.sun_el_deg[index].toFixed(2)}°</span>
        <span className={tr.earth_el_deg[index] > 0 ? "text-earth-ink" : "text-muted"}>Earth {tr.earth_el_deg[index].toFixed(2)}°</span>
      </div>
    </div>
  );
}

export default function RoutePlanner({ active }: { active: boolean }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [start, setStart] = useState<BaseDraft>(DEMO_START);
  const [dest, setDest] = useState<BaseDraft>(SOUTH_POLE);
  const [customDest, setCustomDest] = useState(false);
  const [wps, setWps] = useState<BaseDraft[]>(DEMO_WAYPOINTS);
  const [p, setP] = useState<PlannerParams>(DEMO_PARAMS);
  const [res, setRes] = useState<RouteResponse | null>(null);
  const [lastReq, setLastReq] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [index, setIndex] = useState(0);
  const [picking, setPicking] = useState<string | null>(null);
  const [showBaseline, setShowBaseline] = useState(true);
  const [showNetwork, setShowNetwork] = useState(true);
  const [view, setView] = useState<{ name: GlobeView; nonce: number }>({ name: "polar", nonce: 0 });
  const abortRef = useRef<AbortController | null>(null);
  const autoRan = useRef(false);

  const invalid =
    [start, dest, ...wps].some((b) => latErr(b.lat) || lonErr(b.lon) || idErr(b.id) || !b.label.trim()) ||
    Object.keys(paramErrors(p)).length > 0;
  const request = useMemo(() => (invalid ? null : buildRequest(start, dest, wps, p)), [invalid, start, dest, wps, p]);
  const stale = res !== null && request !== null && JSON.stringify(request) !== lastReq;

  const run = useCallback(async (req: RouteRequest) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const r = await postRoute(req, ac.signal);
      setRes(r);
      setLastReq(JSON.stringify(req));
      setIndex(0);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof ApiError ? e : new ApiError(String(e), "unknown", 0));
    } finally {
      if (abortRef.current === ac) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchHealth(ac.signal)
      .then((h) => {
        setHealth(h);
        if (h.spice_available && !autoRan.current) {
          autoRan.current = true;
          run(buildRequest(DEMO_START, SOUTH_POLE, DEMO_WAYPOINTS, DEMO_PARAMS));
        }
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setHealthError((e as Error).message);
      });
    return () => ac.abort();
  }, [run]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && setPicking(null);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const onPick = useCallback(
    (lat: number, lon: number) => {
      if (!picking) return;
      const patch = { lat: lat.toFixed(4), lon: lon.toFixed(4) };
      if (picking === "start") setStart((s) => ({ ...s, ...patch }));
      else if (picking === "dest") {
        setCustomDest(true);
        setDest((d) => ({ ...d, ...patch, id: d.id === "south-pole" ? "destination" : d.id, label: d.id === "south-pole" ? "Custom destination" : d.label }));
      } else setWps((list) => list.map((w) => (w.uid === picking ? { ...w, ...patch } : w)));
      setPicking(null);
    },
    [picking],
  );

  const onSelectTime = useCallback(
    (v: string) => {
      const tr = res?.route?.trajectory;
      if (!tr) return;
      const ms = Date.parse(v.replace(" ", "T") + (v.endsWith("Z") ? "" : "Z"));
      if (!Number.isNaN(ms)) setIndex(nearest(tr.time_utc, ms));
    },
    [res],
  );

  const exportJson = () => {
    if (!res) return;
    const blob = new Blob([JSON.stringify({ request: lastReq ? JSON.parse(lastReq) : null, response: res }, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lunar-prime-route_${res.metadata.mode}_${(res.route?.metrics.departure_utc ?? "").slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ----- globe overlays (from the current inputs for markers; from results for paths) -----
  const visited = res?.route?.visited ?? [];
  const resultFresh = res !== null && !stale;
  const markers: GlobeSite[] = [];
  const pushMarker = (b: BaseDraft, kind: GlobeSite["kind"], letter: string) => {
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
      markers.push({ key: b.uid, letter, label: kind === "destination" ? b.label : b.id, lat, lon, kind });
  };
  pushMarker(start, "start", "S");
  wps.forEach((w) => {
    const order = resultFresh ? visited.indexOf(w.id) : -1;
    pushMarker(w, order > 0 ? "visited" : "candidate", order > 0 ? String(order) : "");
  });
  pushMarker(dest, "destination", "End");

  const basePos = useMemo(() => new Map((res?.bases ?? []).map((b) => [b.id, [b.lat_deg, b.lon_deg] as [number, number]])), [res]);
  const paths: GlobePath[] = useMemo(() => {
    if (!res) return [];
    const out: GlobePath[] = [];
    const arcs = (ids: string[], r: number) => ids.slice(0, -1).flatMap((id, i) => greatCircleArc(basePos.get(id)!, basePos.get(ids[i + 1])!, r, 48));
    if (showNetwork) {
      const seen = new Set<string>();
      res.candidate_legs.forEach((l) => {
        const k = [l.from_id, l.to_id].sort().join("|");
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ key: `net-${k}`, points: greatCircleArc(basePos.get(l.from_id)!, basePos.get(l.to_id)!, 1.0012, 24), color: "#9AA3AD", opacity: 0.3 });
      });
    }
    if (showBaseline && res.baseline.plan) out.push({ key: "baseline", points: arcs(res.baseline.plan.visited, 1.0018), color: "#9AA3AD", dashed: true, opacity: 0.95 });
    if (res.route) out.push({ key: "route", points: arcs(res.route.visited, 1.0024), color: "#FFFFFF" });
    return out;
  }, [res, basePos, showBaseline, showNetwork]);

  const tr = res?.route?.trajectory ?? null;
  const i = tr ? Math.min(index, tr.elapsed_s.length - 1) : 0;
  const subsolar = tr ? { lat: tr.subsolar_lat_deg[i], lon: tr.subsolar_lon_deg[i] } : null;
  const subEarth = tr ? { lat: tr.sub_earth_lat_deg[i], lon: tr.sub_earth_lon_deg[i] } : null;
  const rover = tr ? { lat: tr.lat_deg[i], lon: tr.lon_deg[i] } : null;
  const synthetic = res?.metadata.mode === "synthetic";

  return (
    <div className="grid flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="space-y-8 border-b border-line p-6 lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:overflow-y-auto lg:border-r lg:border-b-0">
        <EndpointCard title="Start" draft={start} onChange={setStart} picking={picking === "start"} onTogglePick={() => setPicking((x) => (x === "start" ? null : "start"))} />
        <EndpointCard title="Destination" draft={dest} onChange={(d) => { setDest(d); setCustomDest(true); }} picking={picking === "dest"} onTogglePick={() => setPicking((x) => (x === "dest" ? null : "dest"))}>
          {customDest ? (
            <button type="button" onClick={() => { setDest(SOUTH_POLE); setCustomDest(false); }} className="rounded-[2px] border border-line px-1.5 py-0.5 text-[13px] text-muted hover:text-text">
              Reset to south pole
            </button>
          ) : (
            <span className="text-[13px] text-muted">default: −90°, 0°</span>
          )}
        </EndpointCard>
        <WaypointList items={wps} onChange={setWps} picking={picking} onTogglePick={(uid) => setPicking((x) => (x === uid ? null : uid))} onReset={() => setWps(DEMO_WAYPOINTS)} />
        <ScheduleCard p={p} onChange={setP} />
        <ObjectiveCard p={p} onChange={setP} />
        <div className="sticky bottom-0 -mx-6 -mb-6 space-y-2 border-t border-line bg-bg px-6 py-4 ">
          <button
            type="button"
            disabled={!request || loading}
            onClick={() => request && run(request)}
            className="w-full rounded-[2px] bg-text px-3 py-2 text-[15px] font-bold text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "Optimizing…" : "Optimize route"}
          </button>
          {invalid && <p className="text-[13px] text-danger">Fix the highlighted fields to optimize.</p>}
        </div>
      </aside>

      <main className="min-w-0 space-y-10 px-6 py-8 xl:px-10">
        <div role="note" className="border border-text bg-field px-3 py-2 text-[14px] text-text">
          <b>{DISCLAIMER}</b>
          <span className="block text-[13px] font-normal text-muted">
            Waypoints are hypothetical. Sunlight ≠ power, Earth visibility ≠ communication. Not a certified or globally optimal route.
          </span>
        </div>
        {synthetic && (
          <div role="alert" className="border border-text bg-field px-3 py-1.5 text-[13px] text-text">
            <b>Synthetic demo mode.</b> Sun and Earth positions come from a crude analytic model. They are not SPICE results and not NASA data.
          </div>
        )}
        {healthError && (
          <div role="alert" className="border border-danger bg-field p-3 text-[13px]">
            <p className="font-bold text-danger">Backend unreachable</p>
            <p className="mt-1">{healthError}</p>
          </div>
        )}
        {health && !health.spice_available && p.mode === "spice" && (
          <div role="alert" className="border border-text bg-field p-3 text-[13px]">
            <p className="font-bold text-text">SPICE kernels unavailable: the planner will not fall back to synthetic data on its own.</p>
            <p className="mt-1">{health.error}</p>
            <button type="button" onClick={() => setP((x) => ({ ...x, mode: "synthetic" }))} className="mt-2 rounded-[2px] border border-text px-2 py-1 text-[13px] text-text hover:bg-bg">
              Use synthetic demo data (not scientific)
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="border border-danger bg-field p-3 text-[13px]">
            <p className="font-bold text-danger">
              {error.code === "invalid_request" ? "The request was rejected" : error.code === "spice_unavailable" ? "SPICE unavailable" : "Optimization failed"}
            </p>
            <p className="mt-1 text-text">{error.message}</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="relative h-[440px] overflow-hidden bg-space sm:h-[560px]">
            <MoonGlobe
              sites={markers}
              subsolar={subsolar}
              subEarth={subEarth}
              picking={picking}
              onPick={onPick}
              view={view}
              paths={paths}
              rover={resultFresh ? rover : null}
              compact
              ambient={0.32}
              active={active}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-2 p-2.5">
              <div className="pointer-events-auto flex flex-wrap gap-1" role="group" aria-label="Globe view and layers">
                {(
                  [
                    ["polar", "South pole close-up"],
                    ["south", "South hemisphere"],
                  ] as [GlobeView, string][]
                ).map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setView((x) => ({ name: v, nonce: x.nonce + 1 }))} className={`rounded-[2px] border px-2.5 py-1 text-[13px] ${view.name === v ? "border-white bg-white text-black" : "border-[#55585c] bg-black/60 text-[#D9DAD8] hover:border-white"}`}>
                    {label}
                  </button>
                ))}
                <label className="flex items-center gap-1.5 rounded-[2px] border border-[#55585c] bg-black/60 px-2.5 py-1 text-[13px] text-[#D9DAD8]">
                  <input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} className="accent-white" />
                  Baseline (dashed)
                </label>
                <label className="flex items-center gap-1.5 rounded-[2px] border border-[#55585c] bg-black/60 px-2.5 py-1 text-[13px] text-[#D9DAD8]">
                  <input type="checkbox" checked={showNetwork} onChange={(e) => setShowNetwork(e.target.checked)} className="accent-white" />
                  Candidate legs
                </label>
              </div>
              {picking && (
                <span className="rounded-[2px] border border-white bg-black/70 px-2 py-1 text-[13px] font-bold text-white">Click the Moon to place it. Press Esc to cancel.</span>
              )}
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 space-y-1 p-3 text-[13px] leading-[18px] text-[#D9DAD8]">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-white" /> Optimized route</span>
                <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-[#9AA3AD]" /> Shortest-distance baseline</span>
                <span className="flex items-center gap-1.5"><span className="h-px w-4 bg-[#9AA3AD] opacity-60" /> Candidate legs within the maximum leg length</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-white" /> Rover position</span>
              </div>
              <div>
                Globe shading is illustrative (lit from the computed subsolar point, with extra ambient light); use the elevation values for analysis.
                {stale && <span className="font-bold text-white"> Inputs changed: paths show the previous result.</span>}
              </div>
            </div>
          </div>

          <Panel title="Optimized route" aside={res && <span className="tabular-nums text-[13px] text-muted">{res.search.compute_time_ms.toFixed(0)} ms</span>}>
            {res ? <RouteSummary res={res} /> : <p className="text-[13px] text-muted">{loading ? "Optimizing with SPICE geometry…" : "Run the optimizer to see a route."}</p>}
          </Panel>
        </div>

        {res?.route?.trajectory && (
          <div className="sticky top-14 z-30">
            <RouteScrubber key={lastReq ?? ""} res={res} index={i} onIndex={setIndex} />
          </div>
        )}

        <div className={`space-y-3 transition-opacity ${loading || stale ? "opacity-60" : ""}`}>
          {stale && !loading && (
            <div className="flex items-center justify-between gap-3 border border-text bg-field px-3 py-2 text-[13px] text-text">
              <span>Inputs changed since the last optimization. Results below are for the previous inputs.</span>
              <button type="button" onClick={() => request && run(request)} className="shrink-0 rounded-[2px] border border-text bg-text px-2 py-0.5 font-bold text-bg hover:opacity-90">
                Re-optimize
              </button>
            </div>
          )}
          {res?.route?.trajectory && (
            <Panel title="Sun and Earth elevation along the moving trajectory" aside={<span className="text-[13px] text-muted">Shaded periods are waits. The dashed line is the ideal horizon. Click the chart to set the time.</span>}>
              <TrajectoryChart plan={res.route} index={i} onSelectTime={onSelectTime} />
            </Panel>
          )}
          {res && (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {res.route && (
                <Panel title="Itinerary">
                  <Itinerary plan={res.route} />
                </Panel>
              )}
              <Panel title="Optimized vs shortest-distance baseline">
                <ComparisonTable res={res} />
              </Panel>
            </div>
          )}
          {res?.route && (
            <Panel title="Segments: distance and exposure">
              <LegTable plan={res.route} />
            </Panel>
          )}
          {res && (
            <Panel title="Method, limitations & provenance">
              <RouteMethod res={res} onExport={exportJson} />
            </Panel>
          )}
        </div>
      </main>
    </div>
  );
}
