"use client";

import { useId } from "react";

import { GRID_OPTIONS, type BaseDraft, type PlannerParams } from "@/lib/routeDemo";

const inputCls =
  "w-full min-w-0 rounded-[2px] border border-line bg-field px-2.5 py-1.5 tabular-nums text-[14px] text-text placeholder:text-muted focus:border-text focus:outline-none aria-[invalid=true]:border-danger";
const labelCls = "mb-1 block text-[13px] text-muted";

export function latErr(v: string) {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) return "Latitude must be a number.";
  if (n < -90 || n > 90) return "Latitude must be between −90 and 90.";
  return null;
}
export function lonErr(v: string) {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) return "Longitude must be a number.";
  if (n < -180 || n > 180) return "Longitude must be between −180 and 180 (east positive).";
  return null;
}
export function idErr(v: string) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(v)) return "Code: 1–32 letters, digits, _ or -.";
  return null;
}

function num(v: string, min: number, max: number, name: string, exclusiveMin = false) {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) return `${name} must be a number.`;
  if (exclusiveMin ? n <= min : n < min) return `${name} must be ${exclusiveMin ? "greater than" : "at least"} ${min}.`;
  if (n > max) return `${name} must be at most ${max}.`;
  return null;
}

export function paramErrors(p: PlannerParams): Record<string, string> {
  const e: Record<string, string | null> = {
    departure: Number.isNaN(Date.parse(p.departure + ":00Z")) ? "Enter a valid UTC date and time." : null,
    horizonHours: num(p.horizonHours, 1, 1440, "Horizon (h)"),
    speedKmh: num(p.speedKmh, 0.01, 200, "Speed (km/h)"),
    maxLegKm: num(p.maxLegKm, 0, 4912, "Max leg (km)", true),
    maxWaitHours: num(p.maxWaitHours, 0, Number(p.horizonHours) || 1440, "Max wait (h)"),
    wDistance: num(p.wDistance, 0, 1e6, "Distance weight"),
    wDarkness: num(p.wDarkness, 0, 1e6, "Darkness weight"),
    wEarth: num(p.wEarth, 0, 1e6, "Earth-invisible weight"),
    distanceScaleKm: num(p.distanceScaleKm, 0, 1e5, "Distance scale", true),
    exposureScaleHours: num(p.exposureScaleHours, 0, 1e5, "Exposure scale", true),
  };
  if (!e.wDistance && !e.wDarkness && !e.wEarth && Number(p.wDistance) === 0 && Number(p.wDarkness) === 0 && Number(p.wEarth) === 0) {
    e.weights = "At least one weight must be positive.";
  }
  if (!e.horizonHours && p.gridMinutes > Number(p.horizonHours) * 60) e.gridMinutes = "Grid step must not exceed the horizon.";
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Record<string, string>;
}

function PlaceBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`flex h-[30px] shrink-0 px-2 items-center justify-center rounded-[2px] border text-[13px] ${
        active ? "border-text bg-text text-bg" : "border-line bg-field text-text hover:border-text"
      }`}
    >
      Pick
    </button>
  );
}

export function EndpointCard({
  title, draft, onChange, picking, onTogglePick, children,
}: {
  title: string;
  draft: BaseDraft;
  onChange: (d: BaseDraft) => void;
  picking: boolean;
  onTogglePick: () => void;
  children?: React.ReactNode;
}) {
  const uid = useId();
  const errs = [latErr(draft.lat), lonErr(draft.lon), draft.label.trim() ? null : "Enter a label."].filter(Boolean);
  return (
    <fieldset>
      <legend className="sr-only">{title}</legend>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[18px] leading-[24px] font-bold">{title}</span>
        {children}
      </div>
      <label htmlFor={`${uid}-l`} className={labelCls}>Label</label>
      <input id={`${uid}-l`} className={inputCls} value={draft.label} maxLength={64} onChange={(e) => onChange({ ...draft, label: e.target.value })} />
      <div className="mt-2 flex items-end gap-1.5">
        <div className="flex-1">
          <label htmlFor={`${uid}-lat`} className={labelCls}>Lat (°, +N)</label>
          <input id={`${uid}-lat`} className={inputCls} inputMode="decimal" value={draft.lat} aria-invalid={!!latErr(draft.lat)} onChange={(e) => onChange({ ...draft, lat: e.target.value })} />
        </div>
        <div className="flex-1">
          <label htmlFor={`${uid}-lon`} className={labelCls}>Lon (°, +E)</label>
          <input id={`${uid}-lon`} className={inputCls} inputMode="decimal" value={draft.lon} aria-invalid={!!lonErr(draft.lon)} onChange={(e) => onChange({ ...draft, lon: e.target.value })} />
        </div>
        <PlaceBtn active={picking} onClick={onTogglePick} label={`Place ${title.toLowerCase()} on globe`} />
      </div>
      {errs.map((m) => (
        <p key={m} className="mt-1 text-[13px] text-danger">{m}</p>
      ))}
    </fieldset>
  );
}

