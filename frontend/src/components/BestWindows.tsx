"use client";

import { useMemo, useRef, useState } from "react";

import { ApiError, postWindows, type WindowsResponse } from "@/lib/api";
import { fmtDuration } from "@/lib/format";
import type { Mode } from "@/lib/types";

export interface WindowSite {
  key: string;
  letter: string;
  color: string;
  name: string;
  lat: number;
  lon: number;
  start: string;
}

const SPANS: [string, number][] = [["3 months", 91], ["6 months", 182], ["1 year", 365]];
const PRIORITIES: [WindowsResponse["priority"], string, string][] = [
  ["both", "Power + comms", "#d4d7dc"],
  ["power", "Power (sunlight)", "#f2b84b"],
  ["comms", "Comms (Earth in view)", "#6b9cff"],
];

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const day = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** Small SVG chart: score of every candidate start over the search span, with the top windows marked. */
function Chart({ res }: { res: WindowsResponse }) {
  const W = 600;
  const H = 90;
  const s = res.series;
  const n = s.start_utc.length;
  const line = (v: number[]) => v.map((y, i) => `${i ? "L" : "M"}${((i / Math.max(1, n - 1)) * W).toFixed(1)} ${(H - y * H).toFixed(1)}`).join("");
  const idx = useMemo(() => new Map(s.start_utc.map((t, i) => [t, i])), [s.start_utc]);
  const months = useMemo(() => {
    const out: { x: number; label: string }[] = [];
    let last = "";
    s.start_utc.forEach((t, i) => {
      const m = t.slice(0, 7);
      if (m !== last) {
        last = m;
        out.push({ x: (i / Math.max(1, n - 1)) * W, label: new Date(t).toLocaleString("en", { month: "short", timeZone: "UTC" }) });
      }
    });
    return out;
  }, [s.start_utc, n]);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="Score of each candidate landing date across the search period">
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={0} x2={W} y1={H - g * H} y2={H - g * H} stroke="#1b1e23" />)}
        <path d={line(s.sun_fraction)} fill="none" stroke="#f2b84b" strokeWidth={1.2} strokeOpacity={0.8} vectorEffect="non-scaling-stroke" />
        <path d={line(s.earth_fraction)} fill="none" stroke="#6b9cff" strokeWidth={1.2} strokeOpacity={0.8} vectorEffect="non-scaling-stroke" />
        <path d={line(s.both_fraction)} fill="none" stroke="#d4d7dc" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        {res.windows.map((w) => {
          const i = idx.get(w.start_utc) ?? 0;
          const x = (i / Math.max(1, n - 1)) * W;
          return (
            <g key={w.rank}>
              <line x1={x} x2={x} y1={0} y2={H} stroke="#5ec4b6" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
              <text x={Math.min(W - 10, x + 3)} y={10} fontSize={10} fill="#5ec4b6">{w.rank}</text>
            </g>
          );
        })}
        {months.map((m) => <text key={m.x} x={m.x + 2} y={H + 11} fontSize={9} fill="#5d636c">{m.label}</text>)}
      </svg>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] text-muted">
        <span><span className="text-sun">━</span> sunlight share</span>
        <span><span className="text-earth">━</span> Earth-in-view share</span>
        <span><span className="text-both">━</span> both</span>
        <span><span className="text-accent">┆</span> top windows (by start date)</span>
      </div>
    </div>
  );
}

