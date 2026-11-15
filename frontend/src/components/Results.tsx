"use client";

import { Fragment } from "react";

import { EXPLAIN } from "@/lib/explain";
import { fmtDeg, fmtDuration, fmtPct, fmtUtc } from "@/lib/format";
import type { CompareResponse, GapOut, IntervalOut, Statement } from "@/lib/types";

function gapText(g: GapOut | null, visibleFraction: number) {
  if (g === null) return { main: "none", sub: "visible throughout" };
  const lb = g.open_start || g.open_end;
  return {
    main: `${lb ? "≥ " : ""}${fmtDuration(g.duration_s)}`,
    sub: visibleFraction === 0 ? "never visible" : lb ? "cut off by window edge" : `${fmtUtc(g.start_utc).slice(5, 16)} → ${fmtUtc(g.end_utc).slice(5, 16)}`,
  };
}

type Metrics = CompareResponse["sites"][number]["metrics"];

type Row = {
  label: string;
  hint?: string;
  /** Plain-language sentence shown when "Explain" is on. */
  explain?: string;
  value: (m: Metrics) => { main: string; sub?: string };
  /** Fraction (0..1) drawn as a bar under the value, and the bar's fill class. */
  bar?: { value: (m: Metrics) => number; fill: string };
  /** id of the comparison statement that names the favoured site, if any */
  statement?: string;
};

const rows: Row[] = [
  {
    label: "Sunlight",
    explain: EXPLAIN.sunlight,
    value: (m) => ({ main: fmtPct(m.sun.visible_fraction), sub: fmtDuration(m.sun.visible_duration_s) }),
    bar: { value: (m) => m.sun.visible_fraction, fill: "bg-sun" },
    statement: "sun_duration",
  },
  {
    label: "Earth in view",
    explain: EXPLAIN.earth,
    value: (m) => ({ main: fmtPct(m.earth.visible_fraction), sub: fmtDuration(m.earth.visible_duration_s) }),
    bar: { value: (m) => m.earth.visible_fraction, fill: "bg-earth" },
    statement: "earth_duration",
  },
  {
    label: "Sun and Earth together",
    explain: EXPLAIN.both,
    value: (m) => ({ main: fmtPct(m.both_fraction), sub: fmtDuration(m.both_duration_s) }),
    bar: { value: (m) => m.both_fraction, fill: "bg-text" },
    statement: "both_duration",
  },
  {
    label: "Longest night",
    explain: EXPLAIN.night,
    value: (m) => gapText(m.sun.longest_gap, m.sun.visible_fraction),
    statement: "sun_gap",
  },
  {
    label: "Longest Earth outage",
    explain: EXPLAIN.earthOutage,
    value: (m) => gapText(m.earth.longest_gap, m.earth.visible_fraction),
    statement: "earth_gap",
  },
  {
    label: "Sun elevation range",
    explain: EXPLAIN.sunElevation,
    value: (m) => ({ main: `${fmtDeg(m.sun.el_min_deg, 1)} … ${fmtDeg(m.sun.el_max_deg, 1)}` }),
  },
  {
    label: "Earth elevation range",
    value: (m) => ({ main: `${fmtDeg(m.earth.el_min_deg, 1)} … ${fmtDeg(m.earth.el_max_deg, 1)}` }),
  },
  {
    label: "Time within 1° of the horizon",
    explain: EXPLAIN.nearHorizon,
    hint: "Approximate. High values mean terrain could change the result.",
    value: (m) => ({ main: `Sun ${fmtPct(m.sun.near_horizon_fraction)}`, sub: `Earth ${fmtPct(m.earth.near_horizon_fraction)}` }),
  },
];

/** Small right-pointing triangle that marks the favoured site on one criterion. */
function FavMark() {
  return (
    <svg width={8} height={10} viewBox="0 0 8 10" className="ml-1.5 inline-block align-[1px]" aria-hidden>
      <path d="M0 0l8 5-8 5z" fill="currentColor" />
    </svg>
  );
}

