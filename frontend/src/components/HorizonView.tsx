"use client";

import { useMemo } from "react";

import { compass, fmtLat, fmtLon } from "@/lib/format";
import type { SiteResult } from "@/lib/types";

const SUN = "#f2b84b";
const EARTH = "#6b9cff";
const MAX_TRACK_POINTS = 1200;
const STRIP_LIM = 10; // degrees shown above/below the ideal horizon in the strip

interface Props {
  site: SiteResult;
  letter: string;
  index: number;
}

function stride(n: number) {
  return Math.max(1, Math.ceil(n / MAX_TRACK_POINTS));
}

/** Plan-view sky plot: zenith at centre, ideal horizon on the outer ring, north up, east right. */
function skyXY(az: number, el: number, R: number, c: number) {
  const r = (R * (90 - Math.max(el, 0))) / 90;
  const a = (az * Math.PI) / 180;
  return [c + r * Math.sin(a), c - r * Math.cos(a)] as const;
}

function skyTrack(az: number[], el: number[], R: number, c: number) {
  const s = stride(az.length);
  let d = "";
  let pen = false;
  for (let i = 0; i < az.length; i += s) {
    if (el[i] < 0) {
      pen = false;
      continue;
    }
    const [x, y] = skyXY(az[i], el[i], R, c);
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

function stripTrack(az: number[], el: number[], W: number, H: number) {
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

/** Terrain horizon elevation at an azimuth (linear on the 0.5° grid), or 0 for the ideal horizon. */
function makeHz(site: SiteResult) {
  const t = site.terrain;
  if (!t?.applied || !t.el_deg?.length) return null;
  const el = t.el_deg;
  const step = 360 / el.length;
  return (az: number) => {
    const a = (((az % 360) + 360) % 360) / step;
    const i0 = Math.floor(a) % el.length;
    const f = a - Math.floor(a);
    return el[i0] * (1 - f) + el[(i0 + 1) % el.length] * f;
  };
}

function Readout({ name, color, az, el, hz }: { name: string; color: string; az: number; el: number; hz: number | null }) {
  const up = el > (hz ?? 0);
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
        <span className="text-text">{name}</span>
      </span>
      <span className="font-mono tabular-nums text-muted">
        el <span className="text-text">{el >= 0 ? "+" : "−"}{Math.abs(el).toFixed(2)}°</span> · az{" "}
        <span className="text-text">{az.toFixed(1)}°</span> {compass(az)}
      </span>
      <span className={`w-[78px] text-right text-[10px] uppercase tracking-wider ${up ? "text-text" : "text-faint"}`}>
        {hz === null ? (up ? "above hzn" : "below hzn") : up ? "visible" : el > 0 ? "terrain-blocked" : "below hzn"}
      </span>
    </div>
  );
}

export default function HorizonView({ site, letter, index }: Props) {
  const S = 200;
  const c = S / 2;
  const R = 86;
  const W = 300;
  const H = 64;
  const i = Math.min(index, site.sun.az_deg.length - 1);
  const hz = useMemo(() => makeHz(site), [site]);
  const sun = { az: site.sun.az_deg[i], el: site.sun.el_deg[i] };
  const earth = { az: site.earth.az_deg[i], el: site.earth.el_deg[i] };

  const tracks = useMemo(
    () => ({
      skySun: skyTrack(site.sun.az_deg, site.sun.el_deg, R, c),
      skyEarth: skyTrack(site.earth.az_deg, site.earth.el_deg, R, c),
      stripSun: stripTrack(site.sun.az_deg, site.sun.el_deg, W, H),
      stripEarth: stripTrack(site.earth.az_deg, site.earth.el_deg, W, H),
      skyTerrain: hz ? (() => {
        let d = "";
        for (let a = 0; a <= 360; a += 1) {
          const [x, y] = skyXY(a, Math.max(0, hz(a)), R, c);
          d += `${a ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
        }
        // close along the outer ring (counter-clockwise) to fill the ground
        for (let a = 360; a >= 0; a -= 5) {
          const [x, y] = skyXY(a, 0, R, c);
          d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
        }
        return d + "Z";
      })() : "",
      stripTerrain: hz ? (() => {
        let d = `M0 ${H}`;
        for (let a = 0; a <= 360; a += 1) {
          const e = Math.max(-STRIP_LIM, Math.min(STRIP_LIM, hz(a)));
          d += `L${((a / 360) * W).toFixed(1)} ${(H / 2 - (e / STRIP_LIM) * (H / 2)).toFixed(1)}`;
        }
        return d + `L${W} ${H}Z`;
      })() : "",
    }),
    [site, c, hz],
  );

  const body = (b: { az: number; el: number }, color: string, label: string) => {
    const [x, y] = skyXY(b.az, b.el, R, c);
    const below = b.el <= (hz ? hz(b.az) : 0);
    return (
      <g>
        <circle cx={x} cy={y} r={5} fill={below ? "none" : color} stroke={color} strokeWidth={1.5} strokeDasharray={below ? "2 2" : undefined} />
        <text x={x + 8} y={y + 3} fontSize={9} fill={color}>
          {label}
        </text>
      </g>
    );
  };

  const stripDot = (b: { az: number; el: number }, color: string) => {
    const x = (b.az / 360) * W;
    const clamped = Math.max(-STRIP_LIM, Math.min(STRIP_LIM, b.el));
    const y = H / 2 - (clamped / STRIP_LIM) * (H / 2);
    const off = Math.abs(b.el) > STRIP_LIM;
    return <circle cx={x} cy={y} r={3.5} fill={off ? "none" : color} stroke={color} strokeWidth={1.2} />;
  };

  return (
    <section aria-label={`Local horizon view for site ${letter}`} className="rounded-md border border-line bg-panel p-3">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="truncate text-sm font-medium">
          <span className="mr-1.5 font-semibold">{letter}</span>
          {site.label}
        </h3>
        <span className="shrink-0 font-mono text-[10px] text-muted">
          {fmtLat(site.lat_deg)} {fmtLon(site.lon_deg)}
        </span>
      </header>
      <div className="flex flex-col items-center gap-2">
        <svg viewBox={`0 0 ${S} ${S}`} className="w-full max-w-[200px]" role="img"
          aria-label={`Sky plot. Sun elevation ${sun.el.toFixed(2)} degrees, azimuth ${sun.az.toFixed(1)}. Earth elevation ${earth.el.toFixed(2)} degrees, azimuth ${earth.az.toFixed(1)}.`}>
          <circle cx={c} cy={c} r={R} fill="#0c0e11" stroke="#3a4048" strokeWidth={1} />
          {[30, 60].map((e) => (
            <circle key={e} cx={c} cy={c} r={(R * (90 - e)) / 90} fill="none" stroke="#22262d" strokeWidth={0.8} />
          ))}
          <line x1={c - R} y1={c} x2={c + R} y2={c} stroke="#1b1e23" />
          <line x1={c} y1={c - R} x2={c} y2={c + R} stroke="#1b1e23" />
          {[
            ["N", c, c - R - 5],
            ["E", c + R + 6, c + 3],
            ["S", c, c + R + 11],
            ["W", c - R - 6, c + 3],
          ].map(([t, x, y]) => (
            <text key={t as string} x={x as number} y={y as number} fontSize={9} fill="#8b919b" textAnchor="middle">
              {t}
            </text>
          ))}
          <text x={c + 3} y={c - (R * 60) / 90 + 9} fontSize={7} fill="#5d636c">30°</text>
          <text x={c + 3} y={c - (R * 30) / 90 + 9} fontSize={7} fill="#5d636c">60°</text>
          {tracks.skyTerrain && <path d={tracks.skyTerrain} fill="#3a2f26" fillOpacity={0.85} stroke="#a08060" strokeWidth={0.8} fillRule="evenodd" />}
          <path d={tracks.skySun} fill="none" stroke={SUN} strokeOpacity={0.25} strokeWidth={1} />
          <path d={tracks.skyEarth} fill="none" stroke={EARTH} strokeOpacity={0.3} strokeWidth={1} />
          {body(earth, EARTH, "Earth")}
          {body(sun, SUN, "Sun")}
        </svg>
        <div className="w-full">
          <div className="mb-1 flex justify-between text-[10px] text-faint">
            <span>Near-horizon detail (±{STRIP_LIM}°){hz && <span className="ml-1 text-[#c4a07a]">· brown = LOLA terrain</span>}</span>
            <span>azimuth →</span>
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="Elevation near the horizon versus azimuth">
            <rect x={0} y={H / 2} width={W} height={H / 2} fill="#121418" />
            {tracks.stripTerrain && <path d={tracks.stripTerrain} fill="#3a2f26" fillOpacity={0.9} stroke="#a08060" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
            <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#5d636c" strokeDasharray="2 2" />
            {[90, 180, 270].map((a) => (
              <line key={a} x1={(a / 360) * W} y1={0} x2={(a / 360) * W} y2={H} stroke="#1b1e23" />
            ))}
            <path d={tracks.stripSun} fill="none" stroke={SUN} strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <path d={tracks.stripEarth} fill="none" stroke={EARTH} strokeOpacity={0.4} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {stripDot(earth, EARTH)}
            {stripDot(sun, SUN)}
          </svg>
          <div className="mt-0.5 flex justify-between font-mono text-[9px] text-faint">
            <span>N 0°</span><span>E 90°</span><span>S 180°</span><span>W 270°</span><span>360°</span>
          </div>
        </div>
        <div className="w-full space-y-1 border-t border-line pt-2">
          <Readout name="Sun" color={SUN} az={sun.az} el={sun.el} hz={hz ? hz(sun.az) : null} />
          <Readout name="Earth" color={EARTH} az={earth.az} el={earth.el} hz={hz ? hz(earth.az) : null} />
          <p className="text-[10px] leading-snug text-faint">
            {site.terrain?.applied
              ? `Terrain horizon from NASA LOLA (240 m); max ${site.terrain.max_horizon_deg?.toFixed(1)}°${(site.terrain.max_horizon_deg ?? 0) > 0 && site.terrain.el_deg && Math.min(...site.terrain.el_deg) < 0 ? ", below 0° where the site looks down off high ground" : ""}.`
              : site.terrain?.reason ?? "Ideal horizon (no terrain)."}
          </p>
        </div>
      </div>
    </section>
  );
}
