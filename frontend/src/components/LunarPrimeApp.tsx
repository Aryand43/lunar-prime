"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, fetchHealth, postCompare } from "@/lib/api";
import { fmtUtc } from "@/lib/format";
import { DEFAULT_SITES, PRESETS } from "@/lib/sites";
import type { CompareRequest, CompareResponse, HealthResponse } from "@/lib/types";
import { SiteCard, WindowCard, siteErrors, windowErrors, type SiteDraft, type WindowDraft } from "./Controls";
import HorizonView from "./HorizonView";
import type { GlobeView } from "./MoonGlobe";
import { Findings, MethodsPanel, MetricsTable } from "./Results";
import RoutePlanner from "./RoutePlanner";
import Scrubber from "./Scrubber";
import Timelines from "./Timelines";

const MoonGlobe = dynamic(() => import("./MoonGlobe"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading 3D globe…</div>,
});

const LETTERS = ["A", "B"] as const;

function presetDraft(key: string): SiteDraft {
  const p = PRESETS.find((x) => x.key === key)!;
  return { presetKey: p.key, label: p.label, lat: String(p.lat), lon: String(p.lon) };
}

function buildRequest(sites: SiteDraft[], w: WindowDraft): CompareRequest {
  return {
    sites: sites.map((s, i) => ({
      id: LETTERS[i],
      label: s.label.trim(),
      lat_deg: Number(s.lat),
      lon_deg: Number(s.lon),
    })) as CompareRequest["sites"],
    start_utc: `${w.start}:00Z`,
    duration_hours: Number(w.durationDays) * 24,
    step_minutes: w.stepMinutes,
    mode: w.mode,
  };
}

function nearestIndex(timestamps: string[], ms: number): number {
  // timestamps are uniformly spaced except possibly the last; binary search for robustness.
  let lo = 0;
  let hi = timestamps.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(timestamps[mid]) <= ms) lo = mid;
    else hi = mid;
  }
  return Math.abs(Date.parse(timestamps[hi]) - ms) < Math.abs(Date.parse(timestamps[lo]) - ms) ? hi : lo;
}

