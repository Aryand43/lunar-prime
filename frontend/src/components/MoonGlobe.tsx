"use client";

import { Line, OrbitControls, useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { latLonToVec3, vec3ToLatLon } from "@/lib/geo";

export type MarkerKind =
  | "site"
  | "start"
  | "visited"
  | "candidate"
  | "destination"
  | "crewed"
  | "robotic"
  | "planning"
  | "user";

export interface GlobeSite {
  /** Short tag shown in bold on the label (e.g. "A", "1", "S"). */
  letter: string;
  label: string;
  lat: number;
  lon: number;
  kind?: MarkerKind;
  key?: string;
  /** Show the label only while hovered (catalogue sites, network nodes). */
  hoverOnly?: boolean;
  /** Clickable (calls onSiteClick with key). */
  interactive?: boolean;
  /** Extra tooltip line. */
  detail?: string;
}

export interface GlobePath {
  key: string;
  /** three.js world coordinates (use greatCircleArc from lib/geo). */
  points: [number, number, number][];
  color: string;
  dashed?: boolean;
  opacity?: number;
  width?: number;
  /** Tooltip text shown while hovering the path. */
  hover?: string;
  onClick?: () => void;
}

export type GlobeView = "near" | "far" | "south" | "north" | "polar";

/** Per-frame state written by playback; read inside the render loop (no React re-render). */
export interface LiveState {
  rover: { lat: number; lon: number } | null;
  subsolar: { lat: number; lon: number } | null;
}

interface Props {
  sites: GlobeSite[];
  subsolar: { lat: number; lon: number } | null;
  subEarth: { lat: number; lon: number } | null;
  picking: string | null;
  onPick: (lat: number, lon: number) => void;
  view: { name: GlobeView; nonce: number };
  paths?: GlobePath[];
  rover?: { lat: number; lon: number } | null;
  live?: React.RefObject<LiveState>;
  /** Smoothly frame these points when nonce changes. */
  focus?: { points: [number, number][]; nonce: number } | null;
  follow?: boolean;
  onSiteClick?: (key: string) => void;
  /** Close-up mode for small regions (closer zoom limit). */
  compact?: boolean;
  /** Extra ambient light (illustrative shading only). */
  ambient?: number;
  /** Pause rendering when the globe is hidden (e.g. inactive tab). */
  active?: boolean;
}

type Vec3 = [number, number, number];

const VIEW_POS: Record<GlobeView, Vec3> = {
  near: [3.9, 0.5, 0.0],
  far: [-3.9, 0.5, 0.0],
  south: [0.5, -3.9, 0.15],
  north: [0.5, 3.9, 0.15],
  polar: [0.004, -1.36, 0.0], // just off the pole axis so "up" on screen points toward 0 deg E
};

const GLYPH_R = 1.28;
const MARKER_R = 1.0016;
const FOV = 34;
const COLOR: Record<MarkerKind, string> = {
  site: "#ffffff",
  start: "#ffffff",
  visited: "#5ec4b6",
  candidate: "#8b919b",
  destination: "#f07167",
  crewed: "#f4ecd2",
  robotic: "#c39bea",
  planning: "#7d848e",
  user: "#d4d7dc",
};
const SIZE: Partial<Record<MarkerKind, number>> = { planning: 4, candidate: 6, crewed: 8, robotic: 7, user: 6 };

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** True if the straight segment camera -> p passes through the unit sphere (the Moon). */
function occludedBySphere(cam: THREE.Vector3, p: Vec3) {
  const dx = p[0] - cam.x;
  const dy = p[1] - cam.y;
  const dz = p[2] - cam.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (cam.x * dx + cam.y * dy + cam.z * dz);
  const c = cam.lengthSq() - 1;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 && t < 0.999;
}

interface Anchor {
  key: string;
  pos: Vec3;
}

/** Moves plain DOM labels to projected anchor positions every frame (no nested React roots). */
function LabelProjector({ anchors, els, live }: { anchors: Anchor[]; els: React.RefObject<Record<string, HTMLDivElement | null>>; live?: React.RefObject<LiveState> }) {
  const vRef = useRef(new THREE.Vector3());
  useFrame(({ camera, size }) => {
    const v = vRef.current;
    const place = (key: string, pos: Vec3) => {
      const el = els.current[key];
      if (!el) return;
      v.set(pos[0], pos[1], pos[2]).project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      el.style.setProperty("transform", `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`);
      el.style.setProperty("opacity", occludedBySphere(camera.position, pos) || v.z > 1 ? "0" : "1");
    };
    for (const a of anchors) place(a.key, a.pos);
    const r = live?.current?.rover;
    if (r) place("rover", latLonToVec3(r.lat, r.lon, 1.004));
  });
  return null;
}

function Moon({ picking, onPick }: { picking: boolean; onPick: Props["onPick"] }) {
  const [color, bump] = useTexture(["/textures/lroc_color_poles_2k.jpg", "/textures/ldem_3_8bit.jpg"], (tex) => {
    const [c] = tex as THREE.Texture[];
    c.colorSpace = THREE.SRGBColorSpace;
    c.anisotropy = 8;
  });
  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    // A drag (globe rotation) is never a placement: R3F reports the pointer travel in px as e.delta.
    if (!picking || e.delta > 4) return;
    e.stopPropagation();
    const { lat, lon } = vec3ToLatLon(e.point.x, e.point.y, e.point.z);
    onPick(lat, lon);
  };
  return (
    <mesh onClick={handleClick}>
      <sphereGeometry args={[1, 192, 96]} />
      <meshStandardMaterial map={color} bumpMap={bump} bumpScale={3} roughness={1} metalness={0} />
    </mesh>
  );
}

