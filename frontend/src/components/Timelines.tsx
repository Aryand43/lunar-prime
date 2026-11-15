"use client";

import type { Data, Layout, Shape } from "plotly.js";
import { useMemo } from "react";

import { plotlyTime } from "@/lib/format";
import type { CompareResponse, Lane } from "@/lib/types";
import PlotlyChart from "./PlotlyChart";

const SUN = "#f2b84b";
const EARTH = "#6b9cff";
const BOTH = "#d4d7dc";
const GRID = "#1b1e23";
const AXIS = "#8b919b";

const LANES: { site: 0 | 1; lane: Lane; label: string; color: string }[] = [
  { site: 0, lane: "sun", label: "A · Sun", color: SUN },
  { site: 0, lane: "earth", label: "A · Earth", color: EARTH },
  { site: 0, lane: "both", label: "A · Both", color: BOTH },
  { site: 1, lane: "sun", label: "B · Sun", color: SUN },
  { site: 1, lane: "earth", label: "B · Earth", color: EARTH },
  { site: 1, lane: "both", label: "B · Both", color: BOTH },
];

interface Props {
  result: CompareResponse;
  index: number;
  onSelectTime: (iso: string) => void;
}

export default function Timelines({ result, index, onSelectTime }: Props) {
  const x = useMemo(() => result.timestamps_utc.map(plotlyTime), [result]);

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
      line: { color, width: 1.4, dash: dash as "solid" | undefined },
      hovertemplate: `${name}: %{y:.2f}°<extra></extra>`,
      showlegend: false,
    });
    const traces: Data[] = [
      line(a.sun.el_deg, "Sun elevation", SUN, "y"),
      line(a.earth.el_deg, "Earth elevation", EARTH, "y"),
      line(b.sun.el_deg, "Sun elevation", SUN, "y2"),
      line(b.earth.el_deg, "Earth elevation", EARTH, "y2"),
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
    // Ideal horizon (elevation = 0) reference lines
    for (const yref of ["y", "y2"] as const) {
      shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, yref, y0: 0, y1: 0, line: { color: "#5d636c", width: 1, dash: "dot" } });
    }
    LANES.forEach((l, k) => {
      const yc = LANES.length - 1 - k;
      for (const iv of result.sites[l.site].intervals[l.lane]) {
        shapes.push({
          type: "rect",
          xref: "x",
          yref: "y3",
          x0: plotlyTime(iv.start_utc),
          x1: plotlyTime(iv.end_utc),
          y0: yc - 0.32,
          y1: yc + 0.32,
          fillcolor: l.color,
          opacity: l.lane === "both" ? 0.75 : 0.85,
          line: { width: 0 },
          layer: "above",
        });
      }
    });
    const cursorShapeIndex = shapes.length;
    shapes.push({
      type: "line", xref: "x", yref: "paper", x0: x[0], x1: x[0], y0: 0, y1: 1,
      line: { color: "#5ec4b6", width: 1.5 },
    });

    const axisStyle = {
      gridcolor: GRID, zerolinecolor: GRID, linecolor: "#22262d", tickcolor: "#22262d",
      tickfont: { size: 10, color: AXIS }, titlefont: { size: 10, color: AXIS },
    };
    const layout: Partial<Layout> = {
      autosize: true,
      height: 470,
      margin: { l: 64, r: 12, t: 26, b: 34 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "var(--font-geist-sans), system-ui, sans-serif", color: AXIS, size: 11 },
      hovermode: "x unified",
      hoverlabel: { bgcolor: "#14171b", bordercolor: "#2f343c", font: { color: "#e4e6ea", size: 11 } },
      dragmode: "zoom",
      xaxis: { ...axisStyle, type: "date", anchor: "y3", title: { text: "UTC", font: { size: 10, color: AXIS } }, showspikes: true, spikecolor: "#5d636c", spikethickness: 1, spikemode: "across" },
      yaxis: { ...axisStyle, domain: [0.66, 1], title: { text: "A elev. (°)", font: { size: 10, color: AXIS } } },
      yaxis2: { ...axisStyle, domain: [0.33, 0.62], title: { text: "B elev. (°)", font: { size: 10, color: AXIS } } },
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
        { text: `Site A · ${a.label}`, xref: "paper", yref: "paper", x: 0, y: 1.0, yanchor: "bottom", xanchor: "left", showarrow: false, font: { size: 11, color: "#e4e6ea" } },
        { text: `Site B · ${b.label}`, xref: "paper", yref: "paper", x: 0, y: 0.62, yanchor: "bottom", xanchor: "left", showarrow: false, font: { size: 11, color: "#e4e6ea" } },
        { text: "Visibility intervals (refined)", xref: "paper", yref: "paper", x: 0, y: 0.29, yanchor: "bottom", xanchor: "left", showarrow: false, font: { size: 11, color: "#e4e6ea" } },
      ],
    };
    return { data: traces, layout, cursorShapeIndex };
  }, [result, x]);

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
      onClickX={(v) => onSelectTime(String(v))}
      ariaLabel="Sun and Earth elevation timelines and visibility intervals for both sites"
    />
  );
}
