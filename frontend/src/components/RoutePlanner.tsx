"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, fetchHealth, fetchRun, fetchSites, postPreflight, postRoute } from "@/lib/api";
import type { ChatRef } from "@/lib/chatApi";
import { fmtLatLon } from "@/lib/coords";
import { fmtDuration, fmtUtc } from "@/lib/format";
import { greatCircleArc, latLonToVec3 } from "@/lib/geo";
import { DEMO_PARAMS, DEMO_WAYPOINTS, GRID_OPTIONS, SOUTH_POLE, type BaseDraft, type PlannerParams } from "@/lib/routeDemo";
import type { PreflightResponse, RouteRequest, RouteResponse } from "@/lib/routeTypes";
import { CATEGORY_COLOR, CATEGORY_LABEL, type Site } from "@/lib/siteTypes";
import type { HealthResponse } from "@/lib/types";
import MissionAnalyst from "./MissionAnalyst";
import type { GlobePath, GlobeSite, GlobeView, LiveState } from "./MoonGlobe";
import { EndpointCard, ObjectiveCard, WaypointList, idErr, latErr, lonErr, paramErrors } from "./RouteControls";
import { ComparisonTable, Itinerary, LegTable, RouteMethod, TrajectoryChart } from "./RouteResults";
import SiteDetails from "./SiteDetails";
import StartPicker, { type StartValue } from "./StartPicker";

const MoonGlobe = memo(dynamic(() => import("./MoonGlobe"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading 3D globe…</div>,
}));

const DISCLAIMER = "Conceptual surface route · No terrain or vehicle constraints.";
const DEFAULT_START: StartValue = { lat: -86, lon: 0, label: "Custom start" };
const SPEEDS = [0.5, 1, 2, 4];
const PLAY_SECONDS = 20;
type Layer = "sites" | "planning" | "network" | "baseline";
type Tab = "itinerary" | "chart" | "baseline" | "method";

const inputCls =
  "w-full min-w-0 rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-text focus:border-accent focus:outline-none aria-[invalid=true]:border-danger";
const labelCls = "mb-1 block text-[10px] uppercase tracking-wider text-muted";

function toInput(b: BaseDraft) {
  return { id: b.id.trim(), label: b.label.trim(), lat_deg: Number(b.lat), lon_deg: Number(b.lon) };
}

function buildRequest(start: StartValue, dest: BaseDraft, wps: BaseDraft[], p: PlannerParams): RouteRequest {
  return {
    start: { id: "start", label: (start.label || "Start").slice(0, 64), lat_deg: start.lat, lon_deg: start.lon },
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
    auto_network: p.autoNetwork,
    include_catalog_sites: p.includeCatalog,
    planning_mode: p.planningMode,
    auto_fit: p.autoFit,
    mode: p.mode,
  };
}

const shortName = (label: string | undefined, id: string) => {
  if (!label) return id;
  const m = label.match(/^Planning waypoint (\S+)$/);
  if (m) return `PW ${m[1]}`;
  return label.replace(/^Catalogue site: /, "").replace(/^Hypothetical waypoint /, "");
};

function Field({ label, value, onChange, err, unit }: { label: string; value: string; onChange: (v: string) => void; err?: string; unit?: string }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}{unit && <span className="ml-1 normal-case text-faint">({unit})</span>}</span>
      <input className={inputCls} inputMode="decimal" value={value} aria-invalid={!!err} onChange={(e) => onChange(e.target.value)} />
      {err && <span className="mt-0.5 block text-[11px] text-danger">{err}</span>}
    </label>
  );
}

function PlaybackBar({ res, index, onIndex, live, playing, setPlaying }: {
  res: RouteResponse;
  index: number;
  onIndex: (i: number) => void;
  live: React.RefObject<LiveState>;
  playing: boolean;
  setPlaying: (p: boolean) => void;
}) {
  const tr = res.route!.trajectory!;
  const n = tr.elapsed_s.length;
  const [speed, setSpeed] = useState(1);
  const idx = useRef(index);
  useEffect(() => {
    idx.current = index;
  }, [index]);
  const bounds = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < n; i++) if (tr.segment_index[i] !== tr.segment_index[i - 1]) out.push(i);
    return out;
  }, [tr, n]);
  useEffect(() => {
    if (!playing || n < 2) return;
    let raf = 0;
    let last = performance.now();
    let acc = idx.current;
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * (n / PLAY_SECONDS) * speed;
      last = now;
      if (acc >= n - 1) {
        onIndex(n - 1);
        setPlaying(false);
        return;
      }
      // Interpolate between samples for smooth motion; React state only changes on whole samples.
      const i = Math.floor(acc);
      const f = acc - i;
      live.current.rover = { lat: tr.lat_deg[i] + (tr.lat_deg[i + 1] - tr.lat_deg[i]) * f, lon: lerpLon(tr.lon_deg[i], tr.lon_deg[i + 1], f) };
      if (i !== idx.current) onIndex(i);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, n, onIndex, speed, tr, live, setPlaying]);

  const seg = res.route!.segments[tr.segment_index[index]];
  const prev = [...bounds].reverse().find((b) => b < index);
  const next = bounds.find((b) => b > index);
  const btn = "flex h-7 min-w-7 items-center justify-center rounded border border-line bg-black/40 px-1.5 text-[12px] text-muted hover:text-text disabled:opacity-40";
  return (
    <div className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border border-line bg-panel/90 px-2.5 py-1.5 shadow-lg backdrop-blur">
      <div className="flex items-center gap-1">
        <button type="button" className={btn} onClick={() => { if (!playing && index >= n - 1) onIndex(0); setPlaying(!playing); }} aria-label={playing ? "Pause playback" : "Play route"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" className={btn} disabled={prev === undefined} onClick={() => prev !== undefined && onIndex(prev)} aria-label="Previous segment">⇤</button>
        <button type="button" className={btn} disabled={next === undefined} onClick={() => next !== undefined && onIndex(next)} aria-label="Next segment">⇥</button>
        <select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="h-7 rounded border border-line bg-black/40 px-1 font-mono text-[11px] text-muted">
          {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
      </div>
      <input type="range" min={0} max={Math.max(0, n - 1)} value={index} onChange={(e) => { setPlaying(false); onIndex(Number(e.target.value)); }} className="min-w-[120px] flex-1" aria-label="Route time" aria-valuetext={fmtUtc(tr.time_utc[index])} />
      <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] tabular-nums">
        <span className="text-text">{fmtUtc(tr.time_utc[index]).slice(0, 16)}</span>
        <span className="text-faint">T+{fmtDuration(tr.elapsed_s[index])}</span>
        <span className={tr.status[index] === "move" ? "text-accent" : "text-muted"}>{seg ? (seg.kind === "move" ? "moving" : "waiting") : "at destination"}</span>
        <span className={tr.sun_el_deg[index] > 0 ? "text-sun" : "text-faint"} title="Sun centre elevation">☉ {tr.sun_el_deg[index].toFixed(1)}°</span>
        <span className={tr.earth_el_deg[index] > 0 ? "text-earth" : "text-faint"} title="Earth centre elevation">⊕ {tr.earth_el_deg[index].toFixed(1)}°</span>
      </div>
    </div>
  );
}

