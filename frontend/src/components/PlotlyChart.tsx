"use client";

import type { Config, Data, Layout, PlotMouseEvent } from "plotly.js";
import { useEffect, useRef, useState } from "react";

type PlotlyModule = typeof import("plotly.js");

interface Props {
  data: Data[];
  layout: Partial<Layout>;
  config?: Partial<Config>;
  onClickX?: (x: string | number) => void;
  /** Cheap updates applied with Plotly.relayout (e.g. a moving cursor shape). */
  relayout?: Record<string, unknown>;
  className?: string;
  ariaLabel: string;
}

/** Minimal Plotly wrapper: loads plotly.js-dist-min lazily on the client, re-renders with Plotly.react. */
export default function PlotlyChart({ data, layout, config, onClickX, relayout, className, ariaLabel }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const [plotly, setPlotly] = useState<PlotlyModule | null>(null);
  const [failed, setFailed] = useState(false);
  const clickRef = useRef(onClickX);
  useEffect(() => {
    clickRef.current = onClickX;
  }, [onClickX]);

  useEffect(() => {
    let cancelled = false;
    import("plotly.js-dist-min")
      .then((m) => !cancelled && setPlotly((m.default ?? m) as unknown as PlotlyModule))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const node = el.current;
    if (!plotly || !node) return;
    plotly.react(node, data, layout, { displaylogo: false, responsive: true, ...config }).then(() => {
      const gd = node as unknown as { on?: (ev: string, cb: (e: PlotMouseEvent) => void) => void; removeAllListeners?: (ev: string) => void };
      gd.removeAllListeners?.("plotly_click");
      gd.on?.("plotly_click", (e) => {
        const x = e.points?.[0]?.x;
        if (x !== undefined && x !== null) clickRef.current?.(x as string | number);
      });
    });
  }, [plotly, data, layout, config]);

  useEffect(() => {
    const node = el.current;
    if (!plotly || !node || !relayout) return;
    if (!(node as unknown as { _fullLayout?: unknown })._fullLayout) return;
    plotly.relayout(node, relayout as Partial<Layout>);
  }, [plotly, relayout]);

  useEffect(() => {
    const node = el.current;
    return () => {
      if (plotly && node) plotly.purge(node);
    };
  }, [plotly]);

  return (
    <div className={className} role="img" aria-label={ariaLabel}>
      {!plotly && !failed && <div className="flex h-full items-center justify-center text-xs text-muted">Loading chart…</div>}
      {failed && <div className="flex h-full items-center justify-center text-xs text-danger">Chart library failed to load.</div>}
      <div ref={el} className="h-full w-full" />
    </div>
  );
}
