"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, fetchHealth, postCompare } from "@/lib/api";
import { DEFAULT_SITES, PRESETS } from "@/lib/sites";
import type { CompareRequest, CompareResponse, HealthResponse } from "@/lib/types";
import { SiteCard, WindowCard, siteErrors, windowErrors, type SiteDraft, type WindowDraft } from "./Controls";
import HorizonView from "./HorizonView";
import type { GlobeView } from "./MoonGlobe";
import { WHY_THIS_MATTERS } from "@/lib/explain";
import { Findings, Headline, MethodsPanel, MetricsTable, WindowsList } from "./Results";
import RoutePlanner from "./RoutePlanner";
import Scrubber from "./Scrubber";
import Timelines from "./Timelines";

const MoonGlobe = dynamic(() => import("./MoonGlobe"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-black text-[13px] text-[#D9DAD8]">Loading 3D globe…</div>,
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
      ...(i === 1 && w.startB !== null ? { start_utc: `${w.startB}:00Z` } : {}),
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
    <section className={`${className}`} aria-label={title}>
      <header className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-[18px] leading-[24px] font-bold">{title}</h2>
        {aside}
      </header>
      <div className="p-0">{children}</div>
    </section>
  );
}

export default function LunarPrimeApp() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteDraft[]>(DEFAULT_SITES.map(presetDraft));
  const [win, setWin] = useState<WindowDraft>({ start: "2026-12-01T00:00", startB: null, durationDays: "29.53", stepMinutes: 30, mode: "spice" });
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [lastReq, setLastReq] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [index, setIndex] = useState(0);
  const [picking, setPicking] = useState<"A" | "B" | null>(null);
  const [view, setView] = useState<{ name: GlobeView; nonce: number }>({ name: "near", nonce: 0 });
  const [tab, setTab] = useState<"compare" | "route">("compare");
  const [routeMounted, setRouteMounted] = useState(false);
  const [explain, setExplain] = useState(true);
  const [lightFor, setLightFor] = useState<0 | 1>(0);
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
        if (h.spice_available && !autoRan.current) {
          autoRan.current = true;
          run(buildRequest(DEFAULT_SITES.map(presetDraft), { start: "2026-12-01T00:00", startB: null, durationDays: "29.53", stepMinutes: 30, mode: "spice" }));
        }
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
            ? { presetKey: "custom", label: s.presetKey === "custom" ? s.label : `Site ${picking} (custom)`, lat: lat.toFixed(4), lon: lon.toFixed(4) }
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
  const startsDiffer = result?.metadata.starts_differ ?? false;
  // The globe can be lit for one date only. When the two sites start on different dates, light it for the chosen one.
  const sp = result ? (startsDiffer ? result.sites[lightFor].subpoints : result.subpoints) : null;
  const subsolar = sp ? { lat: sp.subsolar_lat_deg[i], lon: sp.subsolar_lon_deg[i] } : null;
  const subEarth = sp ? { lat: sp.sub_earth_lat_deg[i], lon: sp.sub_earth_lon_deg[i] } : null;
  const globeSites = sites
    .map((s, k) => ({ letter: LETTERS[k], label: s.label || `Site ${LETTERS[k]}`, lat: Number(s.lat), lon: Number(s.lon) }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180);
  const synthetic = result?.metadata.mode === "synthetic";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-line bg-bg px-6">
        <div className="flex min-w-0 items-center gap-6">
          <h1 className="text-[18px] font-bold">Lunar Prime</h1>
          <div role="tablist" aria-label="Mode" className="flex gap-1">
            {(
              [
                ["compare", "Compare sites"],
                ["route", "Route planner"],
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
                }}
                className={`rounded-[2px] border px-3 py-1 text-[14px] ${tab === t ? "border-text bg-text font-bold text-bg" : "border-line text-text hover:bg-field"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className={`flex items-center gap-3 ${tab === "compare" ? "" : "hidden"}`}>
          <button
            type="button"
            role="switch"
            aria-checked={explain}
            onClick={() => setExplain((e) => !e)}
            className="flex items-center gap-2 rounded-[2px] px-1 py-1 text-[14px] text-text"
            title="Show a plain-language sentence under each number"
          >
            <span className={`relative h-[18px] w-[32px] rounded-full border ${explain ? "border-text bg-text" : "border-line bg-field"}`} aria-hidden>
              <span className={`absolute top-[2px] h-[12px] w-[12px] rounded-full transition-all ${explain ? "left-[16px] bg-bg" : "left-[2px] bg-muted"}`} />
            </span>
            Explain
          </button>
          {result && (
            <span
              className={`rounded-[2px] border px-2 py-0.5 text-[13px] ${synthetic ? "border-text font-bold text-text" : "border-line bg-field text-text"}`}
              title={result.metadata.provenance}
            >
              {synthetic ? "Synthetic demo data" : "SPICE DE440"}
            </span>
          )}
        </div>
      </header>

      {synthetic && tab === "compare" && (
        <div role="alert" className="border-b border-text bg-field px-6 py-2 text-[13px] text-text">
          <b>Synthetic demo mode.</b> Values come from a crude analytic model for UI development. They are not SPICE results and not NASA data.
        </div>
      )}

      <div className={tab === "compare" ? "grid flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]" : "hidden"}>
        <aside className="space-y-8 border-b border-line p-6 lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:overflow-y-auto lg:border-r lg:border-b-0">
          {sites.map((s, k) => (
            <SiteCard
              key={LETTERS[k]}
              letter={LETTERS[k]}
              draft={s}
              onChange={(d) => setSites((prev) => prev.map((p, j) => (j === k ? d : p)))}
              picking={picking === LETTERS[k]}
              onTogglePick={() => setPicking((p) => (p === LETTERS[k] ? null : LETTERS[k]))}
              onSameAsA={k === 1 ? () => setSites((prev) => [prev[0], { ...prev[0] }]) : undefined}
            />
          ))}
          <WindowCard draft={win} onChange={setWin} maxSamples={maxSamples} coverage={coverage} />
          <div className="sticky bottom-0 -mx-6 -mb-6 space-y-2 border-t border-line bg-bg px-6 py-4">
            <button
              type="button"
              disabled={!request || loading}
              onClick={() => request && run(request)}
              className="w-full rounded-[2px] bg-text px-3 py-2 text-[15px] font-bold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "Computing…" : "Compare sites"}
            </button>
            {invalid && <p className="text-[13px] text-danger">Fix the highlighted fields to run a comparison.</p>}
            {health && (
              <p className="text-[13px] leading-[18px] text-muted">
                {health.spice_available
                  ? `SPICE kernels loaded (${health.toolkit_version}). Coverage ${health.coverage_start_utc?.slice(0, 10)} to ${health.coverage_end_utc?.slice(0, 10)}.`
                  : "SPICE kernels not loaded."}
              </p>
            )}
          </div>
        </aside>

        <main className="min-w-0 space-y-10 px-6 py-8 xl:px-10">
          {healthError && (
            <div role="alert" className="border border-danger bg-field p-3 text-[14px]">
              <p className="font-bold text-danger">Backend unreachable</p>
              <p className="mt-1 text-text">{healthError} Start it, then reload this page:</p>
              <pre className="mt-2 overflow-x-auto rounded-[2px] bg-bg p-2 text-[13px] text-text">cd backend &amp;&amp; uv run uvicorn app.main:app --port 8000</pre>
            </div>
          )}
          {health && !health.spice_available && (
            <div role="alert" className="border border-text bg-field p-3 text-[14px]">
              <p className="font-bold text-text">SPICE kernels unavailable, so scientific results cannot be computed.</p>
              <p className="mt-1 text-text">{health.error}</p>
              <pre className="mt-2 overflow-x-auto rounded-[2px] bg-bg p-2 text-[13px] text-text">./scripts/fetch_kernels.sh   # then restart the backend</pre>
              <button
                type="button"
                onClick={() => setWin((w) => ({ ...w, mode: "synthetic" }))}
                className="mt-2 rounded-[2px] border border-text px-2 py-1 text-[13px] text-text hover:bg-bg"
              >
                Switch to synthetic demo data (not scientific)
              </button>
            </div>
          )}
          {error && (
            <div role="alert" className="border border-danger bg-field p-3 text-[14px]">
              <p className="font-bold text-danger">
                {error.code === "invalid_request" ? "The request was rejected" : error.code === "spice_unavailable" ? "SPICE unavailable" : "Computation failed"}
              </p>
              <p className="mt-1 text-text">{error.message}</p>
            </div>
          )}

          {stale && !loading && (
            <div className="flex items-center justify-between gap-3 border border-text bg-field px-3 py-2 text-[13px] text-text">
              <span>
                <b>Inputs changed since the last run.</b> Results below are for the previous inputs.
              </span>
              <button type="button" onClick={() => request && run(request)} className="shrink-0 rounded-[2px] border border-text bg-text px-2 py-0.5 font-bold text-bg hover:opacity-90">
                Recompute
              </button>
            </div>
          )}

          {result && (
            <section aria-label="Findings and metrics" className={`space-y-8 border-b border-line pb-10 transition-opacity ${loading || stale ? "opacity-60" : ""}`}>
              <Headline result={result} />
              <div className="grid grid-cols-1 gap-12 xl:grid-cols-[minmax(0,1fr)_560px]">
                <Findings result={result} />
                <MetricsTable result={result} explain={explain} />
              </div>
            </section>
          )}

          {result && explain && (
            <section aria-label="Why this matters" className="border-b border-line pb-10">
              <h2 className="mb-1.5 text-[18px] leading-[24px] font-bold">Why this matters</h2>
              <p className="max-w-[820px] text-[15px] leading-[23px] text-text">{WHY_THIS_MATTERS}</p>
            </section>
          )}

          <div className="grid grid-cols-1 gap-8 border-b border-line pb-10 xl:grid-cols-[560px_minmax(0,1fr)]">
            <div className="relative h-[420px] overflow-hidden bg-space sm:h-[520px] xl:h-[620px]">
              <MoonGlobe sites={globeSites} subsolar={subsolar} subEarth={subEarth} picking={picking} onPick={onPick} view={view} active={tab === "compare"} />
              <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-2 p-3">
                <div className="pointer-events-auto flex gap-1" role="group" aria-label="Globe view">
                  {(["near", "far", "south", "north"] as GlobeView[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setView((p) => ({ name: v, nonce: p.nonce + 1 }))}
                      className={`rounded-[2px] border px-2.5 py-1 text-[13px] ${
                        view.name === v ? "border-white bg-white text-black" : "border-[#55585c] bg-black/60 text-[#D9DAD8] hover:border-white"
                      }`}
                    >
                      {v === "near" ? "Near side" : v === "far" ? "Far side" : v === "south" ? "South pole" : "North pole"}
                    </button>
                  ))}
                </div>
                {picking && (
                  <span className="rounded-[2px] border border-white bg-black/70 px-2 py-1 text-[13px] font-bold text-white">
                    Click the Moon to place site {picking}. Press Esc to cancel.
                  </span>
                )}
                {startsDiffer && !picking && (
                  <div className="pointer-events-auto flex gap-1" role="group" aria-label="Light the globe for the date of">
                    {([0, 1] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={lightFor === k}
                        onClick={() => setLightFor(k)}
                        className={`rounded-[2px] border px-2.5 py-1 text-[13px] ${
                          lightFor === k ? "border-white bg-white text-black" : "border-[#55585c] bg-black/60 text-[#D9DAD8] hover:border-white"
                        }`}
                      >
                        Light for {LETTERS[k]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3 text-[13px] leading-[18px] text-[#D9DAD8]">
                {result ? (
                  <>
                    {startsDiffer && <b className="text-white">Lit for site {LETTERS[lightFor]}&apos;s date. </b>}
                    Subsolar point ({subsolar!.lat.toFixed(2)}°, {subsolar!.lon.toFixed(2)}°). Sub-Earth point ({subEarth!.lat.toFixed(2)}°,{" "}
                    {subEarth!.lon.toFixed(2)}°).
                    {stale && <span className="font-bold text-white"> Markers show edited inputs; results are from the previous run.</span>}
                  </>
                ) : (
                  "Run a comparison to light the globe from the computed Sun direction."
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 content-start gap-8 sm:grid-cols-2">
              {result
                ? result.sites.map((s, k) => (
                    <HorizonView
                      key={s.id}
                      site={s}
                      letter={LETTERS[k]}
                      index={i}
                      timeUtc={s.timestamps_utc[i]}
                      windowEndUtc={s.timestamps_utc[s.timestamps_utc.length - 1]}
                      explain={explain}
                    />
                  ))
                : LETTERS.map((l) => (
                    <div key={l} className="flex h-[330px] items-center justify-center text-[13px] text-muted">
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

          <div className={`space-y-10 transition-opacity ${loading || stale ? "opacity-60" : ""}`}>
            <Panel title="Visibility timelines" aside={<span className="text-[13px] text-muted">Click the chart to set the time.</span>}>
              {result ? (
                <Timelines result={result} index={i} onSelectTime={onSelectTime} onSelectIndex={setIndex} />
              ) : (
                <div className="flex h-[470px] items-center justify-center text-[13px] text-muted">
                  {loading ? "Computing geometry with SPICE…" : "No results yet."}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 bg-sun" /> Sun above horizon</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 bg-earth" /> Earth above horizon</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 bg-text" /> Sun and Earth together</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 bg-night" /> Not visible</span>
                <span className="flex items-center gap-1.5"><span className="h-px w-4 border-t border-dashed border-muted" /> Ideal horizon (0°)</span>
              </div>
              {result && (
                <div className="mt-6">
                  <WindowsList result={result} />
                </div>
              )}
            </Panel>

            {result && (
              <Panel
                title="Method and limitations"
                aside={
                  <button type="button" onClick={exportJson} className="rounded-[2px] border border-line bg-field px-2 py-0.5 text-[13px] text-text hover:border-text">
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