function Panel({ title, aside, children, className = "" }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-md border border-line bg-panel ${className}`} aria-label={title}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {aside}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export default function LunarPrimeApp() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteDraft[]>(DEFAULT_SITES.map(presetDraft));
  const [win, setWin] = useState<WindowDraft>({ start: "2026-12-01T00:00", durationDays: "29.53", stepMinutes: 30, mode: "spice" });
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [lastReq, setLastReq] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [index, setIndex] = useState(0);
  const [picking, setPicking] = useState<"A" | "B" | null>(null);
  const [view, setView] = useState<{ name: GlobeView; nonce: number }>({ name: "near", nonce: 0 });
  const [tab, setTab] = useState<"compare" | "route">("route");
  const [routeMounted, setRouteMounted] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const autoRan = useRef(false);

  const maxSamples = health?.limits.max_samples ?? 20000;
  const coverage: [string | null, string | null] | undefined =
    win.mode === "spice" && health ? [health.coverage_start_utc, health.coverage_end_utc] : undefined;

  const invalid =
    sites.some((s) => Object.keys(siteErrors(s)).length > 0) || Object.keys(windowErrors(win, maxSamples, coverage)).length > 0;
  const request = useMemo(() => (invalid ? null : buildRequest(sites, win)), [invalid, sites, win]);
  const stale = result !== null && request !== null && JSON.stringify(request) !== lastReq;

  const run = useCallback(async (req: CompareRequest) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const res = await postCompare(req, ac.signal);
      setResult(res);
      setLastReq(JSON.stringify(req));
      setIndex(0);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof ApiError ? e : new ApiError(String(e), "unknown", 0));
    } finally {
      if (abortRef.current === ac) setLoading(false);
    }
  }, []);

  // Health check, then an initial comparison so the demo opens with real results.
  useEffect(() => {
    const ac = new AbortController();
    fetchHealth(ac.signal)
      .then((h) => {
        setHealth(h);
        void h;
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setHealthError((e as Error).message);
      });
    return () => ac.abort();
  }, [run]);

  const onPick = useCallback(
    (lat: number, lon: number) => {
      if (!picking) return;
      const i = picking === "A" ? 0 : 1;
      setSites((prev) =>
        prev.map((s, k) =>
          k === i
            ? { presetKey: "custom", label: s.presetKey === "custom" ? s.label : `Custom site ${picking}`, lat: lat.toFixed(4), lon: lon.toFixed(4) }
            : s,
        ),
      );
      setPicking(null);
    },
    [picking],
  );

  const onSelectTime = useCallback(
    (v: string) => {
      if (!result) return;
      const ms = Date.parse(v.replace(" ", "T") + (v.endsWith("Z") ? "" : "Z"));
      if (!Number.isNaN(ms)) setIndex(nearestIndex(result.timestamps_utc, ms));
    },
    [result],
  );

  const exportJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lunar-prime_${result.metadata.window_start_utc.slice(0, 10)}_${result.metadata.mode}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const i = result ? Math.min(index, result.timestamps_utc.length - 1) : 0;
  const subsolar = result ? { lat: result.subpoints.subsolar_lat_deg[i], lon: result.subpoints.subsolar_lon_deg[i] } : null;
  const subEarth = result ? { lat: result.subpoints.sub_earth_lat_deg[i], lon: result.subpoints.sub_earth_lon_deg[i] } : null;
  const globeSites = sites
    .map((s, k) => ({ letter: LETTERS[k], label: s.label || `Site ${LETTERS[k]}`, lat: Number(s.lat), lon: Number(s.lon) }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180);
  const synthetic = result?.metadata.mode === "synthetic";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 flex h-12 items-center justify-between gap-3 border-b border-line bg-bg/95 px-4 backdrop-blur">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-[15px] font-semibold tracking-tight">Lunar Prime</h1>
          <div role="tablist" aria-label="Mode" className="flex self-center rounded-md border border-line p-0.5">
            {(
              [
                ["route", "Route simulator"],
                ["compare", "Compare sites"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => {
                  setTab(t);
                  if (t === "route") setRouteMounted(true);
                  if (t === "compare" && !autoRan.current && health?.spice_available) {
                    autoRan.current = true;
                    run(buildRequest(DEFAULT_SITES.map(presetDraft), { start: "2026-12-01T00:00", durationDays: "29.53", stepMinutes: 30, mode: "spice" }));
                  }
                }}
                className={`rounded px-2.5 py-0.5 text-[12px] ${tab === t ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="hidden truncate text-[12px] text-muted xl:inline">
            {tab === "compare"
              ? "Lunar site sunlight & direct-to-Earth visibility · geometric, ideal horizon"
              : "Conceptual routing from anywhere to the South Pole · SPICE Sun/Earth geometry"}
          </span>
        </div>
        <div className={`flex items-center gap-3 ${tab === "compare" ? "" : "hidden"}`}>
          {result && (
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                synthetic ? "border-sun/60 text-sun" : "border-line-strong text-muted"
              }`}
              title={result.metadata.provenance}
            >
              {synthetic ? "Synthetic demo data" : "SPICE · DE440 · MOON_ME"}
            </span>
          )}
          <time className="font-mono text-[12px] tabular-nums text-text" aria-live="off" dateTime={result?.timestamps_utc[i]}>
            {result ? fmtUtc(result.timestamps_utc[i]) : "—— UTC"}
          </time>
        </div>
      </header>

      {synthetic && tab === "compare" && (
        <div role="alert" className="border-b border-sun/40 bg-sun/10 px-4 py-1.5 text-[12px] text-sun">
          Synthetic demo mode: values come from a crude analytic model for UI development. They are not SPICE results and not NASA data.
        </div>
      )}

      <div className={tab === "compare" ? "grid flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]" : "hidden"}>
        <aside className="space-y-3 border-b border-line p-3 lg:sticky lg:top-12 lg:h-[calc(100vh-3rem)] lg:overflow-y-auto lg:border-r lg:border-b-0">
          {sites.map((s, k) => (
            <SiteCard
              key={LETTERS[k]}
              letter={LETTERS[k]}
              draft={s}
              onChange={(d) => setSites((prev) => prev.map((p, j) => (j === k ? d : p)))}
              picking={picking === LETTERS[k]}
              onTogglePick={() => setPicking((p) => (p === LETTERS[k] ? null : LETTERS[k]))}
            />
          ))}
          <WindowCard draft={win} onChange={setWin} maxSamples={maxSamples} coverage={coverage} />
          <div className="sticky bottom-0 -mx-3 -mb-3 space-y-2 border-t border-line bg-bg/95 p-3 backdrop-blur">
          <button
            type="button"
            disabled={!request || loading}
            onClick={() => request && run(request)}
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "Computing…" : "Compare sites"}
          </button>
          {invalid && <p className="text-[11px] text-danger">Fix the highlighted fields to run a comparison.</p>}
          {health && (
            <p className="text-[11px] leading-snug text-faint">
              {health.spice_available
                ? `SPICE kernels loaded (${health.toolkit_version}). Coverage ${health.coverage_start_utc?.slice(0, 10)} – ${health.coverage_end_utc?.slice(0, 10)}.`
                : "SPICE kernels not loaded."}
            </p>
          )}
          </div>
        </aside>

        <main className="min-w-0 space-y-3 p-3">
          {healthError && (
            <div role="alert" className="rounded-md border border-danger/50 bg-danger/10 p-3 text-[13px]">
              <p className="font-medium text-danger">Backend unreachable</p>
              <p className="mt-1 text-text">{healthError} Start it, then reload this page:</p>
              <pre className="mt-2 overflow-x-auto rounded bg-black/40 p-2 font-mono text-[12px] text-muted">cd backend &amp;&amp; uv run uvicorn app.main:app --port 8000</pre>
            </div>
          )}
          {health && !health.spice_available && (
            <div role="alert" className="rounded-md border border-sun/50 bg-sun/5 p-3 text-[13px]">
              <p className="font-medium text-sun">SPICE kernels unavailable — scientific results cannot be computed</p>
              <p className="mt-1 text-text">{health.error}</p>
              <pre className="mt-2 overflow-x-auto rounded bg-black/40 p-2 font-mono text-[12px] text-muted">./scripts/fetch_kernels.sh   # then restart the backend</pre>
              <button
                type="button"
                onClick={() => setWin((w) => ({ ...w, mode: "synthetic" }))}
                className="mt-2 rounded border border-sun/50 px-2 py-1 text-[12px] text-sun hover:bg-sun/10"
              >
                Switch to synthetic demo data (not scientific)
              </button>
            </div>
          )}
          {error && (
            <div role="alert" className="rounded-md border border-danger/50 bg-danger/10 p-3 text-[13px]">
              <p className="font-medium text-danger">
                {error.code === "invalid_request" ? "The request was rejected" : error.code === "spice_unavailable" ? "SPICE unavailable" : "Computation failed"}
              </p>
              <p className="mt-1 text-text">{error.message}</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="relative h-[420px] overflow-hidden rounded-md border border-line bg-panel sm:h-[520px] 2xl:h-auto 2xl:min-h-[640px]">
              <MoonGlobe sites={globeSites} subsolar={subsolar} subEarth={subEarth} picking={picking} onPick={onPick} view={view} active={tab === "compare"} />
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
                <div className="pointer-events-auto flex gap-1" role="group" aria-label="Globe view">
                  {(["near", "far", "south", "north"] as GlobeView[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setView((p) => ({ name: v, nonce: p.nonce + 1 }))}
                      className="rounded border border-line bg-black/60 px-2 py-0.5 text-[11px] capitalize text-muted hover:text-text"
                    >
                      {v === "near" || v === "far" ? `${v} side` : `${v} pole`}
                    </button>
                  ))}
                </div>
                {picking && (
                  <span className="rounded border border-accent/60 bg-black/70 px-2 py-0.5 text-[11px] text-accent">
                    Click the surface to place site {picking} · Esc to cancel
                  </span>
                )}
              </div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2.5 text-[11px] leading-snug text-faint">
                {result ? (
                  <>
                    Lighting from the computed subsolar point ({subsolar!.lat.toFixed(2)}°, {subsolar!.lon.toFixed(2)}°) at the scrubber time.
                    Sub-Earth point ({subEarth!.lat.toFixed(2)}°, {subEarth!.lon.toFixed(2)}°). Smooth sphere: no terrain shadows.
                    {stale && <span className="text-sun"> Markers show edited inputs; results are from the previous run.</span>}
                  </>
                ) : (
                  "Run a comparison to light the globe from the computed Sun direction."
                )}
                <span className="block text-[10px]">Basemap: NASA SVS CGI Moon Kit (LRO LROC WAC mosaic, LOLA elevation), public domain.</span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-1">
              {result
                ? result.sites.map((s, k) => <HorizonView key={s.id} site={s} letter={LETTERS[k]} index={i} />)
                : LETTERS.map((l) => (
                    <div key={l} className="flex h-[330px] items-center justify-center rounded-md border border-line bg-panel text-xs text-faint">
                      {loading ? "Computing local horizon…" : `Horizon view for site ${l}`}
                    </div>
                  ))}
            </div>
          </div>

          {result && (
            <div className="sticky top-14 z-30">
              <Scrubber key={lastReq ?? ""} result={result} index={i} onIndex={setIndex} />
            </div>
          )}

          <div className={`space-y-3 transition-opacity ${loading || stale ? "opacity-60" : ""}`}>
            {stale && !loading && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-sun/40 bg-sun/5 px-3 py-2 text-[12px] text-sun">
                <span>Inputs changed since the last run. Results below are for the previous inputs.</span>
                <button type="button" onClick={() => request && run(request)} className="shrink-0 rounded border border-sun/50 px-2 py-0.5 hover:bg-sun/10">
                  Recompute
                </button>
              </div>
            )}

            <Panel
              title="Visibility timelines"
              aside={
                <span className="text-[11px] text-faint">
                  Geometric visibility · body centre above ideal horizon (el &gt; 0°) · no terrain · click to set time
                </span>
              }
            >
              {result ? (
                <Timelines result={result} index={i} onSelectTime={onSelectTime} />
              ) : (
                <div className="flex h-[470px] items-center justify-center text-xs text-faint">
                  {loading ? "Computing geometry with SPICE…" : "No results yet."}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-sun" /> Sun above horizon</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-earth" /> Earth above horizon</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-both" /> Both</span>
                <span className="flex items-center gap-1.5"><span className="h-px w-3 border-t border-dotted border-faint" /> Ideal horizon (0°)</span>
              </div>
            </Panel>

            {result && (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <Panel title="Findings">
                  <Findings result={result} />
                </Panel>
                <Panel title="Metrics" aside={<span className="font-mono text-[11px] text-faint">{fmtUtc(result.metadata.window_start_utc).slice(0, 16)} → {fmtUtc(result.metadata.window_end_utc).slice(0, 16)}</span>}>
                  <MetricsTable result={result} />
                </Panel>
              </div>
            )}

            {result && (
              <Panel
                title="Method, limitations & provenance"
                aside={
                  <button type="button" onClick={exportJson} className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-text">
                    Export JSON
                  </button>
                }
              >
                <MethodsPanel result={result} />
              </Panel>
            )}
          </div>
        </main>
      </div>
      {routeMounted && (
        <div className={tab === "route" ? "flex flex-1 flex-col" : "hidden"}>
          <RoutePlanner active={tab === "route"} />
        </div>
      )}
      <EscHandler onEsc={() => setPicking(null)} />
    </div>
  );
}

function EscHandler({ onEsc }: { onEsc: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onEsc();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onEsc]);
  return null;
}