export function WaypointList({
  items, onChange, picking, onTogglePick, onReset,
}: {
  items: BaseDraft[];
  onChange: (items: BaseDraft[]) => void;
  picking: string | null;
  onTogglePick: (uid: string) => void;
  onReset: () => void;
}) {
  const update = (uid: string, patch: Partial<BaseDraft>) =>
    onChange(items.map((w) => (w.uid === uid ? { ...w, ...patch, label: patch.id !== undefined ? `Hypothetical waypoint ${patch.id}` : w.label } : w)));
  const add = () => {
    let n = items.length + 1;
    while (items.some((w) => w.id === `P${n}`)) n++;
    const id = `P${n}`;
    onChange([...items, { uid: `wp-${id}-${Date.now()}`, id, label: `Hypothetical waypoint ${id}`, lat: "-88", lon: "0" }]);
  };
  return (
    <fieldset>
      <legend className="sr-only">Candidate waypoints</legend>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[18px] leading-[24px] font-bold">Candidate waypoints</span>
        <span className="tabular-nums text-[13px] text-muted">{items.length} optional</span>
      </div>
      <p className="mb-2 text-[13px] leading-snug text-muted">
        Hypothetical locations, not real bases. The optimizer may use any, all or none of them.
      </p>
      <div className="mb-1 grid grid-cols-[52px_1fr_1fr_auto_auto] gap-1.5 text-[13px] text-muted">
        <span>Code</span>
        <span>Lat °</span>
        <span>Lon °</span>
        <span className="sr-only">Place</span>
        <span className="sr-only">Remove</span>
      </div>
      <ul className="space-y-1.5">
        {items.map((w) => {
          const bad = idErr(w.id) || latErr(w.lat) || lonErr(w.lon);
          return (
            <li key={w.uid}>
              <div className="grid grid-cols-[52px_1fr_1fr_auto_auto] items-center gap-1.5">
                <input aria-label={`Waypoint code`} className={inputCls} value={w.id} maxLength={32} aria-invalid={!!idErr(w.id)} onChange={(e) => update(w.uid, { id: e.target.value })} />
                <input aria-label={`${w.id} latitude`} className={inputCls} inputMode="decimal" value={w.lat} aria-invalid={!!latErr(w.lat)} onChange={(e) => update(w.uid, { lat: e.target.value })} />
                <input aria-label={`${w.id} longitude`} className={inputCls} inputMode="decimal" value={w.lon} aria-invalid={!!lonErr(w.lon)} onChange={(e) => update(w.uid, { lon: e.target.value })} />
                <PlaceBtn active={picking === w.uid} onClick={() => onTogglePick(w.uid)} label={`Place ${w.id} on globe`} />
                <button
                  type="button"
                  onClick={() => onChange(items.filter((x) => x.uid !== w.uid))}
                  aria-label={`Remove ${w.id}`}
                  className="flex h-[30px] items-center justify-center rounded-[2px] text-[14px] text-muted hover:text-danger"
                >
                  Remove
                </button>
              </div>
              {bad && <p className="mt-0.5 text-[13px] text-danger">{bad}</p>}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex gap-1.5">
        <button type="button" onClick={add} className="rounded-[2px] border border-line px-2 py-1 text-[13px] text-muted hover:text-text">
          + Add waypoint
        </button>
        <button type="button" onClick={onReset} className="rounded-[2px] border border-line px-2 py-1 text-[13px] text-muted hover:text-text">
          Reset demo network
        </button>
      </div>
    </fieldset>
  );
}

function Field({ label, value, onChange, err, hint, unit }: { label: string; value: string; onChange: (v: string) => void; err?: string; hint?: string; unit?: string }) {
  const uid = useId();
  return (
    <div>
      <label htmlFor={uid} className={labelCls}>
        {label}
        {unit && <span className="ml-1 normal-case text-muted">({unit})</span>}
      </label>
      <input id={uid} className={inputCls} inputMode="decimal" value={value} aria-invalid={!!err} onChange={(e) => onChange(e.target.value)} />
      {err ? <p className="mt-0.5 text-[13px] text-danger">{err}</p> : hint ? <p className="mt-0.5 text-[13px] leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}

export function ScheduleCard({ p, onChange }: { p: PlannerParams; onChange: (p: PlannerParams) => void }) {
  const uid = useId();
  const e = paramErrors(p);
  const set = (k: keyof PlannerParams) => (v: string) => onChange({ ...p, [k]: v });
  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">Schedule and movement</legend>
      <div className="text-[18px] leading-[24px] font-bold">Schedule &amp; movement</div>
      <div>
        <label htmlFor={`${uid}-dep`} className={labelCls}>Departure (UTC)</label>
        <input id={`${uid}-dep`} type="datetime-local" step={60} className={inputCls} value={p.departure} aria-invalid={!!e.departure} onChange={(ev) => onChange({ ...p, departure: ev.target.value })} />
        <p className={`mt-0.5 text-[13px] ${e.departure ? "text-danger" : "text-muted"}`}>{e.departure ?? "Interpreted as UTC."}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Horizon" unit="h" value={p.horizonHours} onChange={set("horizonHours")} err={e.horizonHours} />
        <Field label="Speed" unit="km/h" value={p.speedKmh} onChange={set("speedKmh")} err={e.speedKmh} />
        <Field label="Max leg" unit="km" value={p.maxLegKm} onChange={set("maxLegKm")} err={e.maxLegKm} />
        <Field label="Max wait / stop" unit="h" value={p.maxWaitHours} onChange={set("maxWaitHours")} err={e.maxWaitHours} />
      </div>
      <div>
        <label htmlFor={`${uid}-grid`} className={labelCls}>Time grid</label>
        <select id={`${uid}-grid`} className={inputCls} value={p.gridMinutes} onChange={(ev) => onChange({ ...p, gridMinutes: Number(ev.target.value) })}>
          {GRID_OPTIONS.map((m) => (
            <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>
          ))}
        </select>
        <p className={`mt-0.5 text-[13px] leading-snug ${e.gridMinutes ? "text-danger" : "text-muted"}`}>
          {e.gridMinutes ??
            "Departures in the graph search fall on this grid. Arrival at a stop is rounded up to the next grid time; that alignment wait counts toward the per-stop waiting limit."}
        </p>
      </div>
    </fieldset>
  );
}

export function ObjectiveCard({ p, onChange }: { p: PlannerParams; onChange: (p: PlannerParams) => void }) {
  const uid = useId();
  const e = paramErrors(p);
  const set = (k: keyof PlannerParams) => (v: string) => onChange({ ...p, [k]: v });
  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">Objective</legend>
      <div className="text-[18px] leading-[24px] font-bold">Objective weights</div>
      <p className="tabular-nums text-[13px] leading-snug text-muted">
        cost = distance weight × km / {p.distanceScaleKm || "?"} + darkness weight × dark hours / {p.exposureScaleHours || "?"} + Earth-gap weight × hours without Earth / {p.exposureScaleHours || "?"}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Distance" value={p.wDistance} onChange={set("wDistance")} err={e.wDistance} />
        <Field label="Darkness" value={p.wDarkness} onChange={set("wDarkness")} err={e.wDarkness} />
        <Field label="Earth gap" value={p.wEarth} onChange={set("wEarth")} err={e.wEarth} />
      </div>
      {e.weights && <p className="text-[13px] text-danger">{e.weights}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Distance scale" unit="km" value={p.distanceScaleKm} onChange={set("distanceScaleKm")} err={e.distanceScaleKm} />
        <Field label="Exposure scale" unit="h" value={p.exposureScaleHours} onChange={set("exposureScaleHours")} err={e.exposureScaleHours} />
      </div>
      <p className="text-[13px] leading-snug text-muted">Fixed scales shared by every candidate route and the baseline, so costs are directly comparable.</p>
      <details className="border-t border-line pt-2">
        <summary className="cursor-pointer text-[13px] text-muted hover:text-text">Advanced</summary>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="checkbox" checked={p.localSearch} onChange={(ev) => onChange({ ...p, localSearch: ev.target.checked })} className="accent-[var(--color-text)]" />
          Continuous-time local refinement
        </label>
        <div className="mt-2 space-y-1.5 text-[13px]" role="radiogroup" aria-label="Data source">
          {(
            [
              ["spice", "NASA NAIF SPICE (DE440)", "Scientific Sun/Earth geometry."],
              ["synthetic", "Synthetic demo data", "Analytic approximation for UI development. Not scientific."],
            ] as const
          ).map(([m, title, desc]) => (
            <label key={m} className="flex cursor-pointer gap-2">
              <input type="radio" name={`${uid}-mode`} className="mt-0.5 accent-[var(--color-text)]" checked={p.mode === m} onChange={() => onChange({ ...p, mode: m })} />
              <span>
                <span className={m === "synthetic" ? "font-bold text-text" : "text-text"}>{title}</span>
                <span className="block text-[13px] text-muted">{desc}</span>
              </span>
            </label>
          ))}
        </div>
      </details>
    </fieldset>
  );
}
