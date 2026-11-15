"use client";

import type { Data, Layout, Shape } from "plotly.js";
import { useMemo } from "react";

import { plotlyTime } from "@/lib/format";
import type { CompareResponse, Lane } from "@/lib/types";
import { EARTH, EARTH_INK, FIELD, FONT, INK, LINE, MUTED, NIGHT, SUN, SUN_INK } from "@/lib/theme";
import PlotlyChart from "./PlotlyChart";


const LANES: { site: 0 | 1; lane: Lane; label: string; color: string }[] = [
  { site: 0, lane: "sun", label: "A Sun", color: SUN },
  { site: 0, lane: "earth", label: "A Earth", color: EARTH },
  { site: 0, lane: "both", label: "A Both", color: INK },
  { site: 1, lane: "sun", label: "B Sun", color: SUN },
  { site: 1, lane: "earth", label: "B Earth", color: EARTH },
  { site: 1, lane: "both", label: "B Both", color: INK },
];

interface Props {
  result: CompareResponse;
  index: number;
  onSelectTime: (iso: string) => void;
  /** Used when the sites start on different dates: the x axis is then days since each scenario's start. */
  onSelectIndex: (i: number) => void;
}

export default function Timelines({ result, index, onSelectTime, onSelectIndex }: Props) {
  // Equal starts: a shared UTC axis. Different starts: a numeric axis of days since each scenario's start.
  const byDay = result.metadata.starts_differ;
  const x = useMemo<(string | number)[]>(
    () => (byDay ? result.elapsed_s.map((e) => e / 86400) : result.timestamps_utc.map(plotlyTime)),
    [result, byDay],
  );

  const { data, layout, cursorShapeIndex } = useMemo(() => {
    const [a, b] = result.sites;
    const line = (y: number[], name: string, color: string, axis: string, dash?: string): Data => ({
      type: "scattergl",
      mode: "lines",
      x,
      y,
      name,
      xaxis: "x",
      yaxis: axis,
      line: { color, width: 1.8, dash: dash as "solid" | undefined },
      hovertemplate: `${name}: %{y:.2f}°<extra></extra>`,
      showlegend: false,
    });
    const traces: Data[] = [
      line(a.sun.el_deg, "Sun elevation", SUN_INK, "y"),
      line(a.earth.el_deg, "Earth elevation", EARTH_INK, "y"),
      line(b.sun.el_deg, "Sun elevation", SUN_INK, "y2"),
      line(b.earth.el_deg, "Earth elevation", EARTH_INK, "y2"),
      // Invisible trace so the lane panel participates in hover/click.
      {
        type: "scatter",
        mode: "markers",
        x: [x[0], x[x.length - 1]],
        y: [0, 0],
        yaxis: "y3",
        marker: { opacity: 0 },
        hoverinfo: "skip",
        showlegend: false,
      },
    ];

    const shapes: Partial<Shape>[] = [];
    const startMs = [Date.parse(a.start_utc), Date.parse(b.start_utc)];
    const dayOf = (iso: string, site: 0 | 1) => (Date.parse(iso) - startMs[site]) / 86400e3;
    // Below-horizon band in each elevation subplot (from the data minimum up to 0°, so the axis range is unchanged)
    ([["y", a], ["y2", b]] as const).forEach(([yref, s]) => {
      const lo = Math.min(Math.min(...s.sun.el_deg), Math.min(...s.earth.el_deg));
      if (lo < 0) {
        shapes.push({ type: "rect", xref: "paper", x0: 0, x1: 1, yref, y0: lo, y1: 0, fillcolor: NIGHT, opacity: 0.1, line: { width: 0 }, layer: "below" });
      }
    });
    // Ideal horizon (elevation = 0) reference lines
    for (const yref of ["y", "y2"] as const) {
      shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, yref, y0: 0, y1: 0, line: { color: MUTED, width: 1, dash: "dash" } });
    }
    LANES.forEach((l, k) => {
      const yc = LANES.length - 1 - k;
      // Dark "not visible" track behind the Sun and Earth lanes; the "Both" lane gets a thin outline instead.
      shapes.push(
        l.lane === "both"
          ? { type: "rect", xref: "paper", x0: 0, x1: 1, yref: "y3", y0: yc - 0.32, y1: yc + 0.32, fillcolor: "rgba(0,0,0,0)", line: { color: LINE, width: 1 }, layer: "below" }
          : { type: "rect", xref: "paper", x0: 0, x1: 1, yref: "y3", y0: yc - 0.32, y1: yc + 0.32, fillcolor: NIGHT, line: { width: 0 }, layer: "below" },
      );
      for (const iv of result.sites[l.site].intervals[l.lane]) {
        shapes.push({
          type: "rect",
          xref: "x",
          yref: "y3",
          x0: byDay ? dayOf(iv.start_utc, l.site) : plotlyTime(iv.start_utc),
          x1: byDay ? dayOf(iv.end_utc, l.site) : plotlyTime(iv.end_utc),
          y0: yc - 0.32,
          y1: yc + 0.32,
          fillcolor: l.color,
          opacity: 1,
          line: { width: 0 },
          layer: "above",
        });
      }
    });
    const cursorShapeIndex = shapes.length;
    shapes.push({
      type: "line", xref: "x", yref: "paper", x0: x[0], x1: x[0], y0: 0, y1: 1,
      line: { color: INK, width: 2 },
    });

    const axisStyle = {
      gridcolor: LINE, zerolinecolor: LINE, linecolor: LINE, tickcolor: LINE,
      tickfont: { size: 12, color: MUTED, family: FONT },
    };
    const title = (text: string) => ({ text, font: { size: 13, color: INK, family: FONT } });
    const note = (text: string, y: number) => ({
      text, xref: "paper" as const, yref: "paper" as const, x: 0, y, yanchor: "bottom" as const, xanchor: "left" as const, showarrow: false,
      font: { size: 13, color: INK, family: FONT },
    });
    const layout: Partial<Layout> = {
      autosize: true,
      height: 470,
      margin: { l: 78, r: 12, t: 28, b: 40 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: FONT, color: MUTED, size: 12 },
      hovermode: "x unified",
      hoverlabel: { bgcolor: FIELD, bordercolor: LINE, font: { color: INK, size: 13, family: FONT } },
      dragmode: "zoom",
      xaxis: {
        ...axisStyle, type: byDay ? "linear" : "date", anchor: "y3",
        title: title(byDay ? "Days since each scenario's start" : "UTC"),
        showspikes: true, spikecolor: MUTED, spikethickness: 1, spikemode: "across",
      },
      yaxis: { ...axisStyle, domain: [0.66, 1], title: title("A elevation (°)") },
      yaxis2: { ...axisStyle, domain: [0.33, 0.62], title: title("B elevation (°)") },
      yaxis3: {
        ...axisStyle,
        domain: [0, 0.29],
        range: [-0.6, LANES.length - 0.4],
        tickmode: "array",
        tickvals: LANES.map((_, k) => LANES.length - 1 - k),
        ticktext: LANES.map((l) => l.label),
        showgrid: false,
        fixedrange: true,
        zeroline: false,
      },
      shapes: shapes as Layout["shapes"],
      annotations: [
        note(`A ${a.label}${byDay ? `, from ${a.start_utc.slice(0, 10)}` : ""}`, 1.0),
        note(`B ${b.label}${byDay ? `, from ${b.start_utc.slice(0, 10)}` : ""}`, 0.62),
        note("Visibility intervals (refined)", 0.29),
      ],
    };
    return { data: traces, layout, cursorShapeIndex };
  }, [result, x, byDay]);

  const relayout = useMemo(
    () => ({ [`shapes[${cursorShapeIndex}].x0`]: x[index], [`shapes[${cursorShapeIndex}].x1`]: x[index] }),
    [cursorShapeIndex, x, index],
  );

  return (
    <PlotlyChart
      className="h-[470px] w-full"
      data={data}
      layout={layout}
      relayout={relayout}
      config={{ modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"], scrollZoom: false }}
      onClickX={(v) => {
        if (!byDay) return onSelectTime(String(v));
        // Nearest sample by elapsed time.
        const t = Number(v) * 86400;
        let best = 0;
        result.elapsed_s.forEach((e, k) => {
          if (Math.abs(e - t) < Math.abs(result.elapsed_s[best] - t)) best = k;
        });
        onSelectIndex(best);
      }}
      ariaLabel="Sun and Earth elevation timelines and visibility intervals for both sites"
    />
  );
}
