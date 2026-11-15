"use client";

import { OrbitControls, useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { latLonToVec3, vec3ToLatLon } from "@/lib/geo";

export interface GlobeSite {
  letter: "A" | "B";
  label: string;
  lat: number;
  lon: number;
}

export type GlobeView = "near" | "far" | "south" | "north";

interface Props {
  sites: GlobeSite[];
  subsolar: { lat: number; lon: number } | null;
  subEarth: { lat: number; lon: number } | null;
  picking: "A" | "B" | null;
  onPick: (lat: number, lon: number) => void;
  view: { name: GlobeView; nonce: number };
}

type Vec3 = [number, number, number];

interface Anchor {
  key: string;
  pos: Vec3;
  kind: "site" | "sun" | "earth";
  letter?: string;
  text: string;
}

const VIEW_POS: Record<GlobeView, Vec3> = {
  near: [3.9, 0.5, 0.0],
  far: [-3.9, 0.5, 0.0],
  south: [0.5, -3.9, 0.15],
  north: [0.5, 3.9, 0.15],
};

const MARKER_R = 1.05;
const GLYPH_R = 1.28;

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
      <sphereGeometry args={[1, 160, 80]} />
      <meshStandardMaterial map={color} bumpMap={bump} bumpScale={3} roughness={1} metalness={0} />
    </mesh>
  );
}

function Graticule() {
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
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial color="#9aa3ad" transparent opacity={0.1} depthWrite={false} />
    </lineSegments>
  );
}

function SiteMarker({ lat, lon }: { lat: number; lon: number }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([...latLonToVec3(lat, lon, 1.0), ...latLonToVec3(lat, lon, MARKER_R)], 3));
    return g;
  }, [lat, lon]);
  return (
    <group>
      <lineSegments geometry={geom}>
        <lineBasicMaterial color="#ffffff" />
      </lineSegments>
      <mesh position={latLonToVec3(lat, lon, MARKER_R)}>
        <sphereGeometry args={[0.012, 16, 16]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
    </group>
  );
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

export default function MoonGlobe({ sites, subsolar, subEarth, picking, onPick, view }: Props) {
  const labelEls = useRef<Record<string, HTMLDivElement | null>>({});
  const sunPos: Vec3 = subsolar ? latLonToVec3(subsolar.lat, subsolar.lon, 10) : [5, 2, 5];

  const anchors: Anchor[] = [
    ...sites.map((s) => ({ key: `site-${s.letter}`, pos: latLonToVec3(s.lat, s.lon, MARKER_R), kind: "site" as const, letter: s.letter, text: s.label })),
    ...(subsolar ? [{ key: "sun", pos: latLonToVec3(subsolar.lat, subsolar.lon, GLYPH_R), kind: "sun" as const, text: "Sun dir." }] : []),
    ...(subEarth ? [{ key: "earth", pos: latLonToVec3(subEarth.lat, subEarth.lon, GLYPH_R), kind: "earth" as const, text: "Earth dir." }] : []),
  ];

  return (
    <div className={`relative h-full w-full overflow-hidden ${picking ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}>
      <Canvas camera={{ position: VIEW_POS.near, fov: 34, near: 0.1, far: 100 }} dpr={[1, 2]} gl={{ antialias: true }} aria-label="Interactive lunar globe">
        <color attach="background" args={["#0a0b0d"]} />
        <ambientLight intensity={subsolar ? 0.05 : 0.6} />
        <directionalLight position={sunPos} intensity={subsolar ? 2.6 : 1.2} />
        <Suspense fallback={null}>
          <Moon picking={picking !== null} onPick={onPick} />
        </Suspense>
        <Graticule />
        {sites.map((s) => (
          <SiteMarker key={s.letter} lat={s.lat} lon={s.lon} />
        ))}
        {subsolar && (
          <mesh position={latLonToVec3(subsolar.lat, subsolar.lon, GLYPH_R)}>
            <sphereGeometry args={[0.022, 16, 16]} />
            <meshBasicMaterial color="#f2b84b" />
          </mesh>
        )}
        {subEarth && (
          <mesh position={latLonToVec3(subEarth.lat, subEarth.lon, GLYPH_R)}>
            <sphereGeometry args={[0.022, 16, 16]} />
            <meshBasicMaterial color="#6b9cff" />
          </mesh>
        )}
        <OrbitControls makeDefault enablePan={false} minDistance={1.6} maxDistance={8} rotateSpeed={0.6} enableDamping />
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
            {a.kind === "site" ? (
              <div className="ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-white/15 bg-black/70 px-1.5 py-0.5 text-[11px] leading-tight text-text">
                <span className="mr-1 font-semibold">{a.letter}</span>
                <span className="text-muted">{a.text}</span>
              </div>
            ) : (
              <div className="ml-2 -translate-y-1/2 whitespace-nowrap text-[10px] uppercase tracking-wider" style={{ color: a.kind === "sun" ? "#f2b84b" : "#6b9cff" }}>
                {a.text}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
