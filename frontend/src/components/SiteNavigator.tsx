"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, fetchHealth, fetchSites, fetchTerrainStatus, postCompare, type TerrainStatus } from "@/lib/api";
import { fmtLatLon, parsePair } from "@/lib/coords";
import { fmtDuration, fmtUtc } from "@/lib/format";
import { CATEGORY_COLOR, type Site } from "@/lib/siteTypes";
import type { BodyMetrics, CompareResponse, HealthResponse, IntervalOut, Mode, SiteResult } from "@/lib/types";
import BestWindows from "./BestWindows";
import HorizonView from "./HorizonView";
import type { GlobeSite, GlobeView } from "./MoonGlobe";
import { MethodsPanel } from "./Results";

const MoonGlobe = memo(dynamic(() => import("./MoonGlobe"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading 3D globe…</div>,
}));

const LETTERS = ["A", "B", "C", "D"] as const;
const COLORS = ["#e4e6ea", "#f0a3c4", "#9bd17a", "#b79cf2"];
const LUNATION_D = 29.53;
const DURATIONS: [string, number][] = [["1 day", 1], ["1 week", 7], ["1 lunar day", LUNATION_D], ["2 lunar days", 2 * LUNATION_D]];
const STEPS = [5, 10, 15, 30, 60, 120];
const TARGET_SAMPLES = 3000;

interface Scenario {
  key: string;
  name: string;
  lat: number;
  lon: number;
  siteId?: string;
  start: string; // YYYY-MM-DDTHH:mm, UTC
}

interface Outcome {
  site: SiteResult;
  res: CompareResponse;
}

const cardCls = "rounded-md border border-line bg-panel";
const inputCls =
  "w-full min-w-0 rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-text placeholder:text-faint focus:border-accent focus:outline-none aria-[invalid=true]:border-danger";

let keySeq = 0;
const newKey = () => `s${Date.now().toString(36)}${(keySeq++).toString(36)}`;

function autoStep(days: number) {
  const minutes = days * 24 * 60;
  return STEPS.find((s) => minutes / s <= TARGET_SAMPLES) ?? 120;
}

function addDays(start: string, d: number) {
  const t = new Date(Date.parse(start + ":00Z") + d * 86400000);
  return t.toISOString().slice(0, 16);
}

// ------------------------------------------------------------------------------ scorecard model

type Better = "higher" | "lower" | null;
interface MetricDef {
  group: "Power (Sun)" | "Direct-to-Earth (Earth)" | "Both";
  label: string;
  hint: string;
  better: Better;
  value: (s: SiteResult) => number;
  lowerBound?: (s: SiteResult) => boolean;
  format: (v: number, s: SiteResult) => string;
  unit: "frac" | "s" | "deg";
}

const gap = (b: BodyMetrics) => b.longest_gap?.duration_s ?? 0;
const open = (b: BodyMetrics) => !!b.longest_gap && (b.longest_gap.open_start || b.longest_gap.open_end);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const hrs = (v: number) => (v >= 48 * 3600 ? `${(v / 86400).toFixed(1)} d` : `${(v / 3600).toFixed(1)} h`);

const METRICS: MetricDef[] = [
  { group: "Power (Sun)", label: "Sunlight", hint: "Share of the window with the Sun's centre above the ideal horizon (geometric; not panel output).", better: "higher", value: (s) => s.metrics.sun.visible_fraction, format: (v) => pct(v), unit: "frac" },
  { group: "Power (Sun)", label: "Longest night", hint: "Longest continuous time without the Sun: the battery/heater survival requirement. ≥ means it runs past the window edge.", better: "lower", value: (s) => gap(s.metrics.sun), lowerBound: (s) => open(s.metrics.sun), format: (v, s) => (s.metrics.sun.longest_gap ? `${open(s.metrics.sun) ? "≥ " : ""}${hrs(v)}` : "none"), unit: "s" },
  { group: "Power (Sun)", label: "Peak Sun elevation", hint: "Highest Sun elevation in the window. Near the poles the Sun stays low, so terrain and panel tilt matter.", better: null, value: (s) => s.metrics.sun.el_max_deg, format: (v) => `${v.toFixed(1)}°`, unit: "deg" },
  { group: "Direct-to-Earth (Earth)", label: "Earth in view", hint: "Share of the window with Earth's centre above the ideal horizon: direct-to-Earth line of sight, not a guaranteed radio link.", better: "higher", value: (s) => s.metrics.earth.visible_fraction, format: (v) => pct(v), unit: "frac" },
  { group: "Direct-to-Earth (Earth)", label: "Longest Earth blackout", hint: "Longest continuous time with Earth below the horizon: the longest period needing a relay or autonomy.", better: "lower", value: (s) => gap(s.metrics.earth), lowerBound: (s) => open(s.metrics.earth), format: (v, s) => (s.metrics.earth.longest_gap ? `${open(s.metrics.earth) ? "≥ " : ""}${hrs(v)}` : "none"), unit: "s" },
  { group: "Direct-to-Earth (Earth)", label: "Peak Earth elevation", hint: "Highest Earth elevation. Low values mean nearby terrain can easily block the line of sight.", better: null, value: (s) => s.metrics.earth.el_max_deg, format: (v) => `${v.toFixed(1)}°`, unit: "deg" },
  { group: "Both", label: "Sun and Earth together", hint: "Share of the window when the site has both sunlight and Earth in view (power and direct-to-Earth at the same time).", better: "higher", value: (s) => s.metrics.both_fraction, format: (v) => pct(v), unit: "frac" },
  { group: "Both", label: "Near-horizon time", hint: "Share of the window with the Sun or Earth within 1° of the horizon. High values mean real terrain could change these results.", better: null, value: (s) => Math.max(s.metrics.sun.near_horizon_fraction, s.metrics.earth.near_horizon_fraction), format: (v) => pct(v), unit: "frac" },
];

