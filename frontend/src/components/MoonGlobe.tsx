"use client";

import { OrbitControls, useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { latLonToVec3, vec3ToLatLon } from "@/lib/geo";

export type MarkerKind = "site" | "start" | "visited" | "candidate" | "destination";

export interface GlobeSite {
  /** Short tag shown in bold on the label (e.g. "A", "1", "S"). */
  letter: string;
  label: string;
  lat: number;
  lon: number;
  kind?: MarkerKind;
  key?: string;
}

export interface GlobePath {
  key: string;
  /** three.js world coordinates (use greatCircleArc from lib/geo). */
  points: [number, number, number][];
  color: string;
  dashed?: boolean;
  opacity?: number;
}

export type GlobeView = "near" | "far" | "south" | "north" | "polar";

interface Props {
  sites: GlobeSite[];
  subsolar: { lat: number; lon: number } | null;
  subEarth: { lat: number; lon: number } | null;
  picking: string | null;
  onPick: (lat: number, lon: number) => void;
  view: { name: GlobeView; nonce: number };
  paths?: GlobePath[];
  rover?: { lat: number; lon: number } | null;
  /** Close-up mode for small regions (smaller markers, closer zoom limit). */
  compact?: boolean;
  /** Extra ambient light (illustrative shading only). */
  ambient?: number;
  /** Pause rendering when the globe is hidden (e.g. inactive tab). */
  active?: boolean;
}

type Vec3 = [number, number, number];

interface Anchor {
  key: string;
  pos: Vec3;
  kind: MarkerKind | "sun" | "earth" | "rover";
  letter?: string;
  text: string;
}

const VIEW_POS: Record<GlobeView, Vec3> = {
  near: [3.9, 0.5, 0.0],
  far: [-3.9, 0.5, 0.0],
  south: [0.5, -3.9, 0.15],
  north: [0.5, 3.9, 0.15],
  polar: [0.004, -1.36, 0.0], // just off the pole axis so "up" on screen points toward 0 deg E
};

const GLYPH_R = 1.28;
const MARKER_COLOR: Record<MarkerKind, string> = {
  site: "#ffffff",
  start: "#ffffff",
  visited: "#5ec4b6",
  candidate: "#8b919b",
  destination: "#f07167",
};

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

/**
 * Projects label anchors to screen space every frame and moves plain DOM nodes that
 * live outside the canvas. (Avoids drei <Html>, which mounts nested React roots.)
 */
function LabelProjector({ anchors, els }: { anchors: Anchor[]; els: React.RefObject<Record<string, HTMLDivElement | null>> }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const a of anchors) {
      const el = els.current[a.key];
      if (!el) continue;
      v.set(a.pos[0], a.pos[1], a.pos[2]).project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      el.style.setProperty("transform", `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`);
      el.style.setProperty("opacity", occludedBySphere(camera.position, a.pos) || v.z > 1 ? "0" : "1");
    }
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
    if (!picking || e.delta > 4) return; // ignore drags
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
    for (let lat = -60; lat <= 60; lat += 30) {
      for (let lon = -180; lon < 180; lon += 3) push(latLonToVec3(lat, lon, r), latLonToVec3(lat, lon + 3, r));
    }
    for (let lon = -180; lon < 180; lon += 30) {
      for (let lat = -87; lat < 87; lat += 3) push(latLonToVec3(lat, lon, r), latLonToVec3(lat + 3, lon, r));
    }
    if (polar) {
      // 1-degree latitude rings and 30-degree meridians close to both poles
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
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial color="#9aa3ad" transparent opacity={polar ? 0.16 : 0.1} depthWrite={false} />
    </lineSegments>
  );
}

function SiteMarker({ site, compact }: { site: GlobeSite; compact: boolean }) {
  const stemR = compact ? 1.006 : 1.05;
  const size = compact ? (site.kind === "destination" ? 0.0035 : 0.0024) : 0.012;
  const color = MARKER_COLOR[site.kind ?? "site"];
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([...latLonToVec3(site.lat, site.lon, 1.0), ...latLonToVec3(site.lat, site.lon, stemR)], 3));
    return g;
  }, [site.lat, site.lon, stemR]);
  return (
    <group>
      <lineSegments geometry={geom}>
        <lineBasicMaterial color={color} />
      </lineSegments>
      <mesh position={latLonToVec3(site.lat, site.lon, stemR)}>
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

function PathLine({ path }: { path: GlobePath }) {
  const line = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(path.points.map((p) => new THREE.Vector3(...p)));
    const m = path.dashed
      ? new THREE.LineDashedMaterial({ color: path.color, dashSize: 0.004, gapSize: 0.003, transparent: true, opacity: path.opacity ?? 1 })
      : new THREE.LineBasicMaterial({ color: path.color, transparent: true, opacity: path.opacity ?? 1 });
    const l = new THREE.Line(g, m);
    if (path.dashed) l.computeLineDistances();
    return l;
  }, [path]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );
  return <primitive object={line} />;
}