function Graticule({ polar }: { polar: boolean }) {
  const geom = useMemo(() => {
    const pts: number[] = [];
    const r = 1.0015;
    const push = (a: Vec3, b: Vec3) => pts.push(...a, ...b);
    for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 3) push(latLonToVec3(lat, lon, r), latLonToVec3(lat, lon + 3, r));
    for (let lon = -180; lon < 180; lon += 30) for (let lat = -87; lat < 87; lat += 3) push(latLonToVec3(lat, lon, r), latLonToVec3(lat + 3, lon, r));
    if (polar) {
      for (const sgn of [-1, 1]) {
        for (let c = 1; c <= 6; c++) {
          const lat = sgn * (90 - c);
          for (let lon = -180; lon < 180; lon += 2) push(latLonToVec3(lat, lon, r), latLonToVec3(lat, lon + 2, r));
        }
        for (let lon = -180; lon < 180; lon += 30) push(latLonToVec3(sgn * 84, lon, r), latLonToVec3(sgn * 90, lon, r));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [polar]);
  useEffect(() => () => geom.dispose(), [geom]);
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial color="#9aa3ad" transparent opacity={polar ? 0.14 : 0.1} depthWrite={false} />
    </lineSegments>
  );
}

function useDotTexture() {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.beginPath();
    g.arc(32, 32, 26, 0, Math.PI * 2);
    g.fillStyle = "#fff";
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = "rgba(0,0,0,0.85)";
    g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
}

/** One draw call per marker size: fixed pixel size at any zoom, depth-tested against the Moon. */
function MarkerLayer({ sites, px, tex, onHover, onClick }: {
  sites: GlobeSite[];
  px: number;
  tex: THREE.Texture;
  onHover: (key: string | null) => void;
  onClick: (s: GlobeSite) => void;
}) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    for (const s of sites) {
      pos.push(...latLonToVec3(s.lat, s.lon, MARKER_R));
      c.set(COLOR[s.kind ?? "site"]);
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return g;
  }, [sites]);
  useEffect(() => () => geom.dispose(), [geom]);
  if (!sites.length) return null;
  return (
    <points
      geometry={geom}
      renderOrder={2}
      onPointerMove={(e) => {
        e.stopPropagation();
        if (e.index !== undefined) onHover(sites[e.index]?.key ?? null);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        if (e.delta > 4 || e.index === undefined) return;
        const s = sites[e.index];
        if (s?.interactive) {
          e.stopPropagation();
          onClick(s);
        }
      }}
    >
      <pointsMaterial size={px} sizeAttenuation={false} vertexColors map={tex} alphaTest={0.5} transparent depthWrite={false} />
    </points>
  );
}