/** Index of the single best scenario, or null when the leader is within tolerance or only a lower bound. */
function bestOf(def: MetricDef, sites: SiteResult[], windowS: number, stepS: number): number | null {
  if (!def.better || sites.length < 2) return null;
  const vals = sites.map(def.value);
  const toS = (v: number) => (def.unit === "frac" ? v * windowS : v);
  const order = vals.map((v, i) => i).sort((a, b) => (def.better === "higher" ? vals[b] - vals[a] : vals[a] - vals[b]));
  const tol = Math.max(2 * stepS, 0.005 * windowS);
  if (Math.abs(toS(vals[order[0]]) - toS(vals[order[1]])) <= tol) return null;
  // A shorter gap that is only a lower bound (runs past the window edge) cannot be ranked as better.
  if (def.better === "lower" && def.lowerBound?.(sites[order[0]])) return null;
  return order[0];
}

// ------------------------------------------------------------------------------ small pieces

function WindowStrip({ res, site, index, color, onSeek }: { res: CompareResponse; site: SiteResult; index: number; color: string; onSeek: (frac: number) => void }) {
  const t0 = Date.parse(res.metadata.window_start_utc);
  const total = res.metadata.window_duration_s * 1000 || 1;
  const pos = (iv: IntervalOut) => ({ left: `${((Date.parse(iv.start_utc) - t0) / total) * 100}%`, width: `${Math.max(0.25, ((Date.parse(iv.end_utc) - Date.parse(iv.start_utc)) / total) * 100)}%` });
  const cursor = `${(res.elapsed_s[Math.min(index, res.elapsed_s.length - 1)] / (total / 1000)) * 100}%`;
  const lane = (k: "sun" | "earth" | "both", label: string, fill: string) => (
    <div className="flex items-center gap-2">
      <span className="w-[86px] shrink-0 text-[10.5px] text-muted">{label}</span>
      <div
        className="relative h-3 flex-1 cursor-pointer rounded-sm bg-black/50"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek((e.clientX - r.left) / r.width);
        }}
      >
        {site.intervals[k].map((iv) => <span key={iv.start_utc} className="absolute inset-y-0 rounded-sm" style={{ ...pos(iv), background: fill }} title={`${fmtUtc(iv.start_utc)} → ${fmtUtc(iv.end_utc)} (${fmtDuration(iv.duration_s)})`} />)}
        <span className="pointer-events-none absolute inset-y-[-3px] w-px bg-white" style={{ left: cursor }} />
      </div>
    </div>
  );
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-[11.5px]">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="font-medium text-text">{site.label}</span>
        <span className="font-mono text-[10.5px] text-faint">from {fmtUtc(res.metadata.window_start_utc).slice(0, 16)}</span>
      </p>
      {lane("sun", "☉ Sunlight", "#f2b84b")}
      {lane("earth", "⊕ Earth in view", "#6b9cff")}
      {lane("both", "Both", "#d4d7dc")}
    </div>
  );
}

// ------------------------------------------------------------------------------ share links

/** #v=1&d=<days>&t=<0|1>&s=<lat>,<lon>,<start>,<name>|... (names URI-encoded). */
function encodeHash(scenarios: Scenario[], days: number, terrain: boolean) {
  const s = scenarios.map((x) => [x.lat, x.lon, x.start, encodeURIComponent(x.name)].join(",")).join("|");
  return `#v=1&d=${days}&t=${terrain ? 1 : 0}&s=${s}`;
}