/** Sun-visible and Earth-visible windows along the returned trajectory (body centre above the ideal horizon). */
function VisibilityStrip({ tr, index, onIndex }: { tr: NonNullable<NonNullable<RouteResponse["route"]>["trajectory"]>; index: number; onIndex: (i: number) => void }) {
  const total = tr.elapsed_s[tr.elapsed_s.length - 1] || 1;
  const runs = (el: number[]) => {
    const out: [number, number][] = [];
    let s0: number | null = null;
    el.forEach((e, k) => {
      if (e > 0 && s0 === null) s0 = tr.elapsed_s[k];
      if (e <= 0 && s0 !== null) { out.push([s0, tr.elapsed_s[k]]); s0 = null; }
    });
    if (s0 !== null) out.push([s0, total]);
    return out;
  };
  const sun = useMemo(() => runs(tr.sun_el_deg), [tr]); // eslint-disable-line react-hooks/exhaustive-deps
  const earth = useMemo(() => runs(tr.earth_el_deg), [tr]); // eslint-disable-line react-hooks/exhaustive-deps
  const row = (label: string, color: string, data: [number, number][]) => (
    <div className="flex items-center gap-2">
      <span className="w-[150px] shrink-0 text-[10.5px] text-muted">{label}</span>
      <div className="relative h-2.5 flex-1 rounded-sm bg-black/50">
        {data.map(([a, b]) => (
          <span key={a} className="absolute inset-y-0 rounded-sm" style={{ left: `${(a / total) * 100}%`, width: `${Math.max(0.3, ((b - a) / total) * 100)}%`, background: color }} />
        ))}
        <span className="absolute inset-y-[-2px] w-px bg-white" style={{ left: `${(tr.elapsed_s[index] / total) * 100}%` }} />
      </div>
    </div>
  );
  return (
    <div
      className="cursor-pointer space-y-1"
      role="slider"
      tabIndex={0}
      aria-label="Sun and Earth visibility along the route; click to seek"
      aria-valuemin={0}
      aria-valuemax={tr.elapsed_s.length - 1}
      aria-valuenow={index}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onIndex(Math.min(tr.elapsed_s.length - 1, index + 1));
        if (e.key === "ArrowLeft") onIndex(Math.max(0, index - 1));
      }}
      onClick={(e) => {
        const bar = e.currentTarget.querySelector("div > div") as HTMLElement;
        const b = bar.getBoundingClientRect();
        onIndex(nearestElapsed(tr.elapsed_s, ((e.clientX - b.left) / b.width) * total));
      }}
    >
      {row("☉ Sun above horizon", "#f2b84b", sun)}
      {row("⊕ Earth in line of sight", "#6b9cff", earth)}
      <p className="text-[10px] text-faint">Body centre above an ideal, terrain-free horizon along the route (UTC time axis, sampled ≤ 10 min). Line of sight is not a guaranteed communication link.</p>
    </div>
  );
}