const PathLine = memo(function PathLine({ path, onHover }: { path: GlobePath; onHover: (p: GlobePath | null) => void }) {
  const pts = useMemo(() => path.points.map((p) => new THREE.Vector3(...p)), [path.points]);
  return (
    <Line
      points={pts}
      color={path.color}
      lineWidth={path.width ?? 1.5}
      dashed={path.dashed}
      dashSize={0.004}
      gapSize={0.003}
      transparent
      opacity={path.opacity ?? 1}
      onPointerOver={path.hover ? (e) => { e.stopPropagation(); onHover(path); } : undefined}
      onPointerOut={path.hover ? () => onHover(null) : undefined}
      onClick={path.onClick ? (e) => { if (e.delta <= 4) { e.stopPropagation(); path.onClick!(); } } : undefined}
    />
  );
});

/** Keeps pointer hit areas a few pixels wide at any zoom level. */
function RaycastTuner() {
  useFrame(({ raycaster, camera, size }) => {
    const h = Math.max(0.0005, camera.position.length() - 1);
    const perPx = (2 * h * Math.tan(((FOV / 2) * Math.PI) / 180)) / size.height;
    raycaster.params.Points = { threshold: perPx * 6 };
    raycaster.params.Line = { threshold: perPx * 5 };
  });
  return null;
}

function Rover({ live, fixed }: { live?: React.RefObject<LiveState>; fixed: { lat: number; lon: number } | null }) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(({ camera }) => {
    const m = mesh.current;
    if (!m) return;
    const r = live?.current?.rover ?? fixed;
    m.visible = !!r;
    if (!r) return;
    m.position.set(...latLonToVec3(r.lat, r.lon, 1.004));
    m.scale.setScalar(Math.max(0.0007, (camera.position.length() - 1) * 0.0045));
  });
  return (
    <mesh ref={mesh} renderOrder={3}>
      <sphereGeometry args={[1, 20, 20]} />
      <meshBasicMaterial color="#f2b84b" />
    </mesh>
  );
}

function SunLight({ live, subsolar, intensity }: { live?: React.RefObject<LiveState>; subsolar: Props["subsolar"]; intensity: number }) {
  const light = useRef<THREE.DirectionalLight>(null);
  useFrame(() => {
    const s = live?.current?.subsolar ?? subsolar;
    if (light.current && s) light.current.position.set(...latLonToVec3(s.lat, s.lon, 10));
  });
  return <directionalLight ref={light} position={subsolar ? latLonToVec3(subsolar.lat, subsolar.lon, 10) : [5, 2, 5]} intensity={intensity} />;
}

function frameTarget(points: [number, number][], minD: number): THREE.Vector3 {
  const vs = points.map((p) => new THREE.Vector3(...latLonToVec3(p[0], p[1], 1)));
  const c = vs.reduce((a, b) => a.add(b), new THREE.Vector3());
  if (c.length() < 1e-6) c.copy(vs[0]); // antipodal spread: centre on the first point
  c.normalize();
  const theta = Math.max(0.002, ...vs.map((v) => c.angleTo(v)));
  const half = ((FOV / 2) * Math.PI) / 180 * 0.78;
  const d = theta > 1.2 ? 3.9 : Math.cos(theta) + Math.sin(theta) / Math.tan(half);
  const D = Math.min(8, Math.max(minD, d));
  if (Math.abs(c.y) > 0.9995) c.x += 0.004; // keep OrbitControls away from the pole axis singularity
  return c.normalize().multiplyScalar(D);
}