function CameraRig({ view }: { view: Props["view"] }) {
  const { camera, controls } = useThree();
  useEffect(() => {
    camera.position.set(...VIEW_POS[view.name]);
    camera.lookAt(0, 0, 0);
    (controls as unknown as OrbitControlsImpl | null)?.update();
  }, [view, camera, controls]);
  return null;
}

export default function MoonGlobe({
  sites, subsolar, subEarth, picking, onPick, view, paths = [], rover = null, compact = false, ambient, active = true,
}: Props) {
  const labelEls = useRef<Record<string, HTMLDivElement | null>>({});
  const sunPos: Vec3 = subsolar ? latLonToVec3(subsolar.lat, subsolar.lon, 10) : [5, 2, 5];
  const stemR = compact ? 1.006 : 1.05;
  const amb = ambient ?? (subsolar ? 0.05 : 0.6);

  const anchors: Anchor[] = [
    ...sites.map((s, i) => ({
      key: `site-${s.key ?? s.letter + i}`,
      pos: latLonToVec3(s.lat, s.lon, stemR),
      kind: s.kind ?? ("site" as const),
      letter: s.letter,
      text: s.label,
    })),
    ...(subsolar && !compact ? [{ key: "sun", pos: latLonToVec3(subsolar.lat, subsolar.lon, GLYPH_R), kind: "sun" as const, text: "Sun dir." }] : []),
    ...(subEarth && !compact ? [{ key: "earth", pos: latLonToVec3(subEarth.lat, subEarth.lon, GLYPH_R), kind: "earth" as const, text: "Earth dir." }] : []),
    ...(rover ? [{ key: "rover", pos: latLonToVec3(rover.lat, rover.lon, 1.004), kind: "rover" as const, text: "Traverse" }] : []),
  ];

  return (
    <div className={`relative h-full w-full overflow-hidden ${picking ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}>
      <Canvas
        camera={{ position: VIEW_POS[view.name], fov: 34, near: 0.01, far: 100 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
        frameloop={active ? "always" : "never"}
        aria-label="Interactive lunar globe"
      >
        <color attach="background" args={["#0a0b0d"]} />
        <ambientLight intensity={amb} />
        <directionalLight position={sunPos} intensity={subsolar ? 2.6 : 1.2} />
        <Suspense fallback={null}>
          <Moon picking={picking !== null} onPick={onPick} />
        </Suspense>
        <Graticule polar={compact} />
        {sites.map((s, i) => (
          <SiteMarker key={s.key ?? s.letter + i} site={s} compact={compact} />
        ))}
        {paths.map((p) => (
          <PathLine key={p.key} path={p} />
        ))}
        {rover && (
          <mesh position={latLonToVec3(rover.lat, rover.lon, 1.004)}>
            <sphereGeometry args={[compact ? 0.003 : 0.012, 20, 20]} />
            <meshBasicMaterial color="#f2b84b" />
          </mesh>
        )}
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
          rotateSpeed={compact ? 0.25 : 0.6}
          zoomSpeed={compact ? 0.6 : 1}
          enableDamping
        />
        <CameraRig view={view} />
        <LabelProjector anchors={anchors} els={labelEls} />
      </Canvas>

      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {anchors.map((a) => (
          <div
            key={a.key}
            ref={(el) => {
              labelEls.current[a.key] = el;
            }}
            className="absolute left-0 top-0 transition-opacity duration-100"
            style={{ opacity: 0 }}
          >
            {a.kind === "sun" || a.kind === "earth" ? (
              <div className="ml-2 -translate-y-1/2 whitespace-nowrap text-[10px] uppercase tracking-wider" style={{ color: a.kind === "sun" ? "#f2b84b" : "#6b9cff" }}>
                {a.text}
              </div>
            ) : a.kind === "rover" ? (
              <div className="ml-2 -translate-y-1/2 whitespace-nowrap text-[10px] uppercase tracking-wider text-sun">{a.text}</div>
            ) : (
              <div
                className={`ml-2 -translate-y-1/2 whitespace-nowrap rounded border bg-black/70 px-1.5 py-0.5 leading-tight ${
                  compact ? "text-[10px]" : "text-[11px]"
                } ${a.kind === "candidate" ? "border-white/10 text-faint" : a.kind === "destination" ? "border-danger/50 text-text" : a.kind === "visited" ? "border-accent/50 text-text" : "border-white/15 text-text"}`}
              >
                <span className="mr-1 font-semibold">{a.letter}</span>
                <span className={a.kind === "candidate" ? "text-faint" : "text-muted"}>{a.text}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