export function MetricsTable({ result, explain = false }: { result: CompareResponse; explain?: boolean }) {
  const [a, b] = result.sites;
  const favors = new Map(result.comparison.statements.map((s) => [s.id, s.favors]));
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[460px] border-collapse text-[14px] leading-[20px]">
        <caption className="sr-only">Summary metrics for both sites over the selected window</caption>
        <thead>
          <tr className="border-b border-line text-left align-top text-[13px] text-muted">
            <th scope="col" className="py-2 pr-3 font-normal">Metric</th>
            {[a, b].map((s, k) => (
              <th key={s.id} scope="col" className={`py-2 font-normal ${k === 0 ? "pr-3" : ""}`}>
                <span className="mr-1.5 font-bold text-text">{k === 0 ? "A" : "B"}</span>
                {s.label}
                {result.metadata.starts_differ && <div className="text-text tabular-nums">from {fmtUtc(s.start_utc).slice(0, 16)} UTC</div>}
                {Math.abs(s.lat_deg) >= 80 && <div className="text-[12px] text-muted">smooth sphere</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const fav = r.statement ? favors.get(r.statement) : undefined;
            const showExplain = explain && !!r.explain;
            return (
              <Fragment key={r.label}>
                <tr className={`align-top ${showExplain ? "" : "border-b border-line"}`}>
                  <th scope="row" className="py-3 pr-3 text-left font-normal text-text">
                    {r.label}
                    {r.hint && <div className="mt-1 max-w-[240px] text-[13px] leading-[18px] text-muted">{r.hint}</div>}
                  </th>
                  {[a, b].map((s) => {
                    const v = r.value(s.metrics);
                    const win = fav === s.id;
                    return (
                      <td key={s.id} className="py-3 pr-3">
                        <div className={`tabular-nums ${win ? "font-bold" : ""}`}>
                          {v.main}
                          {win && (
                            <>
                              <FavMark />
                              <span className="sr-only"> (favoured on this criterion)</span>
                            </>
                          )}
                        </div>
                        {v.sub && <div className="text-[13px] leading-[18px] tabular-nums text-muted">{v.sub}</div>}
                        {r.bar && (
                          <div className="mt-2 h-[6px] w-[150px] max-w-full bg-line" aria-hidden>
                            <div className={`h-full ${r.bar.fill}`} style={{ width: `${Math.max(0, Math.min(1, r.bar.value(s.metrics))) * 100}%` }} />
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
                {showExplain && (
                  <tr className="border-b border-line">
                    <td colSpan={3} className="pb-3">
                      <p className="-mt-1 max-w-[560px] text-[13px] leading-[18px] text-muted">{r.explain}</p>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-[13px] leading-[18px] text-muted">
        Bold with a triangle marks the site favoured on that single criterion, beyond a {fmtDuration(result.comparison.tolerance_s)} tolerance. It is
        not an overall ranking.
      </p>
    </div>
  );
}

export function Headline({ result }: { result: CompareResponse }) {
  return <p className="max-w-[980px] text-[28px] leading-[34px] font-bold">{result.comparison.headline}</p>;
}

export function Findings({ result }: { result: CompareResponse }) {
  const st = result.comparison.statements;
  const groups: [Statement["kind"], string][] = [
    ["comparison", "Comparisons"],
    ["observation", "Observations"],
    ["caveat", "Caveats"],
  ];
  return (
    <div className="space-y-6">
      {groups.map(([kind, title]) => {
        const items = st.filter((s) => s.kind === kind);
        if (!items.length) return null;
        return (
          <div key={kind}>
            <h3 className="mb-2 text-[15px] font-bold">{title}</h3>
            <ul className="space-y-2">
              {items.map((s) => (
                <li key={s.id} className="flex gap-3 text-[14px] leading-[22px] text-text">
                  <span aria-hidden className="mt-[9px] h-[5px] w-[5px] shrink-0 bg-text" />
                  <span>{s.text}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className="border-t border-line pt-4 text-[13px] leading-[18px] text-muted">
        Geometric model on a smooth sphere: no terrain, body centres only. See Method and limitations below.
      </p>
    </div>
  );
}

export function MethodsPanel({ result }: { result: CompareResponse }) {
  const md = result.metadata;
  const conv = md.conventions;
  const convRows: [string, string][] = [
    ["Reference frame", conv.frame],
    ["Coordinates", conv.longitude],
    ["Lunar shape", conv.shape],
    ["Aberration", conv.aberration],
    ["Topocentric", conv.topocentric],
    ["Azimuth and elevation", conv.angles],
    ["Visibility", conv.visibility],
    ["Time", conv.time],
    ["Libration", conv.libration],
  ];
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 text-[15px] font-bold">Method</h3>
        <dl className="space-y-2 text-[14px] leading-[20px]">
          {convRows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[150px_1fr] gap-3">
              <dt className="text-muted">{k}</dt>
              <dd className="text-text">{v}</dd>
            </div>
          ))}
          <div className="grid grid-cols-[150px_1fr] gap-3">
            <dt className="text-muted">Sampling</dt>
            <dd className="text-text">
              {md.n_samples.toLocaleString()} samples every {fmtDuration(md.step_s)} over {fmtDuration(md.window_duration_s)}.{" "}
              {md.n_refined_transitions} rise and set transitions refined by bisection to ±{md.refinement_tolerance_s} s. Events shorter
              than the sampling interval may be missed. Timeline curves are sampled; interval bars use refined times.
            </dd>
          </div>
          <div className="grid grid-cols-[150px_1fr] gap-3">
            <dt className="text-muted">Findings</dt>
            <dd className="text-text">Statements are generated deterministically from the computed metrics. No language model is involved.</dd>
          </div>
          <div className="grid grid-cols-[150px_1fr] gap-3">
            <dt className="text-muted">Globe basemap</dt>
            <dd className="text-text">NASA SVS CGI Moon Kit (LRO LROC WAC mosaic, LOLA elevation), public domain. The globe is lit from the computed subsolar point; its shading is illustrative.</dd>
          </div>
        </dl>
      </div>
      <div className="space-y-6">
        <div>
          <h3 className="mb-2 text-[15px] font-bold">Not modelled</h3>
          <ul className="space-y-2 text-[14px] leading-[20px] text-text">
            {md.limitations.map((l) => (
              <li key={l} className="flex gap-3">
                <span aria-hidden className="mt-[7px] h-[5px] w-[5px] shrink-0 bg-text" />
                {l}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 text-[15px] font-bold">Data provenance</h3>
          <p className={`mb-2 text-[14px] leading-[20px] ${md.mode === "synthetic" ? "text-danger" : "text-text"}`}>{md.provenance}</p>
          {md.kernels.length > 0 && (
            <ul className="space-y-1 text-[13px] tabular-nums">
              {md.kernels.map((k) => (
                <li key={k.name} className="flex flex-wrap items-baseline gap-x-2">
                  <a href={k.source_url} className="text-text underline decoration-line underline-offset-2 hover:decoration-text" target="_blank" rel="noreferrer">
                    {k.name}
                  </a>
                  <span className="text-muted">{k.kind}</span>
                  <span className="text-muted" title={k.sha256 ?? ""}>sha256 {k.sha256?.slice(0, 12)}…</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[13px] tabular-nums text-muted">
            {md.toolkit_version ?? "No SPICE toolkit"}. Computed {fmtUtc(md.computed_at_utc)} in {md.compute_time_ms.toFixed(0)} ms.
          </p>
        </div>
      </div>
    </div>
  );
}

const MAX_WINDOW_ROWS = 50;

function WindowTable({ title, ink, intervals }: { title: string; ink: string; intervals: IntervalOut[] }) {
  const rows = intervals.slice(0, MAX_WINDOW_ROWS);
  const more = intervals.length - rows.length;
  return (
    <div className="min-w-0">
      <h4 className="mb-1.5 text-[14px] font-bold" style={{ color: ink }}>
        {title} <span className="font-normal text-muted">({intervals.length} {intervals.length === 1 ? "window" : "windows"})</span>
      </h4>
      {intervals.length === 0 ? (
        <p className="text-[13px] text-muted">None in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px] leading-[18px] tabular-nums">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="py-1.5 pr-3 font-normal">Start (UTC)</th>
                <th scope="col" className="py-1.5 pr-3 font-normal">End (UTC)</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">Duration</th>
                <th scope="col" className="py-1.5 font-normal"><span className="sr-only">Note</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((iv) => (
                <tr key={iv.start_utc} className="border-b border-line">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{fmtUtc(iv.start_utc).slice(0, 16)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{fmtUtc(iv.end_utc).slice(0, 16)}</td>
                  <td className="py-1.5 pr-3 text-right whitespace-nowrap">{fmtDuration(iv.duration_s)}</td>
                  <td className="py-1.5 text-muted">{iv.starts_at_window_start || iv.ends_at_window_end ? "continues beyond the window" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {more > 0 && <p className="mt-1.5 text-[13px] text-muted">and {more} more (see Export JSON)</p>}
        </div>
      )}
    </div>
  );
}

/** Every sunlight and Earth-contact window for both sites, as tables. Matches the bars in the timeline. */
export function WindowsList({ result }: { result: CompareResponse }) {
  return (
    <details className="group border-t border-line pt-4">
      <summary className="cursor-pointer text-[15px] font-bold">Sunlight and Earth-contact windows</summary>
      <div className="mt-4 space-y-8">
        {result.sites.map((s, k) => (
          <div key={s.id}>
            <h3 className="mb-3 flex items-center gap-2.5 text-[15px] font-bold">
              <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-text text-[13px] text-bg">{k === 0 ? "A" : "B"}</span>
              {s.label}
              {result.metadata.starts_differ && <span className="font-normal text-muted">from {fmtUtc(s.start_utc).slice(0, 16)} UTC</span>}
            </h3>
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
              <WindowTable title="Sun up" ink="var(--color-sun-ink)" intervals={s.intervals.sun} />
              <WindowTable title="Earth in view" ink="var(--color-earth-ink)" intervals={s.intervals.earth} />
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