function CameraRig({ view, focus, follow, live, minD }: { view: Props["view"]; focus: Props["focus"]; follow: boolean; live?: React.RefObject<LiveState>; minD: number }) {
  const { camera, controls } = useThree();
  const reduced = usePrefersReducedMotion();
  const anim = useRef<{ from: THREE.Vector3; to: THREE.Vector3; t: number } | null>(null);
  const tmpRef = useRef(new THREE.Vector3());

  useEffect(() => {
    camera.position.set(...VIEW_POS[view.name]);
    camera.lookAt(0, 0, 0);
    anim.current = null;
    (controls as unknown as OrbitControlsImpl | null)?.update();
  }, [view, camera, controls]);

  useEffect(() => {
    if (!focus || !focus.points.length) return;
    const to = frameTarget(focus.points, minD);
    if (reduced) {
      camera.position.copy(to);
      (controls as unknown as OrbitControlsImpl | null)?.update();
    } else anim.current = { from: camera.position.clone(), to, t: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-frame only when the nonce changes
  }, [focus?.nonce]);

  useEffect(() => {
    const c = controls as unknown as OrbitControlsImpl | null;
    if (!c) return;
    const cancel = () => (anim.current = null); // user interaction always wins over an animation
    c.addEventListener("start", cancel);
    return () => c.removeEventListener("start", cancel);
  }, [controls]);

  useFrame((_, dt) => {
    const tmp = tmpRef.current;
    const c = controls as unknown as OrbitControlsImpl | null;
    const r = live?.current?.rover;
    if (follow && r) {
      const dist = camera.position.length();
      tmp.set(...latLonToVec3(r.lat, r.lon, 1)).normalize();
      if (Math.abs(tmp.y) > 0.9995) tmp.x += 0.004;
      tmp.normalize().multiplyScalar(dist);
      if (reduced) camera.position.copy(tmp);
      else camera.position.lerp(tmp, 1 - Math.exp(-dt * 4)).setLength(dist);
      c?.update();
      return;
    }
    const a = anim.current;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / 0.9);
    const e = a.t * a.t * (3 - 2 * a.t);
    const len = a.from.length() + (a.to.length() - a.from.length()) * e;
    tmp.copy(a.from).normalize().lerp(a.to.clone().normalize(), e).normalize().multiplyScalar(len);
    camera.position.copy(tmp);
    c?.update();
    if (a.t >= 1) anim.current = null;
  });
  return null;
}

