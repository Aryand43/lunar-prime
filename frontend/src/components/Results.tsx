"use client";

import { fmtDeg, fmtDuration, fmtPct, fmtUtc } from "@/lib/format";
import type { CompareResponse, GapOut, Statement } from "@/lib/types";

function gapText(g: GapOut | null, visibleFraction: number) {
  if (g === null) return { main: "none", sub: "visible throughout" };
  const lb = g.open_start || g.open_end;
  return {
    main: `${lb ? "≥ " : ""}${fmtDuration(g.duration_s)}`,
    sub: visibleFraction === 0 ? "never visible" : lb ? "cut off by window edge" : `${fmtUtc(g.start_utc).slice(5, 16)} → ${fmtUtc(g.end_utc).slice(5, 16)}`,
  };
}

type Row = {
  label: string;
  unit?: string;
  hint?: string;
  value: (m: CompareResponse["sites"][number]["metrics"]) => { main: string; sub?: string };
  /** id of favoured site from comparison statements, if any */
  statement?: string;
};

const rows: Row[] = [
  {
    label: "Sunlight",
    hint: "Sun centre above ideal horizon",
    value: (m) => ({ main: fmtPct(m.sun.visible_fraction), sub: fmtDuration(m.sun.visible_duration_s) }),
    statement: "sun_duration",
  },
  {
    label: "Earth visibility",
    hint: "Earth centre above ideal horizon",
    value: (m) => ({ main: fmtPct(m.earth.visible_fraction), sub: fmtDuration(m.earth.visible_duration_s) }),
    statement: "earth_duration",
  },
  {
    label: "Both simultaneously",
    value: (m) => ({ main: fmtPct(m.both_fraction), sub: fmtDuration(m.both_duration_s) }),
    statement: "both_duration",
  },
  {
    label: "Longest without sunlight",
    value: (m) => gapText(m.sun.longest_gap, m.sun.visible_fraction),
    statement: "sun_gap",
  },
  {
    label: "Longest without Earth",
    value: (m) => gapText(m.earth.longest_gap, m.earth.visible_fraction),
    statement: "earth_gap",
  },
  {
    label: "Sun elevation range",
    value: (m) => ({ main: `${fmtDeg(m.sun.el_min_deg, 1)} … ${fmtDeg(m.sun.el_max_deg, 1)}` }),
  },
  {
    label: "Earth elevation range",
    value: (m) => ({ main: `${fmtDeg(m.earth.el_min_deg, 1)} … ${fmtDeg(m.earth.el_max_deg, 1)}` }),
  },
  {
    label: "Near horizon (|el| < 1°)",
    hint: "Approximate; high values mean terrain could change results",
    value: (m) => ({ main: `☉ ${fmtPct(m.sun.near_horizon_fraction)}`, sub: `⊕ ${fmtPct(m.earth.near_horizon_fraction)}` }),
  },
];

