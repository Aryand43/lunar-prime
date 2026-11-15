"use client";

import { useMemo } from "react";

import { compass, fmtLat, fmtLon } from "@/lib/format";
import { EARTH, EARTH_INK, FIELD, INK, LINE, MUTED, NIGHT, SUN, SUN_INK } from "@/lib/theme";
import type { SiteResult } from "@/lib/types";

const MAX_TRACK_POINTS = 1200;
const STRIP_LIM = 10; // degrees shown above/below the ideal horizon in the strip

// SVG sizes equal their rendered pixel sizes, so every font size below is a real pixel size.
const S = 200; // sky plot
const C = S / 2;
const R = 84;
const W = 216; // near-horizon strip
const H = 64;
const TICK_H = 16;

interface Props {
  site: SiteResult;
  letter: "A" | "B";
  index: number;
}

function stride(n: number) {
  return Math.max(1, Math.ceil(n / MAX_TRACK_POINTS));
}

/** Plan-view sky plot: zenith at centre, ideal horizon on the outer ring, north up, east right. */
function skyXY(az: number, el: number) {
  const r = (R * (90 - Math.max(el, 0))) / 90;
  const a = (az * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)] as const;
}

function skyTrack(az: number[], el: number[]) {
  const s = stride(az.length);
  let d = "";
  let pen = false;
  for (let i = 0; i < az.length; i += s) {
    if (el[i] < 0) {
      pen = false;
      continue;
    }
    const [x, y] = skyXY(az[i], el[i]);
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

function stripTrack(az: number[], el: number[]) {
  const s = stride(az.length);
  let d = "";
  let prevAz: number | null = null;
  let pen = false;
  for (let i = 0; i < az.length; i += s) {
    const visible = Math.abs(el[i]) <= STRIP_LIM;
    if (!visible) {
      pen = false;
      prevAz = null;
      continue;
    }
    const x = (az[i] / 360) * W;
    const y = H / 2 - (el[i] / STRIP_LIM) * (H / 2);
    const wrap = prevAz !== null && Math.abs(az[i] - prevAz) > 180;
    d += `${pen && !wrap ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
    prevAz = az[i];
  }
  return d;
}

function Readout({ name, fill, ink, az, el }: { name: string; fill: string; ink: string; az: number; el: number }) {
  const up = el > 0;
  return (
    <>
      <span className="flex items-center gap-1.5 font-bold" style={{ color: ink }}>
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: fill }} aria-hidden />
        {name}
      </span>
      <span className="text-right tabular-nums">
        {el >= 0 ? "+" : "−"}
        {Math.abs(el).toFixed(2)}°
      </span>
      <span className="whitespace-nowrap text-right tabular-nums">
        {az.toFixed(0)}° {compass(az)}
      </span>
      <span className={`text-right ${up ? "font-bold text-text" : "text-muted"}`}>{up ? "up" : "down"}</span>
    </>
  );
}

export default function HorizonView({ site, letter, index }: Props) {
  const i = Math.min(index, site.sun.az_deg.length - 1);
  const sun = { az: site.sun.az_deg[i], el: site.sun.el_deg[i] };
  const earth = { az: site.earth.az_deg[i], el: site.earth.el_deg[i] };

  const tracks = useMemo(
    () => ({
      skySun: skyTrack(site.sun.az_deg, site.sun.el_deg),
      skyEarth: skyTrack(site.earth.az_deg, site.earth.el_deg),
      stripSun: stripTrack(site.sun.az_deg, site.sun.el_deg),
      stripEarth: stripTrack(site.earth.az_deg, site.earth.el_deg),
    }),
    [site],
  );

  const body = (b: { az: number; el: number }, fill: string, ink: string, label: string) => {
    const [x, y] = skyXY(b.az, b.el);
    const below = b.el <= 0;
    const left = x > C + R / 2;
    return (
      <g>
        <circle
          cx={x}
          cy={y}
          r={6}
          fill={below ? "none" : fill}
          stroke={below ? ink : INK}
          strokeWidth={1.5}
          strokeDasharray={below ? "2 2" : undefined}
        />
        <text x={left ? x - 10 : x + 10} y={y + 4} fontSize={12} fontWeight={700} fill={ink} textAnchor={left ? "end" : "start"}>
          {label}
        </text>
      </g>
    );
  };

  const stripDot = (b: { az: number; el: number }, fill: string, ink: string) => {
    const x = (b.az / 360) * W;
    const clamped = Math.max(-STRIP_LIM, Math.min(STRIP_LIM, b.el));
    const y = H / 2 - (clamped / STRIP_LIM) * (H / 2);
    const off = Math.abs(b.el) > STRIP_LIM;
    return <circle cx={x} cy={y} r={4} fill={off ? "none" : fill} stroke={off ? ink : INK} strokeWidth={1.2} />;
  };

  return (
    <section aria-label={`Local horizon view for site ${letter}`} className="min-w-0">
      <header className="mb-3">
        <h3 className="flex items-center gap-2.5 text-[18px] leading-[24px] font-bold">
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-text text-[13px] text-bg">{letter}</span>
          <span>{site.label}</span>
        </h3>
        <p className="mt-1 text-[13px] tabular-nums text-muted">
          {fmtLat(site.lat_deg)} {fmtLon(site.lon_deg)}
        </p>
      </header>
      <div className="flex flex-col items-start gap-3">
        <svg
          width={S}
          height={S}
          viewBox={`0 0 ${S} ${S}`}
          role="img"
          aria-label={`Sky plot. Sun elevation ${sun.el.toFixed(2)} degrees, azimuth ${sun.az.toFixed(1)}. Earth elevation ${earth.el.toFixed(2)} degrees, azimuth ${earth.az.toFixed(1)}.`}
        >
          <circle cx={C} cy={C} r={R} fill={FIELD} stroke={INK} strokeWidth={1.2} />
          {[30, 60].map((e) => (
            <circle key={e} cx={C} cy={C} r={(R * (90 - e)) / 90} fill="none" stroke={LINE} strokeWidth={1} />
          ))}
          <line x1={C - R} y1={C} x2={C + R} y2={C} stroke={LINE} />
          <line x1={C} y1={C - R} x2={C} y2={C + R} stroke={LINE} />
          {(
            [
              ["N", C, C - R - 4],
              ["E", C + R + 8, C + 4],
              ["S", C, C + R + 14],
              ["W", C - R - 8, C + 4],
            ] as const
          ).map(([t, x, y]) => (
            <text key={t} x={x} y={y} fontSize={12} fill={MUTED} textAnchor="middle">
              {t}
            </text>
          ))}
          <path d={tracks.skySun} fill="none" stroke={SUN_INK} strokeOpacity={0.55} strokeWidth={1.2} />
          <path d={tracks.skyEarth} fill="none" stroke={EARTH_INK} strokeOpacity={0.55} strokeWidth={1.2} />
          {body(earth, EARTH, EARTH_INK, "Earth")}
          {body(sun, SUN, SUN_INK, "Sun")}
        </svg>
        <div>
          <p className="mb-1 text-[12px] text-muted">Within 10° of the horizon, by compass direction</p>
          <svg width={W} height={H + TICK_H} viewBox={`0 0 ${W} ${H + TICK_H}`} role="img" aria-label="Elevation near the horizon versus azimuth">
            <rect x={0} y={0} width={W} height={H / 2} fill={FIELD} />
            <rect x={0} y={H / 2} width={W} height={H / 2} fill={NIGHT} />
            {[90, 180, 270].map((a) => (
              <line key={a} x1={(a / 360) * W} y1={0} x2={(a / 360) * W} y2={H} stroke={LINE} strokeOpacity={0.6} />
            ))}
            <path d={tracks.stripSun} fill="none" stroke={SUN} strokeWidth={1.6} />
            <path d={tracks.stripEarth} fill="none" stroke={EARTH} strokeWidth={1.6} />
            {stripDot(earth, EARTH, EARTH_INK)}
            {stripDot(sun, SUN, SUN_INK)}
            {(
              [
                ["N", 0, "start"],
                ["E", 90, "middle"],
                ["S", 180, "middle"],
                ["W", 270, "middle"],
                ["N", 360, "end"],
              ] as const
            ).map(([t, a, anchor]) => (
              <text key={a} x={(a / 360) * W} y={H + 13} fontSize={12} fill={MUTED} textAnchor={anchor}>
                {t}
              </text>
            ))}
          </svg>
        </div>
        <div className="grid w-full max-w-[260px] grid-cols-[auto_1fr_auto_auto] gap-x-2.5 gap-y-1 border-t border-line pt-2 text-[13px] leading-[18px]">
          <span />
          <span className="text-right text-[12px] text-muted">Elevation</span>
          <span className="text-right text-[12px] text-muted">Azimuth</span>
          <span />
          <Readout name="Sun" fill={SUN} ink={SUN_INK} az={sun.az} el={sun.el} />
          <Readout name="Earth" fill={EARTH} ink={EARTH_INK} az={earth.az} el={earth.el} />
        </div>
      </div>
    </section>
  );
}