export default function MoonGlobe({
  sites, subsolar, subEarth, picking, onPick, view, paths = [], rover = null, live, focus = null, follow = false,
  onSiteClick, compact = false, ambient, active = true,
}: Props) {
  const labelEls = useRef<Record<string, HTMLDivElement | null>>({});
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [hoverPath, setHoverPath] = useState<GlobePath | null>(null);
  const tex = useDotTexture();
  const amb = ambient ?? (subsolar ? 0.05 : 0.6);

  const groups = useMemo(() => {
    const by = new Map<number, GlobeSite[]>();
    for (const s of sites) {
      const px = SIZE[s.kind ?? "site"] ?? (s.kind === "destination" ? 10 : 9);
      by.set(px, [...(by.get(px) ?? []), s]);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]);
  }, [sites]);

  const labelled = sites.filter((s) => !s.hoverOnly || s.key === hoverKey);
  const anchors: Anchor[] = [
    ...labelled.map((s, i) => ({ key: `site-${s.key ?? s.letter + i}`, pos: latLonToVec3(s.lat, s.lon, MARKER_R) })),
    ...(subsolar && !compact ? [{ key: "sun", pos: latLonToVec3(subsolar.lat, subsolar.lon, GLYPH_R) }] : []),
    ...(subEarth && !compact ? [{ key: "earth", pos: latLonToVec3(subEarth.lat, subEarth.lon, GLYPH_R) }] : []),
    ...(rover && !live ? [{ key: "rover", pos: latLonToVec3(rover.lat, rover.lon, 1.004) }] : []),
  ];
  const showRoverLabel = !!rover || !!live;

  return (
    <div className={`relative h-full w-full overflow-hidden ${picking ? "cursor-crosshair" : hoverKey && sites.find((s) => s.key === hoverKey)?.interactive ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}>
      <Canvas
        camera={{ position: VIEW_POS[view.name], fov: FOV, near: 0.001, far: 100 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
        frameloop={active ? "always" : "never"}
        aria-label="Interactive lunar globe"
      >
        <color attach="background" args={["#0a0b0d"]} />
        <ambientLight intensity={amb} />
        <SunLight live={live} subsolar={subsolar} intensity={subsolar ? 2.6 : 1.2} />
        <Suspense fallback={null}>
          <Moon picking={picking !== null} onPick={onPick} />
        </Suspense>
        <Graticule polar={compact} />
        {paths.map((p) => (
          <PathLine key={p.key} path={p} onHover={setHoverPath} />
        ))}
        {groups.map(([px, list]) => (
          <MarkerLayer key={px} px={px} sites={list} tex={tex} onHover={setHoverKey} onClick={(s) => s.key && onSiteClick?.(s.key)} />
        ))}
        <Rover live={live} fixed={rover} />
        {subsolar && !compact && (
          <mesh position={latLonToVec3(subsolar.lat, subsolar.lon, GLYPH_R)}>
            <sphereGeometry args={[0.022, 16, 16]} />
            <meshBasicMaterial color="#f2b84b" />
          </mesh>
        )}
        {subEarth && !compact && (
          <mesh position={latLonToVec3(subEarth.lat, subEarth.lon, GLYPH_R)}>
            <sphereGeometry args={[0.022, 16, 16]} />
            <meshBasicMaterial color="#6b9cff" />
          </mesh>
        )}
        <OrbitControls
          makeDefault
          enablePan={false}
          minDistance={compact ? 1.03 : 1.6}
          maxDistance={8}
          rotateSpeed={compact ? 0.3 : 0.6}
          zoomSpeed={compact ? 0.7 : 1}
          enableDamping
        />
        <RaycastTuner />
        <CameraRig view={view} focus={focus} follow={follow} live={live} minD={compact ? 1.04 : 1.6} />
        <LabelProjector anchors={anchors} els={labelEls} live={live} />
      </Canvas>

      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {labelled.map((s, i) => {
          const key = `site-${s.key ?? s.letter + i}`;
          return (
            <div key={key} ref={(el) => { labelEls.current[key] = el; }} className="absolute left-0 top-0" style={{ opacity: 0 }}>
              <div className={`ml-2 -translate-y-1/2 whitespace-nowrap rounded border bg-black/75 px-1.5 py-0.5 text-[10.5px] leading-tight ${
                s.kind === "destination" ? "border-danger/50" : s.kind === "visited" ? "border-accent/50" : s.kind === "crewed" || s.kind === "robotic" ? "border-white/20" : "border-white/15"
              }`}>
                {s.letter && <span className="mr-1 font-semibold" style={{ color: COLOR[s.kind ?? "site"] }}>{s.letter}</span>}
                <span className="text-text">{s.label}</span>
                {s.detail && s.key === hoverKey && <span className="block text-[10px] text-muted">{s.detail}</span>}
              </div>
            </div>
          );
        })}
        {subsolar && !compact && (
          <div ref={(el) => { labelEls.current.sun = el; }} className="absolute left-0 top-0" style={{ opacity: 0 }}>
            <div className="ml-2 -translate-y-1/2 whitespace-nowrap text-[10px] uppercase tracking-wider text-sun">Sun dir.</div>
          </div>
        )}
        {subEarth && !compact && (
          <div ref={(el) => { labelEls.current.earth = el; }} className="absolute left-0 top-0" style={{ opacity: 0 }}>
            <div className="ml-2 -translate-y-1/2 whitespace-nowrap text-[10px] uppercase tracking-wider text-earth">Earth dir.</div>
          </div>
        )}
        {showRoverLabel && (
          <div ref={(el) => { labelEls.current.rover = el; }} className="absolute left-0 top-0" style={{ opacity: 0 }}>
            <div className="ml-2 -translate-y-1/2 whitespace-nowrap text-[10px] uppercase tracking-wider text-sun">Rover</div>
          </div>
        )}
      </div>
      {hoverPath?.hover && (
        <div role="status" className="pointer-events-none absolute left-1/2 top-12 -translate-x-1/2 whitespace-pre rounded border border-line-strong bg-black/85 px-2 py-1 font-mono text-[11px] text-text">
          {hoverPath.hover}
        </div>
      )}
    </div>
  );
}
