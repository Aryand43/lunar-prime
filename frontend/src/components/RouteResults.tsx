"use client";

import type { Data, Layout, Shape } from "plotly.js";
import { useMemo } from "react";

import { fmtDuration, fmtUtc, plotlyTime } from "@/lib/format";
import type { ComparisonRow, RoutePlan, RouteResponse } from "@/lib/routeTypes";
import { EARTH_INK, FIELD, FONT, INK, LINE, MUTED, NIGHT, SUN_INK } from "@/lib/theme";
import PlotlyChart from "./PlotlyChart";

const short = (iso: string | null) => (iso ? fmtUtc(iso).slice(5, 16) : "—");
const h = (s: number) => `${(s / 3600).toFixed(1)} h`;

export function RouteSummary({ res }: { res: RouteResponse }) {
  if (res.status === "infeasible" || !res.route) {
    return (
      <div role="status" className="space-y-2">
        <p className="text-[15px] font-bold text-danger">No feasible route within these constraints</p>
        <p className="text-[13px] leading-snug text-text">{res.reason}</p>
        <p className="text-[13px] text-muted">No route is drawn: the planner never invents one. Relax the leg limit, horizon, waiting limit, or add waypoints.</p>
      </div>
    );
  }
  const m = res.route.metrics;
  const stat = (label: string, value: string, sub?: string) => (
    <div className="rounded-[2px] border border-line bg-field px-2.5 py-2">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="tabular-nums text-[15px] tabular-nums text-text">{value}</div>
      {sub && <div className="tabular-nums text-[13px] text-muted">{sub}</div>}
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 tabular-nums text-[13px]">
        {res.route.visited.map((id, i) => (
          <span key={id + i} className="flex items-center gap-1">
            <span className={`rounded-[2px] px-1.5 py-0.5 ${i === res.route!.visited.length - 1 ? "border border-text bg-text font-bold text-bg" : i === 0 ? "border border-line bg-field" : "border border-text font-bold text-text"}`}>
              {i > 0 && i < res.route!.visited.length - 1 ? `${i}. ` : ""}
              {id}
            </span>
            {i < res.route!.visited.length - 1 && <span className="text-muted">→</span>}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {stat("Distance", `${m.distance_km.toFixed(1)} km`)}
        {stat("Arrival", fmtDuration(m.elapsed_s), short(m.arrival_utc) + " UTC")}
        {stat("Darkness", h(m.darkness_s), `longest ${h(m.longest_darkness_s)}`)}
        {stat("Earth-invisible", h(m.earth_invisible_s), `longest ${h(m.longest_earth_invisible_s)}`)}
        {stat("Moving / waiting", `${h(m.movement_s)} / ${h(m.waiting_s)}`, m.alignment_wait_s > 0 ? `${h(m.alignment_wait_s)} grid alignment` : undefined)}
        {stat("Objective cost", m.cost.total.toFixed(3), `distance ${m.cost.distance.toFixed(2)}, darkness ${m.cost.darkness.toFixed(2)}, Earth ${m.cost.earth_invisible.toFixed(2)}`)}
      </div>
      <ul className="space-y-1.5">
        {res.explanation.map((s) => (
          <li key={s} className="flex gap-2 text-[14px] leading-snug text-text">
            <span aria-hidden className="mt-[7px] h-[5px] w-[5px] shrink-0 bg-text" />
            <span>{s}</span>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted">Generated deterministically from the returned numbers; no language model is involved.</p>
    </div>
  );
}

function fmtVal(v: number | null, unit: string) {
  if (v === null) return "—";
  return unit === "km" ? v.toFixed(1) : unit === "h" ? v.toFixed(2) : v.toFixed(3);
}

export function ComparisonTable({ res }: { res: RouteResponse }) {
  const rows: ComparisonRow[] = res.comparison;
  return (
    <div className="space-y-2">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[440px] border-collapse text-[14px]">
          <caption className="sr-only">Optimized route versus shortest-distance baseline</caption>
          <thead>
            <tr className="border-b border-line text-left text-[13px] text-muted">
              <th scope="col" className="py-1.5 pr-3 font-bold">Metric</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-bold">Optimized</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-bold">Shortest distance</th>
              <th scope="col" className="py-1.5 text-right font-bold">Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const better = r.difference !== null && Math.abs(r.difference) > 1e-9 && (r.lower_is_better ? r.difference < 0 : r.difference > 0);
              return (
                <tr key={r.metric} className="border-b border-line/60">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted">
                    {r.metric} <span className="text-muted">{r.unit !== "–" ? `(${r.unit})` : ""}</span>
                  </th>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-text">{fmtVal(r.optimized, r.unit)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{fmtVal(r.baseline, r.unit)}</td>
                  <td className={`py-1.5 text-right tabular-nums ${better ? "font-bold text-text" : "text-text"}`}>
                    {r.difference === null ? "—" : `${r.difference > 0 ? "+" : ""}${fmtVal(r.difference, r.unit)}`}
                    {better && (
                      <svg width={8} height={10} viewBox="0 0 8 10" className="ml-1.5 inline-block align-[1px]" aria-hidden>
                        <path d="M0 0l8 5-8 5z" fill="currentColor" />
                      </svg>
                    )}
                    {better && <span className="sr-only"> (optimized route is better on this metric)</span>}
                    {r.percent_change !== null && Math.abs(r.difference ?? 0) > 1e-9 && (
                      <span className="ml-1 text-[13px] text-muted">({r.percent_change > 0 ? "+" : ""}{r.percent_change.toFixed(1)}%)</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[13px] leading-snug text-muted">
        Baseline: {res.baseline.feasible && res.baseline.plan ? res.baseline.plan.visited.join(" → ") : res.baseline.reason}. Same speed,
        departure, sampling and Sun/Earth model; departs immediately with no waiting. Percentages are omitted when the baseline value is 0.{" "}
        Difference is optimized minus baseline. Bold with a triangle marks where the optimized route is better on that single metric.
      </p>
      <p className="text-[13px] leading-snug text-muted">
        Direct great circle ({res.direct.distance_km.toFixed(1)} km):{" "}
        {res.direct.feasible && res.direct.plan
          ? `feasible; cost ${res.direct.plan.metrics.cost.total.toFixed(3)}, darkness ${h(res.direct.plan.metrics.darkness_s)}.`
          : `not valid. ${res.direct.reason ?? ""}`}
      </p>
    </div>
  );
}

export function Itinerary({ plan }: { plan: RoutePlan }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[460px] border-collapse text-[14px]">
        <caption className="sr-only">Itinerary: arrival, waiting and departure at each stop</caption>
        <thead>
          <tr className="border-b border-line text-left text-[13px] text-muted">
            <th scope="col" className="py-1.5 pr-3 font-bold">#</th>
            <th scope="col" className="py-1.5 pr-3 font-bold">Base</th>
            <th scope="col" className="py-1.5 pr-3 font-bold">Arrive (UTC)</th>
            <th scope="col" className="py-1.5 pr-3 font-bold">Wait</th>
            <th scope="col" className="py-1.5 font-bold">Depart (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {plan.stops.map((s, i) => (
            <tr key={s.base_id + i} className="border-b border-line/60">
              <td className="py-1.5 pr-3 tabular-nums text-muted">{i === 0 ? "S" : i === plan.stops.length - 1 ? "◎" : i}</td>
              <td className="py-1.5 pr-3 text-text">{s.base_id}</td>
              <td className="py-1.5 pr-3 tabular-nums text-muted">{short(s.arrive_utc)}</td>
              <td className="py-1.5 pr-3 tabular-nums text-text">
                {s.wait_s > 0 ? fmtDuration(s.wait_s) : "—"}
                {s.alignment_wait_s > 0 && <span className="ml-1 text-[13px] text-muted">(incl. {fmtDuration(s.alignment_wait_s)} grid)</span>}
              </td>
              <td className="py-1.5 tabular-nums text-muted">{short(s.depart_utc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegTable({ plan }: { plan: RoutePlan }) {
  const waitBy = new Map<string, { dark: number; earth: number; dur: number }>();
  for (const s of plan.segments)
    if (s.kind === "wait") {
      const w = waitBy.get(s.base_id) ?? { dark: 0, earth: 0, dur: 0 };
      waitBy.set(s.base_id, { dark: w.dark + s.darkness_s, earth: w.earth + s.earth_invisible_s, dur: w.dur + s.duration_s });
    }
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[14px]">
        <caption className="sr-only">Per-leg distance and exposure along the moving traverse</caption>
        <thead>
          <tr className="border-b border-line text-left text-[13px] text-muted">
            <th scope="col" className="py-1.5 pr-3 font-bold">Segment</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-bold">km</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-bold">Duration</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-bold">Dark</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-bold">Earth-invisible</th>
            <th scope="col" className="py-1.5 text-right font-bold">Both visible</th>
          </tr>
        </thead>
        <tbody>
          {plan.segments.map((s, i) => (
            <tr key={i} className="border-b border-line/60">
              <td className="py-1.5 pr-3 text-text">
                {s.kind === "move" ? (
                  <>
                    {s.base_id} <span className="text-muted">→</span> {s.to_id}
                  </>
                ) : (
                  <span className="text-muted">wait at {s.base_id}{s.alignment_wait_s > 0 ? " (incl. grid alignment)" : ""}</span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{s.kind === "move" ? s.distance_km.toFixed(1) : "—"}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{fmtDuration(s.duration_s)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{h(s.darkness_s)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{h(s.earth_invisible_s)}</td>
              <td className="py-1.5 text-right tabular-nums text-muted">{h(s.both_visible_s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[13px] text-muted">
        Moving segments are evaluated at the actual position and time along the great-circle track, not from endpoint values. Waits use the base&apos;s fixed coordinates.
      </p>
    </div>
  );
}

export function TrajectoryChart({ plan, index, onSelectTime }: { plan: RoutePlan; index: number; onSelectTime: (iso: string) => void }) {
  const tr = plan.trajectory!;
  const x = useMemo(() => tr.time_utc.map(plotlyTime), [tr]);
  const { data, layout, cursor } = useMemo(() => {
    const line = (y: number[], name: string, color: string): Data => ({
      type: "scatter", mode: "lines", x, y, name, line: { color, width: 1.8 },
      hovertemplate: `${name}: %{y:.2f}°<extra></extra>`,
    });
    const shapes: Partial<Shape>[] = [];
    // shade waiting periods
    let i = 0;
    while (i < tr.status.length) {
      if (tr.status[i] === "wait") {
        let j = i;
        while (j + 1 < tr.status.length && tr.status[j + 1] === "wait") j++;
        shapes.push({ type: "rect", xref: "x", yref: "paper", x0: x[Math.max(0, i - 1)], x1: x[j], y0: 0, y1: 1, fillcolor: NIGHT, opacity: 0.08, line: { width: 0 }, layer: "below" });
        i = j + 1;
      } else i++;
    }
    shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: 0, y1: 0, line: { color: MUTED, width: 1, dash: "dash" } });
    const cursor = shapes.length;
    shapes.push({ type: "line", xref: "x", yref: "paper", x0: x[0], x1: x[0], y0: 0, y1: 1, line: { color: INK, width: 2 } });
    const ax = { gridcolor: LINE, zerolinecolor: LINE, linecolor: LINE, tickfont: { size: 12, color: MUTED, family: FONT } };
    const title = (text: string) => ({ text, font: { size: 13, color: INK, family: FONT } });
    const layout: Partial<Layout> = {
      autosize: true, height: 260, margin: { l: 52, r: 12, t: 10, b: 34 },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: MUTED, size: 12, family: FONT }, hovermode: "x unified",
      hoverlabel: { bgcolor: FIELD, bordercolor: LINE, font: { color: INK, size: 13, family: FONT } },
      showlegend: true, legend: { orientation: "h", x: 0, y: 1.14, font: { size: 13, color: INK, family: FONT } },
      xaxis: { ...ax, type: "date", title: title("UTC") },
      yaxis: { ...ax, title: title("Elevation along track (°)") },
      shapes: shapes as Layout["shapes"],
    };
    return { data: [line(tr.sun_el_deg, "Sun", SUN_INK), line(tr.earth_el_deg, "Earth", EARTH_INK)], layout, cursor };
  }, [tr, x]);
  const relayout = useMemo(() => ({ [`shapes[${cursor}].x0`]: x[index], [`shapes[${cursor}].x1`]: x[index] }), [cursor, x, index]);
  return (
    <PlotlyChart
      className="h-[260px] w-full"
      data={data}
      layout={layout}
      relayout={relayout}
      config={{ modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"] }}
      onClickX={(v) => onSelectTime(String(v))}
      ariaLabel="Sun and Earth elevation along the moving route trajectory"
    />
  );
}

export function RouteMethod({ res, onExport }: { res: RouteResponse; onExport: () => void }) {
  const s = res.search;
  const ls = s.local_search;
  const conv = res.metadata.conventions;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-3 text-[13px] leading-snug">
        <h4 className="text-[13px] text-muted">Search</h4>
        <p className="text-text">{s.method}</p>
        <p className="text-muted">{s.optimality_scope}</p>
        <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 tabular-nums text-[13px]">
          <dt className="text-muted">Time grid / sampling</dt><dd>{s.grid_minutes} min / {s.sampling_minutes.toFixed(2)} min</dd>
          <dt className="text-muted">Time steps</dt><dd>{s.n_time_steps.toLocaleString()}</dd>
          <dt className="text-muted">Bases / candidate legs</dt><dd>{s.n_bases} / {s.n_candidate_legs}</dd>
          <dt className="text-muted">States expanded</dt><dd>{s.n_states_expanded.toLocaleString()}</dd>
          <dt className="text-muted">Labels / edges relaxed</dt><dd>{s.n_labels.toLocaleString()} / {s.n_edges_relaxed.toLocaleString()}</dd>
          <dt className="text-muted">Elevation samples</dt><dd>≈ {s.estimated_sample_evaluations.toLocaleString()}</dd>
          <dt className="text-muted">Graph optimum</dt><dd>{s.graph_status}{s.graph_cost !== null ? `, cost ${s.graph_cost.toFixed(4)}` : ""}</dd>
          <dt className="text-muted">Compute time</dt><dd>{s.compute_time_ms.toFixed(0)} ms</dd>
        </dl>
        <h4 className="pt-1 text-[13px] text-muted">Local refinement</h4>
        <p className="text-muted">{ls.explanation}</p>
        {ls.seeds.length > 0 && (
          <ul className="space-y-0.5 tabular-nums text-[13px] text-text">
            {ls.seeds.map((sd) => (
              <li key={sd.seed}>
                {sd.seed}: {sd.start_cost.toFixed(4)} → {sd.end_cost.toFixed(4)} ({sd.accepted} accepted)
                {ls.selected_seed === sd.seed && <span className="ml-1 text-text font-bold">selected</span>}
              </li>
            ))}
            <li className="text-muted">{ls.evaluations.toLocaleString()} itinerary evaluations</li>
          </ul>
        )}
        <h4 className="pt-1 text-[13px] text-muted">Objective</h4>
        <p className="tabular-nums text-[13px] text-text">{res.objective.formula}</p>
        <p className="tabular-nums text-[13px] text-muted">
          w = ({res.objective.weights.distance}, {res.objective.weights.darkness}, {res.objective.weights.earth_invisible}); distance_scale_km ={" "}
          {res.objective.distance_scale_km}; exposure_scale_hours = {res.objective.exposure_scale_hours}
        </p>
      </div>
      <div className="space-y-3 text-[13px] leading-snug">
        <h4 className="text-[13px] text-muted">Model</h4>
        <dl className="space-y-1.5">
          {["route_geometry", "route_exposure", "route_time", "frame", "aberration"].map((k) => (
            <div key={k}>
              <dt className="text-[13px] text-muted">{k.replace("route_", "").replace("_", " ")}</dt>
              <dd className="text-text">{conv[k]}</dd>
            </div>
          ))}
        </dl>
        <h4 className="pt-1 text-[13px] text-muted">Not modelled</h4>
        <ul className="space-y-1">
          {res.metadata.limitations.map((l) => (
            <li key={l} className="flex gap-2 text-text">
              <span aria-hidden className="mt-[6px] h-[5px] w-[5px] shrink-0 bg-text" />
              {l}
            </li>
          ))}
        </ul>
        <h4 className="pt-1 text-[13px] text-muted">Provenance</h4>
        <p className={res.metadata.mode === "synthetic" ? "text-danger" : "text-text"}>{res.metadata.provenance}</p>
        {res.metadata.kernels.length > 0 && (
          <ul className="space-y-0.5 tabular-nums text-[13px]">
            {res.metadata.kernels.map((k) => (
              <li key={k.name}>
                <a href={k.source_url} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:decoration-text">{k.name}</a>{" "}
                <span className="text-muted">sha256 {k.sha256?.slice(0, 12)}…</span>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={onExport} className="rounded-[2px] border border-line px-2 py-1 text-[13px] text-muted hover:text-text">
          Export JSON
        </button>
      </div>
    </div>
  );
}