export default function BestWindows({ sites, missionDays, terrain, mode, onAdd, canAdd }: {
  sites: WindowSite[];
  missionDays: number;
  terrain: boolean;
  mode: Mode;
  onAdd: (site: WindowSite, startIso: string) => void;
  canAdd: boolean;
}) {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [span, setSpan] = useState(365);
  const [priority, setPriority] = useState<WindowsResponse["priority"]>("both");
  const [res, setRes] = useState<WindowsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const site = sites.find((s) => s.key === siteKey) ?? sites[0];
  const mission = Math.min(60, Math.max(0.5, missionDays));

  const run = async () => {
    if (!site) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const r = await postWindows(
        { site: { id: "site", label: site.name.slice(0, 64), lat_deg: site.lat, lon_deg: site.lon }, start_utc: `${site.start}:00Z`, span_days: span, mission_days: mission, priority, terrain, mode, top_k: 5 },
        ac.signal,
      );
      if (abortRef.current === ac) setRes(r);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      if (abortRef.current === ac) setLoading(false);
    }
  };

  if (!site) return null;
  const metricOf = (w: WindowsResponse["windows"][number]) => (priority === "power" ? w.sun_fraction : priority === "comms" ? w.earth_fraction : w.both_fraction);
  const fresh = res && res.site.label === site.name.slice(0, 64) && res.priority === priority && res.span_days === span && Math.abs(res.mission_days - mission) < 1e-9;

  return (
    <section aria-labelledby="best-windows-h" className="space-y-2.5 rounded-md border border-accent/30 bg-panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="best-windows-h" className="text-[13px] font-medium">Find the best landing dates</h3>
        <span className="text-[10.5px] text-faint">Scans start times every 6 h over the period for a {fmtDuration(mission * 86400)} surface mission</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Site</span>
          <select className="rounded border border-line bg-panel-2 px-1.5 py-1 text-[12px]" value={site.key} onChange={(e) => setSiteKey(e.target.value)}>
            {sites.map((s) => <option key={s.key} value={s.key}>{s.letter} · {s.name}</option>)}
          </select>
        </label>
        <div role="radiogroup" aria-label="Search period" className="flex gap-1">
          {SPANS.map(([label, d]) => (
            <button key={d} type="button" role="radio" aria-checked={span === d} onClick={() => setSpan(d)} className={`rounded border px-2 py-0.5 text-[11.5px] ${span === d ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-text"}`}>{label}</button>
          ))}
        </div>
        <span className="text-[11px] text-faint">from {site.start.replace("T", " ")} UTC</span>
      </div>
      <div role="radiogroup" aria-label="Optimise for" className="flex flex-wrap gap-1">
        {PRIORITIES.map(([p, label, color]) => (
          <button key={p} type="button" role="radio" aria-checked={priority === p} onClick={() => setPriority(p)} className={`rounded-full border px-2.5 py-0.5 text-[11.5px] ${priority === p ? "border-white/40 bg-white/10 text-text" : "border-line text-muted hover:text-text"}`}>
            <span className="mr-1" style={{ color }}>●</span>{label}
          </button>
        ))}
        <button type="button" onClick={run} disabled={loading} className="ml-auto rounded bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90 disabled:opacity-50">
          {loading ? "Scanning…" : fresh ? "Scan again" : "Find dates"}
        </button>
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {res && (
        <div className={`space-y-2 ${loading ? "opacity-60" : ""}`}>
          {!fresh && <p className="text-[11px] text-sun">Settings changed since this scan; press Find dates to refresh.</p>}
          <Chart res={res} />
          <ol className="divide-y divide-line/60 rounded border border-line">
            {res.windows.map((w) => (
              <li key={w.rank} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 text-[12px]">
                <span className="w-5 font-mono text-accent">#{w.rank}</span>
                <span className="font-mono text-text">{day(w.start_utc)} UTC</span>
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  <span className="text-sun">☉ {pct(w.sun_fraction)}</span> · <span className="text-earth">⊕ {pct(w.earth_fraction)}</span> · both {pct(w.both_fraction)} · longest night {fmtDuration(w.longest_night_s)}
                </span>
                <button type="button" disabled={!canAdd} onClick={() => onAdd(site, w.start_utc.slice(0, 16))} className="ml-auto rounded border border-accent/50 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-40" title={canAdd ? "Add this date as a scenario for a refined comparison" : "Remove a scenario first (max 4)"}>
                  Compare
                </button>
              </li>
            ))}
          </ol>
          <p className="text-[10.5px] leading-snug text-faint">
            Ranked by {res.priority_text}; windows at least half a mission apart. Worst start in the period: {day(res.worst.start_utc)} ({pct(metricOf({ ...res.worst, rank: 0, end_utc: "", longest_night_s: 0, longest_blackout_s: 0 }))}).{" "}
            {res.terrain.applied ? "Uses the LOLA terrain horizon." : res.terrain.reason} {res.resolution_note}
            {res.mode === "synthetic" && <span className="text-sun"> Synthetic demo geometry: not SPICE or NASA data.</span>}
          </p>
        </div>
      )}
    </section>
  );
}