function decodeHash(hash: string): { scenarios: Scenario[]; days: number; terrain: boolean } | null {
  try {
    const q = new URLSearchParams(hash.replace(/^#/, ""));
    if (q.get("v") !== "1" || !q.get("s")) return null;
    const scenarios: Scenario[] = [];
    for (const part of q.get("s")!.split("|").slice(0, 4)) {
      const [lat, lon, start, name] = part.split(",");
      const la = Number(lat);
      const lo = Number(lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 360) continue;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start ?? "")) continue;
      scenarios.push({ key: newKey(), name: decodeURIComponent(name ?? "Shared site").slice(0, 64) || "Shared site", lat: la, lon: lo, start });
    }
    const d = Number(q.get("d"));
    if (!scenarios.length) return null;
    return { scenarios, days: Number.isFinite(d) && d >= 1 && d <= 60 ? d : LUNATION_D, terrain: q.get("t") !== "0" };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------ main

const DEFAULT_START = "2027-02-01T00:00";

export default function SiteNavigator({ active }: { active: boolean }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Site[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([
    { key: "a", name: "IM-2 Athena (south polar)", lat: -84.7906, lon: 29.1957, siteId: "im-2", start: DEFAULT_START },
    { key: "b", name: "Chandrayaan-3", lat: -69.3741, lon: 32.32, siteId: "chandrayaan-3", start: DEFAULT_START },
    { key: "c", name: "Apollo 11 LM (equatorial reference)", lat: 0.67416, lon: 23.47314, siteId: "apollo-11", start: DEFAULT_START },
  ]);
  const [days, setDays] = useState(LUNATION_D);
  const [stepChoice, setStepChoice] = useState<number | "auto">("auto");
  const [mode, setMode] = useState<Mode>("spice");
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeKey, setActiveKey] = useState("a");
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState<{ name: GlobeView; nonce: number }>({ name: "south", nonce: 0 });
  const [focus, setFocus] = useState<{ points: [number, number][]; nonce: number } | null>(null);
  const [q, setQ] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showMethod, setShowMethod] = useState(false);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus | null>(null);
  const [useTerrain, setUseTerrain] = useState(true);
  const [copied, setCopied] = useState(false);
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const autoRan = useRef(false);

  const step = stepChoice === "auto" ? autoStep(days) : stepChoice;
  const terrainOn = useTerrain && !!terrainStatus?.available;
  const keyOf = (list: Scenario[], d: number, st: number, m: Mode, t: boolean) =>
    JSON.stringify({ scenarios: list.map(({ key, lat, lon, start }) => [key, lat, lon, start]), days: d, step: st, mode: m, terrain: t });
  const reqKey = keyOf(scenarios, days, step, mode, terrainOn);
  const stale = lastKey !== null && reqKey !== lastKey;
  const coverage = mode === "spice" && health ? [health.coverage_start_utc, health.coverage_end_utc] : null;
  const dateErrors = scenarios.map((s) => {
    const t = Date.parse(s.start + ":00Z");
    if (Number.isNaN(t)) return "Enter a valid UTC date.";
    if (coverage?.[0] && t < Date.parse(coverage[0])) return "Before the ephemeris coverage.";
    if (coverage?.[1] && t + days * 86400000 > Date.parse(coverage[1])) return "Window runs past the ephemeris coverage.";
    return null;
  });
  const invalid = !scenarios.length || dateErrors.some(Boolean);

  const scenariosRef = useRef(scenarios);
  useEffect(() => {
    scenariosRef.current = scenarios;
  }, [scenarios]);
  const run = useCallback(async (list: Scenario[], d: number, st: number, m: Mode, t: boolean, key: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const my = ++seq.current;
    setLoading(true);
    setErrors([]);
    setPlaying(false);
    // One request per distinct start date (each holds up to four sites).
    const groups = new Map<string, Scenario[]>();
    for (const s of list) groups.set(s.start, [...(groups.get(s.start) ?? []), s]);
    const next: Record<string, Outcome> = {};
    const errs: string[] = [];
    await Promise.all(
      [...groups.entries()].map(async ([start, ss]) => {
        try {
          const res = await postCompare(
            { sites: ss.map((s) => ({ id: s.key, label: s.name.slice(0, 64), lat_deg: s.lat, lon_deg: s.lon })), start_utc: `${start}:00Z`, duration_hours: d * 24, step_minutes: st, mode: m, terrain: t },
            ac.signal,
          );
          for (const site of res.sites) next[site.id] = { site, res };
        } catch (e) {
          if ((e as Error).name !== "AbortError") errs.push(`${ss.map((s) => s.name).join(", ")}: ${e instanceof ApiError ? e.message : String(e)}`);
        }
      }),
    );
    if (my !== seq.current) return; // a newer comparison owns the view
    try {
      window.history.replaceState(null, "", encodeHash(list, d, t));
    } catch {
      /* sandboxed frames may block history updates */
    }
    setOutcomes(next);
    setErrors(errs);
    setLastKey(key);
    setIndex(0);
    setLoading(false);
    setFocus((f) => ({ points: list.map((s) => [s.lat, s.lon] as [number, number]), nonce: (f?.nonce ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const shared = decodeHash(window.location.hash);
    Promise.all([fetchHealth(ac.signal), fetchTerrainStatus(ac.signal).catch(() => null)])
      .then(([h, ts]) => {
        setHealth(h);
        setTerrainStatus(ts);
        if (autoRan.current) return;
        autoRan.current = true;
        const m: Mode = h.spice_available ? "spice" : "synthetic";
        const list = shared?.scenarios ?? scenariosRef.current;
        const d = shared?.days ?? LUNATION_D;
        const t = (shared?.terrain ?? true) && !!ts?.available;
        setMode(m);
        if (shared) {
          setScenarios(shared.scenarios);
          setDays(shared.days);
          setUseTerrain(shared.terrain);
          setActiveKey(shared.scenarios[0].key);
        }
        if (h.spice_available) run(list, d, autoStep(d), m, t, keyOf(list, d, autoStep(d), m, t));
      })
      .catch((e) => (e as Error).name !== "AbortError" && setHealthError((e as Error).message));
    fetchSites(ac.signal).then((c) => setCatalog(c.sites)).catch(() => undefined);
    return () => ac.abort();
  }, [run]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---- scenario edits
  const addScenario = useCallback((name: string, lat: number, lon: number, siteId?: string, start?: string) => {
    const list = scenariosRef.current;
    if (list.length >= 4) return;
    const key = newKey();
    setScenarios([...list, { key, name, lat, lon, siteId, start: start ?? list[list.length - 1]?.start ?? DEFAULT_START }]);
    setActiveKey(key);
  }, []);
  const update = (key: string, patch: Partial<Scenario>) => setScenarios((l) => l.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const remove = (key: string) => setScenarios((l) => l.filter((s) => s.key !== key));
  const duplicateLater = (s: Scenario) => {
    if (scenarios.length >= 4) return;
    const key = newKey();
    setScenarios((l) => [...l, { ...s, key, start: addDays(s.start, 14.77) }]);
    setActiveKey(key);
  };

  const onPick = useCallback((lat: number, lon: number) => {
    setPicking(false);
    addScenario(`Point ${fmtLatLon({ lat, lon }, 2)}`, lat, lon);
  }, [addScenario]);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return catalog.filter((s) => `${s.name} ${s.mission} ${s.agency}`.toLowerCase().includes(t)).slice(0, 6);
  }, [q, catalog]);

  // ---- results
  const shown = scenarios.filter((s) => outcomes[s.key]);
  const activeId = outcomes[activeKey] ? activeKey : shown[0]?.key;
  const activeOut = activeId ? outcomes[activeId] : null;
  const n = activeOut?.res.timestamps_utc.length ?? 0;
  const i = Math.min(index, Math.max(0, n - 1));
  const subsolar = activeOut ? { lat: activeOut.res.subpoints.subsolar_lat_deg[i], lon: activeOut.res.subpoints.subsolar_lon_deg[i] } : null;
  const subEarth = activeOut ? { lat: activeOut.res.subpoints.sub_earth_lat_deg[i], lon: activeOut.res.subpoints.sub_earth_lon_deg[i] } : null;
  const windowS = activeOut?.res.metadata.window_duration_s ?? days * 86400;
  const stepS = activeOut?.res.metadata.step_s ?? step * 60;
  const synthetic = Object.values(outcomes).some((o) => o.res.metadata.mode === "synthetic");

  const markers: GlobeSite[] = useMemo(
    () => scenarios.map((s, k) => ({ key: s.key, letter: LETTERS[k], label: s.name, lat: s.lat, lon: s.lon, color: COLORS[k], kind: "site" as const })),
    [scenarios],
  );

  useEffect(() => {
    if (!playing || n < 2) return;
    let raf = 0;
    let last = performance.now();
    let acc = index;
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * (n / 24);
      last = now;
      if (acc >= n - 1) {
        setIndex(n - 1);
        setPlaying(false);
        return;
      }
      setIndex(Math.floor(acc));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when play toggles
  }, [playing, n]);

  const sites = shown.map((s) => outcomes[s.key].site);
  const colorOf = (key: string) => COLORS[scenarios.findIndex((s) => s.key === key)] ?? "#fff";
  const letterOf = (key: string) => LETTERS[scenarios.findIndex((s) => s.key === key)] ?? "?";
  const sameDate = new Set(shown.map((s) => s.start)).size <= 1;

  return (
    <div className="flex flex-1 flex-col lg:grid lg:h-[calc(100dvh-3rem)] lg:grid-cols-[320px_minmax(0,1fr)] lg:overflow-hidden">
      {/* ------------------------------------------------ controls */}
      <aside className="order-2 space-y-3 border-line p-3 lg:order-none lg:overflow-y-auto lg:border-r">
        <section aria-labelledby="nav-sites" className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 id="nav-sites" className="text-[13px] font-medium"><span className="text-accent">1</span> · Sites &amp; dates</h2>
            <span className="text-[10.5px] text-faint">{scenarios.length}/4</span>
          </div>
          <ul className="space-y-1.5">
            {scenarios.map((s, k) => (
              <li key={s.key} className={`${cardCls} p-2 ${activeId === s.key ? "border-line-strong" : ""}`}>
                <div className="flex items-start gap-2">
                  <button type="button" onClick={() => setActiveKey(s.key)} className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-black" style={{ background: COLORS[k] }} aria-label={`Show ${s.name} on the globe`}>
                    {LETTERS[k]}
                  </button>
                  <div className="min-w-0 flex-1">
                    <input aria-label={`Name of site ${LETTERS[k]}`} className="w-full truncate bg-transparent text-[12.5px] text-text focus:outline-none" value={s.name} maxLength={64} onChange={(e) => update(s.key, { name: e.target.value })} />
                    <p className="font-mono text-[10.5px] text-faint">{fmtLatLon(s, 3)}</p>
                  </div>
                  <button type="button" onClick={() => remove(s.key)} aria-label={`Remove ${s.name}`} className="text-[14px] text-faint hover:text-danger">×</button>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input type="datetime-local" step={60} aria-label={`Start of window for ${s.name} (UTC)`} className={inputCls + " py-1"} value={s.start} aria-invalid={!!dateErrors[k]} onChange={(e) => update(s.key, { start: e.target.value })} />
                  <span className="text-[10px] text-faint">UTC</span>
                </div>
                {dateErrors[k] && <p className="mt-0.5 text-[11px] text-danger">{dateErrors[k]}</p>}
                {scenarios.length < 4 && (
                  <button type="button" onClick={() => duplicateLater(s)} className="mt-1 text-[10.5px] text-muted hover:text-text">+ Same site, half a lunar day later</button>
                )}
              </li>
            ))}
          </ul>

          {scenarios.length < 4 ? (
            <div className="space-y-1.5">
              <div className="relative">
                <input role="combobox" aria-expanded={matches.length > 0} aria-controls="nav-site-list" aria-label="Add a verified landing site" className={inputCls + " font-sans"} placeholder="Add landing site (e.g. Apollo 17, Chang'e 4)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && matches[0]?.lat_deg != null) { addScenario(matches[0].name, matches[0].lat_deg, matches[0].lon_deg!, matches[0].id); setQ(""); } if (e.key === "Escape") setQ(""); }} />
                {matches.length > 0 && (
                  <ul id="nav-site-list" role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded border border-line-strong bg-panel shadow-lg">
                    {matches.map((s) => (
                      <li key={s.id} role="option" aria-selected={false}>
                        <button type="button" disabled={s.lat_deg === null} onClick={() => { addScenario(s.name, s.lat_deg!, s.lon_deg!, s.id); setQ(""); }} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-panel-2 disabled:opacity-50">
                          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[s.category] }} />
                          <span className="min-w-0 flex-1 truncate">{s.name}</span>
                          <span className="shrink-0 text-[10px] text-faint">{s.lat_deg === null ? "region · no point published" : `${s.agency}`}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex gap-1.5">
                <input aria-label="Add a point by coordinates, latitude first" className={inputCls} placeholder="or paste “-85.3, 30.1”" value={paste} aria-invalid={!!pasteErr} onChange={(e) => { setPaste(e.target.value); setPasteErr(null); }} onKeyDown={(e) => { if (e.key === "Enter" && paste.trim()) { const r = parsePair(paste); if (!r.ok) setPasteErr(r.error); else { addScenario(`Point ${fmtLatLon(r.value, 2)}`, r.value.lat, r.value.lon); setPaste(""); } } }} />
                <button type="button" aria-pressed={picking} onClick={() => setPicking((p) => !p)} className={`shrink-0 rounded border px-2 text-[11px] ${picking ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-text"}`}>⌖ Globe</button>
              </div>
              {pasteErr && <p role="alert" className="text-[11px] text-danger">{pasteErr}</p>}
            </div>
          ) : (
            <p className="text-[11px] text-faint">Up to four scenarios. Remove one to add another.</p>
          )}
        </section>

        <section aria-labelledby="nav-window" className="space-y-1.5">
          <h2 id="nav-window" className="text-[13px] font-medium"><span className="text-accent">2</span> · Window length</h2>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Window length">
            {DURATIONS.map(([label, d]) => (
              <button key={label} type="button" role="radio" aria-checked={days === d} onClick={() => setDays(d)} className={`rounded border px-2 py-0.5 text-[11.5px] ${days === d ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-text"}`}>{label}</button>
            ))}
          </div>
          <p className="text-[10.5px] text-faint">A lunar day (29.53 d) covers one full cycle of sunlight at any site.</p>
          <label className={`flex items-start gap-2 rounded border px-2 py-1.5 text-[12px] ${terrainOn ? "border-[#a08060]/60 bg-[#3a2f26]/30" : "border-line"}`}>
            <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={useTerrain} disabled={!terrainStatus?.available} onChange={(e) => setUseTerrain(e.target.checked)} />
            <span>
              Real terrain horizon <span className="text-faint">(NASA LOLA, 60°S to pole)</span>
              <span className="block text-[10.5px] leading-snug text-faint">
                {terrainStatus?.available
                  ? "Crater walls and ridges block the Sun and Earth. Sites north of 60°S keep the ideal horizon."
                  : "Terrain data not installed on the server (scripts/fetch_terrain.sh); using the ideal horizon."}
              </span>
            </span>
          </label>
          <details className="text-[11.5px]">
            <summary className="cursor-pointer text-muted hover:text-text">Resolution &amp; data source</summary>
            <div className="mt-1.5 space-y-1.5">
              <label className="flex items-center gap-2">
                <span className="text-muted">Sampling</span>
                <select className={inputCls + " w-auto py-0.5"} value={String(stepChoice)} onChange={(e) => setStepChoice(e.target.value === "auto" ? "auto" : Number(e.target.value))}>
                  <option value="auto">Auto ({autoStep(days)} min)</option>
                  {STEPS.map((s) => <option key={s} value={s}>{s} min</option>)}
                </select>
              </label>
              <p className="text-[10.5px] text-faint">Rise and set times are refined to about 1 s between samples.</p>
              <label className="flex items-center gap-2"><input type="radio" name="nav-mode" checked={mode === "spice"} onChange={() => setMode("spice")} className="accent-[var(--color-accent)]" />NASA/JPL SPICE (DE440)</label>
              <label className="flex items-center gap-2 text-sun"><input type="radio" name="nav-mode" checked={mode === "synthetic"} onChange={() => setMode("synthetic")} className="accent-[var(--color-accent)]" />Synthetic demo (not scientific)</label>
            </div>
          </details>
        </section>

        <button type="button" disabled={invalid || loading} onClick={() => run(scenarios, days, step, mode, terrainOn, reqKey)} className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
          {loading ? "Computing Sun & Earth positions…" : stale ? "3 · Update comparison" : "3 · Compare"}
        </button>
        <button
          type="button"
          disabled={!lastKey}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(window.location.href);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            } catch {
              window.prompt("Copy this link:", window.location.href);
            }
          }}
          className="w-full rounded-md border border-line px-3 py-1.5 text-[12px] text-muted hover:text-text disabled:opacity-40"
        >
          {copied ? "Link copied" : "Copy shareable link"}
        </button>
        {health && !health.spice_available && mode === "spice" && <p role="alert" className="text-[11.5px] text-sun">SPICE kernels are unavailable; switch to synthetic demo data under Resolution &amp; data source.</p>}
        {healthError && <p role="alert" className="text-[11.5px] text-danger">Backend unreachable: {healthError}</p>}
        {errors.map((e) => <p key={e} role="alert" className="text-[11.5px] text-danger">{e}</p>)}
      </aside>

      {/* ------------------------------------------------ results */}
      <main className="order-1 min-h-0 min-w-0 space-y-3 overflow-y-auto p-3 lg:order-none">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12.5px] text-muted">
            When is each site lit (<span className="text-sun">power</span>) and when can it see Earth (<span className="text-earth">direct-to-Earth comms</span>)?
            <button type="button" onClick={() => setShowHelp((h) => !h)} className="ml-1.5 text-accent underline-offset-2 hover:underline" aria-expanded={showHelp}>How to read this</button>
          </p>
          <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${synthetic ? "border-sun/60 text-sun" : "border-line-strong text-muted"}`}>{synthetic ? "Synthetic demo data" : "SPICE · DE440 · MOON_ME"}</span>
        </div>
        {showHelp && (
          <div className={`${cardCls} grid gap-2 p-3 text-[12px] leading-snug text-muted sm:grid-cols-3`}>
            <p><span className="text-sun">Sunlight</span> = the Sun&apos;s centre is above an ideal, terrain-free horizon. It indicates solar-power potential, not actual panel output.</p>
            <p><span className="text-earth">Earth in view</span> = straight-line visibility of Earth, needed for direct-to-Earth radio. It is not a link budget, and relays are not modelled.</p>
            <p><span className="text-text">Sky view</span>: zenith at the centre, horizon at the edge, north up. With <span className="text-[#d8b892]">terrain</span> on, the brown silhouette is the real skyline from NASA LOLA heights: crater floors can be permanently dark, and high ground can see slightly <em>below</em> 0°, so visibility can go up as well as down.</p>
          </div>
        )}
        {synthetic && <p role="alert" className="text-[12px] text-sun">Synthetic demo geometry: not SPICE results and not NASA data.</p>}
        {stale && !loading && <p className="text-[12px] text-sun">Sites or dates changed. Results below are from the previous comparison; press Update comparison.</p>}

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          {/* globe */}
          <div className={`${cardCls} relative h-[380px] overflow-hidden xl:h-auto xl:min-h-[440px]`}>
            <MoonGlobe sites={markers} subsolar={subsolar} subEarth={subEarth} picking={picking ? "add" : null} onPick={onPick} view={view} focus={focus} onSiteClick={(k) => setActiveKey(k)} active={active} />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-1 p-2">
              <div className="pointer-events-auto flex flex-wrap gap-1">
                {(["south", "near", "far", "north"] as GlobeView[]).map((v) => (
                  <button key={v} type="button" onClick={() => setView((x) => ({ name: v, nonce: x.nonce + 1 }))} className="rounded border border-line bg-black/60 px-2 py-0.5 text-[11px] capitalize text-muted hover:text-text">{v === "near" || v === "far" ? `${v} side` : `${v} pole`}</button>
                ))}
              </div>
              {picking && <span className="rounded border border-accent/60 bg-black/80 px-2 py-0.5 text-[11px] text-accent">Click the surface to add a site · Esc cancels</span>}
            </div>
            <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 px-2 pb-1.5 pt-4 text-[10.5px] text-faint">
              {activeOut ? <>Lit for <span style={{ color: colorOf(activeId!) }}>{letterOf(activeId!)}</span>&apos;s time · <span className="text-sun">●</span> Sun and <span className="text-earth">●</span> Earth directions · smooth sphere, no terrain shadows</> : "Compare to light the globe from the computed Sun direction."}
            </p>
          </div>

          {/* scorecards */}
          {sites.length > 0 && (
          <section aria-label="Power and communication comparison" className={`${cardCls} overflow-x-auto p-3`}>
            <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
              <caption className="sr-only">Power and direct-to-Earth metrics per scenario</caption>
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted">
                  <th scope="col" className="pb-1.5 pr-3 font-medium">Over the {fmtDuration(windowS)} window</th>
                  {shown.map((s) => (
                    <th key={s.key} scope="col" className="pb-1.5 pr-3 text-right font-medium normal-case tracking-normal">
                      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: colorOf(s.key) }} /><span className="text-text">{letterOf(s.key)}</span></span>
                      <span className="block max-w-[150px] truncate text-[10.5px] font-normal text-faint" title={s.name}>{s.name}</span>
                      {!sameDate && <span className="block font-mono text-[9.5px] font-normal text-faint">{s.start.replace("T", " ")}</span>}
                      <span className={`mt-0.5 inline-block rounded px-1 text-[9.5px] font-normal ${outcomes[s.key].site.terrain?.applied ? "bg-[#3a2f26] text-[#d8b892]" : "bg-panel-2 text-faint"}`} title={outcomes[s.key].site.terrain?.applied ? outcomes[s.key].site.terrain?.note : outcomes[s.key].site.terrain?.reason}>
                        {outcomes[s.key].site.terrain?.applied ? "LOLA terrain" : "ideal horizon"}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m, mi) => {
                  const best = bestOf(m, sites, windowS, stepS);
                  const vals = sites.map(m.value);
                  const max = Math.max(...vals.map(Math.abs), 1e-9);
                  return (
                    <tr key={m.label} className={`border-t border-line/60 ${mi > 0 && METRICS[mi - 1].group !== m.group ? "border-t-line-strong" : ""}`}>
                      <th scope="row" className="min-w-[150px] py-1.5 pr-3 text-left font-normal">
                        {(mi === 0 || METRICS[mi - 1].group !== m.group) && <span className={`block text-[9.5px] uppercase tracking-wider ${m.group.startsWith("Power") ? "text-sun" : m.group.startsWith("Direct") ? "text-earth" : "text-muted"}`}>{m.group}</span>}
                        <span className="text-text" title={m.hint}>{m.label}</span>
                        <span className="block text-[10px] leading-tight text-faint">{m.better ? (m.better === "higher" ? "higher is better" : "shorter is better") : "context"}</span>
                      </th>
                      {sites.map((s, k) => (
                        <td key={s.id} className="py-1.5 pr-3 text-right align-top">
                          <span className={`font-mono tabular-nums ${best === k ? "font-semibold text-accent" : "text-text"}`}>{m.format(vals[k], s)}{best === k && <span className="ml-1 text-[10px]">best</span>}</span>
                          {m.unit !== "deg" && <span className="mt-1 block h-1 rounded-full bg-black/50"><span className="block h-1 rounded-full" style={{ width: `${(Math.abs(vals[k]) / max) * 100}%`, background: m.group.startsWith("Power") ? "#f2b84b" : m.group.startsWith("Direct") ? "#6b9cff" : "#8b919b" }} /></span>}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[10.5px] leading-snug text-faint">
              “Best” is marked only when the lead exceeds the sampling tolerance and is not just a window-edge lower bound. Hover a metric for its meaning. Visibility is judged by the body&apos;s centre against the LOLA terrain horizon (south of 60°S, when on) or the ideal horizon; finite discs and eclipses are not modelled.
            </p>
          </section>
        )}
          {sites.length === 0 && <div className={`${cardCls} flex min-h-[200px] items-center justify-center p-4 text-[12px] text-faint`}>{loading ? "Computing Sun and Earth positions with SPICE…" : "Add sites and press Compare to see power and direct-to-Earth metrics."}</div>}
        </div>

        {/* time control */}
        {activeOut && n > 1 && (
          <div className={`${cardCls} sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2`}>
            <button type="button" onClick={() => { if (!playing && i >= n - 1) setIndex(0); setPlaying((p) => !p); }} aria-label={playing ? "Pause" : "Play"} className="flex h-7 w-8 items-center justify-center rounded border border-line text-[12px] text-muted hover:text-text">{playing ? "❚❚" : "▶"}</button>
            <input type="range" min={0} max={n - 1} value={i} onChange={(e) => { setPlaying(false); setIndex(Number(e.target.value)); }} className="min-w-[160px] flex-1" aria-label="Time in window" aria-valuetext={`T+${fmtDuration(activeOut.res.elapsed_s[i])}`} />
            <span className="font-mono text-[11.5px] tabular-nums text-text">T+{fmtDuration(activeOut.res.elapsed_s[i])}</span>
            {sameDate ? <span className="font-mono text-[11.5px] tabular-nums text-muted">{fmtUtc(activeOut.res.timestamps_utc[i])}</span> : <span className="text-[10.5px] text-faint">different start dates: time shown from each window start</span>}
          </div>
        )}

        {/* best landing dates */}
        <BestWindows
          sites={scenarios.map((x, k) => ({ key: x.key, letter: LETTERS[k], color: COLORS[k], name: x.name, lat: x.lat, lon: x.lon, start: x.start }))}
          missionDays={Math.min(days, 60)}
          terrain={terrainOn}
          mode={mode}
          canAdd={scenarios.length < 4}
          onAdd={(site, start) => addScenario(`${site.name.replace(/ · .*$/, "")} · ${start.slice(0, 10)}`.slice(0, 64), site.lat, site.lon, undefined, start)}
        />

        {/* sky views */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-4">
            {shown.length ? shown.map((s) => (
              <div key={s.key} onClick={() => setActiveKey(s.key)} className={`rounded-md ${activeId === s.key ? "ring-1 ring-line-strong" : ""}`}>
                <HorizonView site={outcomes[s.key].site} letter={letterOf(s.key)} index={Math.min(i, outcomes[s.key].res.timestamps_utc.length - 1)} />
              </div>
            )) : (
              <div className={`${cardCls} col-span-full flex h-[200px] items-center justify-center text-[12px] text-faint`}>{loading ? "Computing local skies…" : "Add sites and press Compare."}</div>
            )}
          </div>

        {/* window strips */}
        {shown.length > 0 && (
          <section aria-label="Sunlight and Earth visibility windows" className={`${cardCls} space-y-3 p-3`}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-[12.5px] font-medium">Windows over time</h3>
              <span className="text-[10.5px] text-faint">bars = above horizon · white line = current time · click to jump</span>
            </div>
            {shown.map((s) => (
              <WindowStrip key={s.key} res={outcomes[s.key].res} site={outcomes[s.key].site} index={i} color={colorOf(s.key)} onSeek={(f) => { setPlaying(false); setIndex(Math.round(f * (outcomes[s.key].res.timestamps_utc.length - 1))); setActiveKey(s.key); }} />
            ))}
          </section>
        )}

        {activeOut && (
          <section className={cardCls}>
            <button type="button" onClick={() => setShowMethod((x) => !x)} aria-expanded={showMethod} className="w-full px-3 py-2 text-left text-[12px] text-muted hover:text-text">
              {showMethod ? "▾" : "▸"} Method, limitations &amp; provenance
            </button>
            {showMethod && <div className="border-t border-line p-3"><MethodsPanel result={activeOut.res} /></div>}
          </section>
        )}
      </main>
    </div>
  );
}