function lerpLon(a: number, b: number, f: number) {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  let x = a + d * f;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

function nearestElapsed(el: number[], t: number) {
  let lo = 0;
  let hi = el.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (el[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(el[hi] - t) < Math.abs(el[lo] - t) ? hi : lo;
}

export default function RoutePlanner({ active }: { active: boolean }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [start, setStart] = useState<StartValue>(DEFAULT_START);
  const [startRev, setStartRev] = useState(0);
  const [dest, setDest] = useState<BaseDraft>(SOUTH_POLE);
  const [wps, setWps] = useState<BaseDraft[]>([]);
  const [p, setP] = useState<PlannerParams>(DEMO_PARAMS);
  const [res, setRes] = useState<RouteResponse | null>(null);
  const [lastReq, setLastReq] = useState<string | null>(null);
  const [viewingOther, setViewingOther] = useState<RouteRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ sites: true, planning: true, network: false, baseline: true });
  const [view, setView] = useState<{ name: GlobeView; nonce: number }>({ name: "polar", nonce: 0 });
  const [focus, setFocus] = useState<{ points: [number, number][]; nonce: number } | null>(null);
  const [follow, setFollow] = useState(false);
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [selectedSeg, setSelectedSeg] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [analystOpen, setAnalystOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<"plan" | "results" | "analyst">("plan");
  const [showLimits, setShowLimits] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const autoRan = useRef(false);
  const live = useRef<LiveState>({ rover: null, subsolar: null });

  const destErrs = latErr(dest.lat) || lonErr(dest.lon) || idErr(dest.id) || !dest.label.trim();
  const wpErrs = wps.some((b) => latErr(b.lat) || lonErr(b.lon) || idErr(b.id) || !b.label.trim());
  const pErrs = paramErrors(p);
  const invalid = !!destErrs || wpErrs || Object.keys(pErrs).length > 0;
  const request = useMemo(() => (invalid ? null : buildRequest(start, dest, wps, p)), [invalid, start, dest, wps, p]);
  const reqKey = request ? JSON.stringify(request) : null;
  const stale = res !== null && reqKey !== null && reqKey !== lastReq;
  const customDest = dest.id !== SOUTH_POLE.id || dest.lat !== SOUTH_POLE.lat || dest.lon !== SOUTH_POLE.lon;

  const run = useCallback(async (req: RouteRequest) => {
    abortRef.current?.abort(); // abort the stale request
    const ac = new AbortController();
    abortRef.current = ac;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    setPlaying(false);
    try {
      const r = await postRoute(req, ac.signal);
      if (my !== seq.current) return; // a newer request owns the UI
      setRes(r);
      setViewingOther(null);
      setLastReq(JSON.stringify(req));
      setIndex(0);
      setSelectedSeg(null);
      const pts = r.route?.trajectory ? r.route.trajectory.lat_deg.map((la, i) => [la, r.route!.trajectory!.lon_deg[i]] as [number, number]) : r.bases.map((b) => [b.lat_deg, b.lon_deg] as [number, number]);
      setFocus((f) => ({ points: pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 200)) === 0).concat([pts[pts.length - 1]]), nonce: (f?.nonce ?? 0) + 1 }));
    } catch (e) {
      if ((e as Error).name === "AbortError" || my !== seq.current) return;
      setError(e instanceof ApiError ? e : new ApiError(String(e), "unknown", 0));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchHealth(ac.signal)
      .then((h) => {
        setHealth(h);
        if (h.spice_available && !autoRan.current) {
          autoRan.current = true;
          run(buildRequest(DEFAULT_START, SOUTH_POLE, [], DEMO_PARAMS));
        }
      })
      .catch((e) => (e as Error).name !== "AbortError" && setHealthError((e as Error).message));
    fetchSites(ac.signal).then((c) => setSites(c.sites)).catch(() => undefined);
    return () => ac.abort();
  }, [run]);

  // Live preflight: distance, travel-time lower bound and work estimate (pure geometry on the server).
  useEffect(() => {
    if (!request) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      postPreflight(request, ac.signal).then(setPreflight).catch(() => undefined);
    }, 350);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [request]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicking(null);
      setSelectedSite(null);
      setShowLimits(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const setStartExternal = useCallback((v: StartValue) => {
    setStart(v);
    setStartRev((r) => r + 1);
  }, []);

  const onPick = useCallback(
    (lat: number, lon: number) => {
      if (!picking) return;
      if (picking === "start") setStartExternal({ lat, lon, label: "Picked on globe" });
      else if (picking === "dest") setDest((d) => ({ ...d, lat: lat.toFixed(6), lon: lon.toFixed(6), id: d.id === "south-pole" ? "destination" : d.id, label: d.id === "south-pole" ? "Custom destination" : d.label }));
      else setWps((list) => list.map((w) => (w.uid === picking ? { ...w, lat: lat.toFixed(6), lon: lon.toFixed(6) } : w)));
      setPicking(null);
    },
    [picking, setStartExternal],
  );

  const useSite = useCallback((s: Site) => {
    if (s.lat_deg === null || s.lon_deg === null) return;
    setStartExternal({ lat: s.lat_deg, lon: s.lon_deg, label: s.name, siteId: s.id });
    setSelectedSite(null);
  }, [setStartExternal]);

  const siteWpId = (s: Site) => ("C_" + s.id.replace(/-/g, "_")).slice(0, 32);
  const toggleInclude = (s: Site) => {
    const id = siteWpId(s);
    setWps((list) =>
      list.some((w) => w.id === id)
        ? list.filter((w) => w.id !== id)
        : [...list, { uid: `site-${s.id}`, id, label: `Catalogue site: ${s.name}`.slice(0, 64), lat: String(s.lat_deg), lon: String(s.lon_deg) }],
    );
  };

  const tr = res?.route?.trajectory ?? null;
  const i = tr ? Math.min(index, tr.elapsed_s.length - 1) : 0;
  // Playback writes `live` every animation frame; scrubbing/seek writes it here.
  useEffect(() => {
    live.current.rover = tr ? { lat: tr.lat_deg[i], lon: tr.lon_deg[i] } : null;
    live.current.subsolar = tr ? { lat: tr.subsolar_lat_deg[i], lon: tr.subsolar_lon_deg[i] } : null;
  }, [tr, i]);

  const baseById = useMemo(() => new Map((res?.bases ?? []).map((b) => [b.id, b])), [res]);
  const name = useCallback((id: string) => shortName(baseById.get(id)?.label, id), [baseById]);

  // ---------------- globe layers (memoised: playback never rebuilds them) ----------------
  const markers: GlobeSite[] = useMemo(() => {
    const out: GlobeSite[] = [];
    const fresh = res !== null && !stale;
    const visited = fresh ? res!.route?.visited ?? [] : [];
    if (layers.sites)
      for (const s of sites)
        if (s.lat_deg !== null && s.lon_deg !== null && (s.category === "crewed_landing" || s.category === "robotic_landing"))
          out.push({ key: `cat:${s.id}`, letter: "", label: s.name, detail: `${CATEGORY_LABEL[s.category]} · ${s.agency}`, lat: s.lat_deg, lon: s.lon_deg, kind: s.category === "crewed_landing" ? "crewed" : "robotic", hoverOnly: true, interactive: true });
    if (fresh && res)
      for (const b of res.bases) {
        if (b.role !== "waypoint") continue;
        const order = visited.indexOf(b.id);
        if (order > 0) out.push({ key: `wp:${b.id}`, letter: String(order), label: shortName(b.label, b.id), lat: b.lat_deg, lon: b.lon_deg, kind: "visited" });
        else if (b.kind === "planning" ? layers.planning : true)
          out.push({ key: `wp:${b.id}`, letter: "", label: shortName(b.label, b.id), detail: b.kind === "planning" ? "Hypothetical planning waypoint" : undefined, lat: b.lat_deg, lon: b.lon_deg, kind: b.kind === "planning" ? "planning" : "user", hoverOnly: true });
      }
    if (!fresh)
      for (const w of wps) {
        const la = Number(w.lat);
        const lo = Number(w.lon);
        if (Number.isFinite(la) && Number.isFinite(lo)) out.push({ key: `wp:${w.uid}`, letter: "", label: shortName(w.label, w.id), lat: la, lon: lo, kind: "user", hoverOnly: true });
      }
    out.push({ key: "start", letter: "S", label: start.label, lat: start.lat, lon: start.lon, kind: "start" });
    const dl = Number(dest.lat);
    const dn = Number(dest.lon);
    if (Number.isFinite(dl) && Number.isFinite(dn)) out.push({ key: "dest", letter: "◎", label: customDest ? dest.label : "South Pole", lat: dl, lon: dn, kind: "destination" });
    return out;
  }, [res, stale, layers.sites, layers.planning, sites, wps, start, dest, customDest]);

  const paths: GlobePath[] = useMemo(() => {
    if (!res) return [];
    const out: GlobePath[] = [];
    const pos = (id: string) => {
      const b = baseById.get(id)!;
      return [b.lat_deg, b.lon_deg] as [number, number];
    };
    if (layers.network) {
      const seen = new Set<string>();
      for (const l of res.candidate_legs) {
        const k = [l.from_id, l.to_id].sort().join("|");
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ key: `net-${k}`, points: greatCircleArc(pos(l.from_id), pos(l.to_id), 1.0012, 16), color: "#8b919b", opacity: 0.3, width: 1 });
      }
    }
    if (layers.baseline && res.baseline.plan) {
      const v = res.baseline.plan.visited;
      out.push({ key: "baseline", points: v.slice(0, -1).flatMap((id, k) => greatCircleArc(pos(id), pos(v[k + 1]), 1.0018, 48)), color: "#d4d7dc", dashed: true, opacity: 0.8, width: 1.5, hover: "Shortest-distance baseline" });
    }
    const t = res.route?.trajectory;
    if (res.route && t) {
      res.route.segments.forEach((s, si) => {
        if (s.kind !== "move") return;
        const idx = t.segment_index.flatMap((x, k) => (x === si ? [k] : []));
        if (!idx.length) return;
        const first = Math.max(0, idx[0] - 1);
        const pts = [first, ...idx].map((k) => latLonToVec3(t.lat_deg[k], t.lon_deg[k], 1.0024));
        const hl = selectedSeg === si;
        out.push({
          key: `seg-${si}-${hl}`,
          points: pts.length > 1 ? pts : [...pts, ...pts],
          color: hl ? "#f2b84b" : "#5ec4b6",
          width: hl ? 4 : 2.5,
          hover: `${name(s.base_id)} → ${name(s.to_id ?? "")}\n${fmtUtc(s.start_utc).slice(5, 16)} → ${fmtUtc(s.end_utc).slice(5, 16)} UTC\n${s.distance_km.toFixed(1)} km · ${fmtDuration(s.duration_s)} · dark ${fmtDuration(s.darkness_s)} · ⊕ hidden ${fmtDuration(s.earth_invisible_s)}`,
          onClick: () => {
            setSelectedSeg(si);
            setIndex(idx[0]);
          },
        });
      });
    }
    return out;
  }, [res, baseById, layers.network, layers.baseline, selectedSeg, name]);

  const onSiteClick = useCallback((key: string) => {
    if (key.startsWith("cat:")) setSelectedSite(sites.find((s) => s.id === key.slice(4)) ?? null);
  }, [sites]);

  const frameRoute = () => {
    const pts: [number, number][] = tr ? tr.lat_deg.map((la, k) => [la, tr.lon_deg[k]] as [number, number]).filter((_, k) => k % Math.max(1, Math.floor(tr.lat_deg.length / 200)) === 0) : [[start.lat, start.lon], [Number(dest.lat), Number(dest.lon)]];
    setFollow(false);
    setFocus((f) => ({ points: pts, nonce: (f?.nonce ?? 0) + 1 }));
  };

  const openRun = useCallback(async (runId: string) => {
    try {
      const r = await fetchRun(runId, true);
      if (!r.response) return;
      seq.current++;
      abortRef.current?.abort();
      setRes(r.response);
      setLastReq(JSON.stringify(r.request));
      setViewingOther(r.request);
      setIndex(0);
      setSelectedSeg(null);
      setNote(`Showing run ·${runId.slice(-6)}${r.parent_run_id ? ` (comparison of ·${r.parent_run_id.slice(-6)})` : ""}. Inputs on the left are unchanged.`);
    } catch {
      setNote("That run could not be loaded.");
    }
  }, []);

  const applyViewedInputs = () => {
    const q = viewingOther;
    if (!q) return;
    setStartExternal({ lat: q.start.lat_deg, lon: q.start.lon_deg, label: q.start.label });
    setP((x) => ({
      ...x,
      departure: q.departure_utc.slice(0, 16),
      horizonHours: String(q.horizon_hours), speedKmh: String(q.speed_kmh), maxLegKm: String(q.max_leg_km),
      gridMinutes: q.grid_minutes, maxWaitHours: String(q.max_wait_hours),
      wDistance: String(q.weights.distance), wDarkness: String(q.weights.darkness), wEarth: String(q.weights.earth_invisible),
      autoNetwork: q.auto_network, includeCatalog: q.include_catalog_sites, planningMode: q.planning_mode, mode: q.mode,
    }));
    setViewingOther(null);
    setNote(null);
  };

  const onRef = useCallback((r: ChatRef) => {
    if (r.type !== "computed") {
      if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
      else setNote(`${r.label}${r.excerpt ? `: ${r.excerpt.slice(0, 220)}…` : ""}`);
      return;
    }
    if (r.run_id && res?.run?.run_id !== r.run_id) {
      void openRun(r.run_id);
      return;
    }
    const seg = r.path?.match(/^segments\[(\d+)\]/);
    const val = r.value as { start_elapsed_s?: number } | undefined;
    if (seg) {
      const si = Number(seg[1]);
      setSelectedSeg(si);
      setTab("itinerary");
      if (tr) {
        const k = tr.segment_index.indexOf(si);
        if (k >= 0) setIndex(k);
      }
    } else if (r.path?.startsWith("intervals") && val?.start_elapsed_s !== undefined && tr) {
      setIndex(nearestElapsed(tr.elapsed_s, val.start_elapsed_s));
      setTab("chart");
    } else if (r.path?.startsWith("comparison")) setTab("baseline");
    else setTab("itinerary");
  }, [res, tr, openRun]);

  const onSelectTime = useCallback((v: string) => {
    if (!tr) return;
    const ms = Date.parse(v.replace(" ", "T") + (v.endsWith("Z") ? "" : "Z"));
    if (Number.isNaN(ms)) return;
    const t0 = Date.parse(tr.time_utc[0]);
    setIndex(nearestElapsed(tr.elapsed_s, (ms - t0) / 1000));
  }, [tr]);

  const exportJson = () => {
    if (!res) return;
    const blob = new Blob([JSON.stringify({ request: lastReq ? JSON.parse(lastReq) : null, response: res }, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lunar-prime-route_${res.run?.run_id ?? res.metadata.mode}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const synthetic = res?.metadata.mode === "synthetic";
  const m = res?.route?.metrics;
  const state: "idle" | "computing" | "success" | "infeasible" | "error" | "stale" =
    loading ? "computing" : error ? "error" : !res ? "idle" : stale ? "stale" : res.status === "infeasible" ? "infeasible" : "success";
  const subsolarStatic = useMemo(() => (tr ? { lat: tr.subsolar_lat_deg[0], lon: tr.subsolar_lon_deg[0] } : null), [tr]);
  const limitations = res?.metadata.limitations ?? [];

  const pill = {
    idle: <span className="text-muted">Set a start and optimize</span>,
    computing: <span className="text-accent">Optimizing…</span>,
    success: <span className="text-accent">Route found{m ? ` · ${m.distance_km.toFixed(1)} km` : ""}</span>,
    infeasible: <span className="text-danger">Infeasible{res?.diagnostics?.binding_constraint ? ` · ${res.diagnostics.binding_constraint.replace(/_/g, " ")}` : ""}</span>,
    error: <span className="text-danger">{error?.code === "invalid_request" ? "Request rejected" : "Error"}</span>,
    stale: <span className="text-sun">Inputs changed · showing previous result</span>,
  }[state];

  const toggle = (k: Layer) => setLayers((l) => ({ ...l, [k]: !l[k] }));

  return (
    <div className="flex flex-1 flex-col lg:grid lg:h-[calc(100dvh-3rem)] lg:grid-cols-[296px_minmax(0,1fr)_auto] lg:overflow-hidden">
      {/* ------------------------------------------------ left rail */}
      <aside className={`order-3 space-y-3 border-line p-3 lg:order-none lg:block lg:overflow-y-auto lg:border-r ${mobileTab === "plan" ? "block" : "hidden"}`}>
        <StartPicker value={start} rev={startRev} onChange={(v, ext) => (ext ? setStartExternal(v) : setStart(v))} picking={picking === "start"} onTogglePick={() => setPicking((x) => (x === "start" ? null : "start"))} sites={sites} onSelectSite={useSite} />

        <div className="flex items-center justify-between rounded border border-line bg-panel px-2 py-1.5 text-[12px]">
          <span className="text-muted">Destination (fixed)</span>
          <span className="font-mono text-[11px] text-text">{customDest ? `${dest.label} · ${dest.lat}°, ${dest.lon}°` : "South Pole · −90°, 0°"}</span>
        </div>

        <label className="block">
          <span className={labelCls}><span className="text-accent">2</span> · Departure date &amp; time (UTC)</span>
          <input type="datetime-local" step={60} className={inputCls} value={p.departure} aria-invalid={!!pErrs.departure} onChange={(e) => setP({ ...p, departure: e.target.value })} />
          {pErrs.departure && <span className="mt-0.5 block text-[11px] text-danger">{pErrs.departure}</span>}
        </label>

        <button type="button" disabled={!request || loading} onClick={() => request && run(request)} className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
          {loading ? "Planning route…" : stale ? "3 · Re-plan route" : "3 · Plan route"}
        </button>
        {invalid && <p className="text-[11px] text-danger">Fix the highlighted fields in Advanced to optimize.</p>}

        {preflight && request && (
          <div className="space-y-1 rounded border border-line bg-panel px-2 py-1.5 text-[11px]">
            {preflight.start_at_destination ? (
              <p className="text-muted">Start is at the destination: zero-distance itinerary.</p>
            ) : (
              <p className="font-mono text-muted">
                {preflight.great_circle_km.toFixed(1)} km great circle · ≥ {preflight.min_travel_hours.toFixed(1)} h at {p.speedKmh} km/h
              </p>
            )}
            {preflight.work && <p className="font-mono text-faint">{preflight.work.n_bases} nodes · {preflight.work.n_candidate_legs} legs · {preflight.work.time_states.toLocaleString()} states</p>}
            {(preflight.adjustments?.length ?? 0) > 0 && (
              <div className="text-sun">
                <p className="font-medium">Auto-fit will adjust:</p>
                <ul className="list-disc pl-4">{preflight.adjustments!.map((a) => <li key={a}>{a}</li>)}</ul>
              </div>
            )}
            {preflight.binding_constraints.map((b) => <p key={b} className="text-sun">{b}</p>)}
            {preflight.suggestions.map((s) => <p key={s} className="text-muted">→ {s}</p>)}
            {preflight.coarse_available && (
              <button type="button" onClick={() => setP({ ...p, planningMode: "coarse" })} className="rounded border border-sun/50 px-1.5 py-0.5 text-[11px] text-sun hover:bg-sun/10">Use coarse planning (approximate)</button>
            )}
          </div>
        )}

        <details className="rounded-md border border-line bg-panel">
          <summary className="cursor-pointer px-3 py-2 text-[12px] text-muted hover:text-text">Advanced settings</summary>
          <div className="space-y-3 border-t border-line p-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Speed" unit="km/h" value={p.speedKmh} onChange={(v) => setP({ ...p, speedKmh: v })} err={pErrs.speedKmh} />
              <Field label="Max leg" unit="km" value={p.maxLegKm} onChange={(v) => setP({ ...p, maxLegKm: v })} err={pErrs.maxLegKm} />
              <Field label="Horizon" unit="h" value={p.horizonHours} onChange={(v) => setP({ ...p, horizonHours: v })} err={pErrs.horizonHours} />
              <Field label="Max wait/stop" unit="h" value={p.maxWaitHours} onChange={(v) => setP({ ...p, maxWaitHours: v })} err={pErrs.maxWaitHours} />
            </div>
            <label className="block">
              <span className={labelCls}>Time grid</span>
              <select className={inputCls} value={p.gridMinutes} onChange={(e) => setP({ ...p, gridMinutes: Number(e.target.value) })}>
                {GRID_OPTIONS.map((g) => <option key={g} value={g}>{g < 60 ? `${g} min` : `${g / 60} h`}</option>)}
              </select>
              {pErrs.gridMinutes && <span className="mt-0.5 block text-[11px] text-danger">{pErrs.gridMinutes}</span>}
            </label>
            <fieldset className="space-y-1.5 text-[12px]">
              <legend className={labelCls}>Network &amp; search</legend>
              <label className="flex items-start gap-2"><input type="checkbox" checked={p.autoFit} onChange={(e) => setP({ ...p, autoFit: e.target.checked })} className="mt-0.5 accent-[var(--color-accent)]" /><span>Auto-fit constraints to reach the pole <span className="block text-[10.5px] text-faint">Raises horizon, then speed, leg length and grid only as needed; every change is listed.</span></span></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={p.autoNetwork} onChange={(e) => setP({ ...p, autoNetwork: e.target.checked })} className="accent-[var(--color-accent)]" />Generate planning waypoints</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={p.includeCatalog} onChange={(e) => setP({ ...p, includeCatalog: e.target.checked })} className="accent-[var(--color-accent)]" />Include catalogue sites near the corridor</label>
              <div role="radiogroup" aria-label="Planning mode" className="flex gap-3">
                {(["exact", "coarse"] as const).map((mode) => (
                  <label key={mode} className="flex items-center gap-1.5">
                    <input type="radio" name="planning-mode" checked={p.planningMode === mode} onChange={() => setP({ ...p, planningMode: mode })} className="accent-[var(--color-accent)]" />
                    {mode === "exact" ? "Exact grid search" : "Coarse (approximate)"}
                  </label>
                ))}
              </div>
            </fieldset>
            <ObjectiveCard p={p} onChange={setP} />
            <EndpointCard title="Destination" draft={dest} onChange={setDest} picking={picking === "dest"} onTogglePick={() => setPicking((x) => (x === "dest" ? null : "dest"))}>
              {customDest ? (
                <button type="button" onClick={() => setDest(SOUTH_POLE)} className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-text">Reset to South Pole</button>
              ) : (
                <span className="text-[10px] text-faint">default −90°, 0°</span>
              )}
            </EndpointCard>
            <WaypointList items={wps} onChange={setWps} picking={picking} onTogglePick={(uid) => setPicking((x) => (x === uid ? null : uid))} onReset={() => setWps(DEMO_WAYPOINTS)} />
            <p className="text-[10.5px] text-faint">“Reset demo network” loads the hypothetical south-polar corridors; they are not real bases.</p>
          </div>
        </details>
      </aside>

      {/* ------------------------------------------------ centre: globe + results */}
      <main className="order-1 flex min-h-0 min-w-0 flex-col lg:order-none">
        <div className="relative h-[58vh] min-h-[340px] shrink-0 lg:h-auto lg:flex-1 lg:shrink">
          <MoonGlobe sites={markers} subsolar={subsolarStatic} subEarth={null} picking={picking} onPick={onPick} view={view} paths={paths} live={live} focus={focus} follow={follow} onSiteClick={onSiteClick} compact ambient={0.32} active={active} />

          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-stretch gap-1 p-2 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
            <div className="pointer-events-auto flex gap-1 overflow-x-auto whitespace-nowrap sm:flex-wrap sm:overflow-visible" role="group" aria-label="Map layers">
              {(
                [
                  ["sites", "Mission sites"],
                  ["planning", "Planning waypoints"],
                  ["network", "Candidate network"],
                  ["baseline", "Baseline"],
                ] as [Layer, string][]
              ).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={layers[k]} onClick={() => toggle(k)} className={`rounded border px-2 py-0.5 text-[11px] ${layers[k] ? "border-line-strong bg-black/70 text-text" : "border-line bg-black/50 text-faint"}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="pointer-events-auto flex items-center gap-1 overflow-x-auto whitespace-nowrap sm:flex-wrap sm:overflow-visible">
              <span role="status" className="rounded border border-line bg-black/70 px-2 py-0.5 text-[11px]">{pill}</span>
              <button type="button" onClick={frameRoute} className="rounded border border-line bg-black/60 px-2 py-0.5 text-[11px] text-muted hover:text-text">Frame route</button>
              <button type="button" aria-pressed={follow} disabled={!tr} onClick={() => setFollow((f) => !f)} className={`rounded border px-2 py-0.5 text-[11px] disabled:opacity-40 ${follow ? "border-sun/60 bg-sun/10 text-sun" : "border-line bg-black/60 text-muted hover:text-text"}`}>Follow rover</button>
              <button type="button" onClick={() => { setFollow(false); setView((v) => ({ name: "polar", nonce: v.nonce + 1 })); }} className="rounded border border-line bg-black/60 px-2 py-0.5 text-[11px] text-muted hover:text-text">Pole</button>
              <button type="button" onClick={() => { setFollow(false); setView((v) => ({ name: "near", nonce: v.nonce + 1 })); }} className="rounded border border-line bg-black/60 px-2 py-0.5 text-[11px] text-muted hover:text-text">Globe</button>
              <button
                type="button"
                onClick={() => {
                  if (window.matchMedia("(min-width: 1024px)").matches) setAnalystOpen((o) => !o);
                  else {
                    setMobileTab("analyst");
                    requestAnimationFrame(() => document.getElementById("mission-analyst")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                  }
                }}
                aria-pressed={analystOpen}
                className="rounded border border-accent/60 bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/25"
              >
                Ask mission analyst
              </button>
            </div>
          </div>

          {picking && (
            <div className="pointer-events-none absolute left-1/2 top-10 -translate-x-1/2 rounded border border-accent/60 bg-black/80 px-2 py-0.5 text-[11px] text-accent">Click the surface to place · drag rotates · Esc cancels</div>
          )}
          {selectedSite && (
            <div className="absolute left-2 top-10 z-10">
              <SiteDetails site={selectedSite} onClose={() => setSelectedSite(null)} onUseAsStart={useSite} onInclude={toggleInclude} included={wps.some((w) => w.id === siteWpId(selectedSite))} />
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 space-y-1.5 p-2">
            {tr && tr.elapsed_s.length > 1 && (
              <div className="pointer-events-auto mx-auto max-w-3xl">
                <PlaybackBar key={res?.run?.run_id ?? lastReq ?? ""} res={res!} index={i} onIndex={setIndex} live={live} playing={playing} setPlaying={setPlaying} />
              </div>
            )}
            <div className="flex flex-wrap items-end justify-between gap-2 text-[10.5px] text-faint">
              <div className="hidden">
                <span><span className="text-accent">━</span> route</span>
                <span><span className="text-both">╍</span> baseline</span>
                <span><span style={{ color: CATEGORY_COLOR.crewed_landing }}>●</span> crewed landing</span>
                <span><span style={{ color: CATEGORY_COLOR.robotic_landing }}>●</span> robotic landing</span>
                <span><span className="text-muted">•</span> planning waypoint</span>
                <span><span className="text-danger">●</span> destination</span>
              </div>
              <button type="button" onClick={() => setShowLimits((s) => !s)} className="pointer-events-auto rounded bg-black/60 px-1.5 py-0.5 text-sun hover:underline" aria-expanded={showLimits}>
                {DISCLAIMER} <span className="text-muted">Limitations</span>
              </button>
            </div>
          </div>
          {showLimits && (
            <div role="dialog" aria-label="Limitations" className="absolute bottom-10 right-2 z-20 max-h-[60%] w-[360px] max-w-[calc(100%-1rem)] overflow-y-auto rounded-md border border-line-strong bg-panel/95 p-3 text-[11.5px] leading-snug shadow-xl backdrop-blur">
              <div className="mb-1 flex items-center justify-between"><h3 className="text-[12px] font-medium">Limitations</h3><button type="button" onClick={() => setShowLimits(false)} aria-label="Close limitations" className="text-faint hover:text-text">×</button></div>
              <ul className="list-disc space-y-1 pl-4 text-muted">
                {(limitations.length ? limitations : ["Run a route to load the full list from the backend."]).map((l) => <li key={l}>{l}</li>)}
                <li>Mission sites are historical or proposed locations, not operational bases; generated waypoints imply no safe terrain, power, supplies or communications.</li>
              </ul>
            </div>
          )}
        </div>

        {/* mobile tab bar */}
        <div role="tablist" aria-label="Panels" className="order-2 flex border-y border-line lg:hidden">
          {(["plan", "results", "analyst"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={mobileTab === t} type="button" onClick={() => setMobileTab(t)} className={`flex-1 py-2 text-[12px] capitalize ${mobileTab === t ? "border-b-2 border-accent text-text" : "text-muted"}`}>{t}</button>
          ))}
        </div>

        {/* results strip */}
        <section aria-label="Route results" className={`border-t border-line bg-panel lg:block ${mobileTab === "results" ? "block" : "hidden"}`}>
          <div className="space-y-1 px-3 py-2">
            {healthError && <p role="alert" className="text-[12px] text-danger">Backend unreachable: {healthError}</p>}
            {health && !health.spice_available && p.mode === "spice" && (
              <p role="alert" className="text-[12px] text-sun">
                SPICE kernels unavailable; run ./scripts/fetch_kernels.sh and restart the backend. The planner never falls back to approximate data.
              </p>
            )}
            {synthetic && <p role="alert" className="text-[12px] text-sun">Synthetic demo geometry: not SPICE results and not NASA data.</p>}
            {error && <p role="alert" className="text-[12px] text-danger">{error.message}</p>}
            {note && (
              <p className="flex items-start justify-between gap-2 text-[11.5px] text-muted">
                <span>{note} {viewingOther && <button type="button" onClick={applyViewedInputs} className="ml-1 text-accent underline">Use these inputs</button>}</span>
                <button type="button" onClick={() => setNote(null)} aria-label="Dismiss" className="text-faint hover:text-text">×</button>
              </p>
            )}
            {!stale && (res?.network?.adjustments?.length ?? 0) > 0 && (
              <div role="status" className="rounded border border-sun/40 bg-sun/[0.06] px-2 py-1 text-[11.5px] text-sun">
                <p className="font-medium">Auto-fit changed your constraints to reach the pole:</p>
                <ul className="list-disc pl-4 text-[11px]">{res!.network!.adjustments!.map((a) => <li key={a}>{a}</li>)}</ul>
              </div>
            )}
            {res?.status === "infeasible" && (
              <div role="status" className="text-[12.5px]">
                <p className="text-danger">{res.reason}</p>
                {res.diagnostics && (
                  <p className="mt-0.5 font-mono text-[11px] text-muted">
                    {res.diagnostics.great_circle_km.toFixed(1)} km great circle · ≥ {res.diagnostics.min_travel_hours.toFixed(1)} h at {lastReq ? JSON.parse(lastReq).speed_kmh : p.speedKmh} km/h · horizon {res.diagnostics.horizon_hours} h
                  </p>
                )}
                {res.diagnostics?.suggestion && <p className="mt-0.5 text-[12px] text-text">→ {res.diagnostics.suggestion}</p>}
              </div>
            )}
            {!res && !loading && !error && <p className="text-[12px] text-muted"><span className="text-accent">4</span> · Results appear here after you plan a route.</p>}
            {tr && tr.elapsed_s.length > 1 && <VisibilityStrip tr={tr} index={i} onIndex={setIndex} />}
            <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 ${stale || loading ? "opacity-60" : ""}`}>
              {(
                [
                  ["Distance", m ? `${m.distance_km.toFixed(1)} km` : "—"],
                  ["Travel time", m ? fmtDuration(m.elapsed_s) : "—"],
                  ["Darkness", m ? fmtDuration(m.darkness_s) : "—"],
                  ["Earth-invisible", m ? fmtDuration(m.earth_invisible_s) : "—"],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <div className="text-[9.5px] uppercase tracking-wider text-faint">{k}</div>
                  <div className="font-mono text-[15px] tabular-nums text-text">{v}</div>
                </div>
              ))}
              <div className="min-w-0 flex-1 text-[11.5px] text-muted">
                {res?.route && (
                  <span className="line-clamp-2">
                    {res.route.visited.map(name).join(" → ")}
                    {res.network?.generated && <span className="text-faint"> · auto network: {res.network.n_generated} waypoints, {res.network.corridors} corridor{res.network.corridors === 1 ? "" : "s"}</span>}
                    {res.network?.approximations.length ? <span className="text-sun"> · approximate</span> : null}
                    {res.network?.adjustments?.length ? <span className="text-sun"> · auto-fit</span> : null}
                  </span>
                )}
              </div>
              <div className="flex gap-1" role="tablist" aria-label="Details">
                {(["itinerary", "chart", "baseline", "method"] as Tab[]).map((t) => (
                  <button key={t} role="tab" type="button" aria-selected={tab === t} disabled={!res} onClick={() => setTab((x) => (x === t ? null : t))} className={`rounded px-2 py-0.5 text-[11px] capitalize disabled:opacity-40 ${tab === t ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`}>
                    {t === "chart" ? "Exposure" : t}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {res && tab && (
            <div className="max-h-[42vh] overflow-y-auto border-t border-line p-3">
              {tab === "itinerary" && res.route && (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <Itinerary plan={res.route} name={name} />
                  <LegTable plan={res.route} name={name} selected={selectedSeg} onSelect={(si) => { setSelectedSeg(si); const k = tr?.segment_index.indexOf(si) ?? -1; if (k >= 0) setIndex(k); }} />
                </div>
              )}
              {tab === "chart" && res.route?.trajectory && <TrajectoryChart plan={res.route} index={i} onSelectTime={onSelectTime} />}
              {tab === "baseline" && <ComparisonTable res={res} />}
              {tab === "method" && (
                <div className="space-y-4">
                  {res.network && (
                    <div className="text-[12px]">
                      <h4 className="text-[11px] uppercase tracking-wider text-muted">Candidate network</h4>
                      <p className="text-text">{res.network.generator ?? "User-supplied waypoints only."}</p>
                      <p className="font-mono text-[11px] text-muted">
                        {res.network.n_generated} generated · {res.network.n_user_waypoints} user · {res.network.n_catalog_sites} catalogue · mode {res.network.planning_mode}
                        {res.network.along_spacing_km !== null && ` · spacing ≤ ${res.network.along_spacing_km} km`}
                        {res.network.lateral_offset_km !== null && ` · lateral ${res.network.lateral_offset_km} km`}
                      </p>
                      {[...res.network.notes, ...res.network.approximations].map((x) => <p key={x} className="text-muted">{x}</p>)}
                    </div>
                  )}
                  {res.run && <p className="font-mono text-[11px] text-faint">run {res.run.run_id} · input {res.run.input_hash.slice(0, 12)} · result {res.run.result_hash.slice(0, 12)}</p>}
                  <RouteMethod res={res} onExport={exportJson} />
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* ------------------------------------------------ analyst drawer */}
      {(analystOpen || mobileTab === "analyst") && (
        <div id="mission-analyst" className={`order-4 h-[70vh] border-line lg:order-none lg:h-auto lg:w-[360px] lg:border-l ${mobileTab === "analyst" ? "block" : "hidden"} ${analystOpen ? "lg:block" : "lg:hidden"}`}>
          <MissionAnalyst runId={res?.run?.run_id ?? null} runFresh={!stale} onOpenRun={openRun} onRef={onRef} onClose={() => { setAnalystOpen(false); setMobileTab("plan"); }} />
        </div>
      )}
      <span className="sr-only" aria-live="polite">{state === "success" && m ? `Route found: ${m.distance_km.toFixed(1)} km, ${fmtDuration(m.elapsed_s)}. Start ${fmtLatLon(start, 2)}.` : ""}</span>
    </div>
  );
}