export function MetricsTable({ result }: { result: CompareResponse }) {
  const [a, b] = result.sites;
  const favors = new Map(result.comparison.statements.map((s) => [s.id, s.favors]));
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[460px] border-collapse text-sm">
        <caption className="sr-only">Summary metrics for both sites over the selected window</caption>
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">Metric</th>
            <th scope="col" className="py-2 pr-3 font-medium"><span className="text-text">A</span> · {a.label}</th>
            <th scope="col" className="py-2 font-medium"><span className="text-text">B</span> · {b.label}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const fav = r.statement ? favors.get(r.statement) : undefined;
            return (
              <tr key={r.label} className="border-b border-line/60 align-top">
                <th scope="row" className="py-2 pr-3 text-left font-normal text-muted">
                  {r.label}
                  {r.hint && <div className="text-[10px] text-faint">{r.hint}</div>}
                </th>
                {[a, b].map((s) => {
                  const v = r.value(s.metrics);
                  const win = fav === s.id;
                  return (
                    <td key={s.id} className="py-2 pr-3">
                      <div className={`font-mono tabular-nums ${win ? "text-accent" : "text-text"}`}>
                        {v.main}
                        {win && <span className="sr-only"> (favoured on this criterion)</span>}
                      </div>
                      {v.sub && <div className="font-mono text-[11px] text-faint">{v.sub}</div>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-faint">
        <span className="text-accent">Teal</span> marks the site favoured on that single criterion (more time visible, or a shorter gap),
        beyond a {fmtDuration(result.comparison.tolerance_s)} tolerance. It is not an overall ranking.
      </p>
    </div>
  );
}

const KIND_STYLE: Record<Statement["kind"], string> = {
  comparison: "text-text",
  observation: "text-text",
  caveat: "text-muted",
};

export function Findings({ result }: { result: CompareResponse }) {
  const st = result.comparison.statements;
  const groups: [Statement["kind"], string][] = [
    ["comparison", "Comparisons"],
    ["observation", "Observations"],
    ["caveat", "Caveats"],
  ];
  return (
    <div className="space-y-4">
      <p className="text-[15px] leading-snug text-text">{result.comparison.headline}</p>
      {groups.map(([kind, title]) => {
        const items = st.filter((s) => s.kind === kind);
        if (!items.length) return null;
        return (
          <div key={kind}>
            <h4 className="mb-1.5 text-[11px] uppercase tracking-wider text-muted">{title}</h4>
            <ul className="space-y-1.5">
              {items.map((s) => (
                <li key={s.id} className={`flex gap-2 text-[13px] leading-snug ${KIND_STYLE[kind]}`}>
                  <span aria-hidden className={`mt-[7px] h-1 w-1 shrink-0 rounded-full ${kind === "caveat" ? "bg-sun" : "bg-faint"}`} />
                  <span>{s.text}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className="text-[11px] text-faint">
        Statements are generated deterministically from the computed metrics above. No language model is involved.
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
    ["Az / El", conv.angles],
    ["Visibility", conv.visibility],
    ["Time", conv.time],
  ];
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div>
        <h4 className="mb-2 text-[11px] uppercase tracking-wider text-muted">Method</h4>
        <dl className="space-y-2 text-[12px] leading-snug">
          {convRows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[110px_1fr] gap-3">
              <dt className="text-muted">{k}</dt>
              <dd className="text-text">{v}</dd>
            </div>
          ))}
          <div className="grid grid-cols-[110px_1fr] gap-3">
            <dt className="text-muted">Sampling</dt>
            <dd className="text-text">
              {md.n_samples.toLocaleString()} samples every {fmtDuration(md.step_s)} over {fmtDuration(md.window_duration_s)}.{" "}
              {md.n_refined_transitions} rise/set transitions refined by bisection to ±{md.refinement_tolerance_s} s. Events shorter
              than the sampling interval may be missed. Timeline curves are sampled; interval bars use refined times.
            </dd>
          </div>
        </dl>
      </div>
      <div className="space-y-5">
        <div>
          <h4 className="mb-2 text-[11px] uppercase tracking-wider text-muted">Not modelled</h4>
          <ul className="space-y-1.5 text-[12px] leading-snug text-text">
            {md.limitations.map((l) => (
              <li key={l} className="flex gap-2">
                <span aria-hidden className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-faint" />
                {l}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="mb-2 text-[11px] uppercase tracking-wider text-muted">Data provenance</h4>
          <p className={`mb-2 text-[12px] leading-snug ${md.mode === "synthetic" ? "text-danger" : "text-text"}`}>{md.provenance}</p>
          {md.kernels.length > 0 && (
            <ul className="space-y-1 font-mono text-[11px]">
              {md.kernels.map((k) => (
                <li key={k.name} className="flex flex-wrap items-baseline gap-x-2">
                  <a href={k.source_url} className="text-text underline decoration-line-strong underline-offset-2 hover:decoration-accent" target="_blank" rel="noreferrer">
                    {k.name}
                  </a>
                  <span className="text-faint">{k.kind}</span>
                  <span className="text-faint" title={k.sha256 ?? ""}>sha256 {k.sha256?.slice(0, 12)}…</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 font-mono text-[11px] text-faint">
            {md.toolkit_version ?? "no SPICE toolkit"} · computed {fmtUtc(md.computed_at_utc)} in {md.compute_time_ms.toFixed(0)} ms
          </p>
        </div>
      </div>
    </div>
  );
}

