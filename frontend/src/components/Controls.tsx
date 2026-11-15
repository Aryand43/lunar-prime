"use client";

import { useId } from "react";

import { PRESETS } from "@/lib/sites";
import type { Mode } from "@/lib/types";

export interface SiteDraft {
  presetKey: string; // preset key or "custom"
  label: string;
  lat: string;
  lon: string;
}

export interface WindowDraft {
  start: string; // "YYYY-MM-DDTHH:mm", interpreted as UTC
  durationDays: string;
  stepMinutes: number;
  mode: Mode;
}

export const STEP_OPTIONS = [1, 5, 10, 15, 30, 60, 120, 360, 720];
export const DURATION_CHIPS: [string, number][] = [
  ["1 d", 1],
  ["14 d", 14],
  ["Synodic month", 29.53],
  ["90 d", 90],
  ["1 yr", 365],
];

export function siteErrors(s: SiteDraft): { label?: string; lat?: string; lon?: string } {
  const e: { label?: string; lat?: string; lon?: string } = {};
  if (!s.label.trim()) e.label = "Enter a label.";
  else if (s.label.trim().length > 64) e.label = "64 characters max.";
  const lat = Number(s.lat);
  if (s.lat.trim() === "" || !Number.isFinite(lat)) e.lat = "Enter a number.";
  else if (lat < -90 || lat > 90) e.lat = "Latitude must be between −90 and 90.";
  const lon = Number(s.lon);
  if (s.lon.trim() === "" || !Number.isFinite(lon)) e.lon = "Enter a number.";
  else if (lon < -180 || lon > 180) e.lon = "Longitude must be between −180 and 180 (east positive).";
  return e;
}

export function sampleCount(w: WindowDraft): number | null {
  const d = Number(w.durationDays);
  if (!Number.isFinite(d) || d <= 0) return null;
  const minutes = d * 1440;
  return Math.floor(minutes / w.stepMinutes + 1e-9) + 1 + (minutes % w.stepMinutes > 1e-6 ? 1 : 0);
}

export function windowErrors(w: WindowDraft, maxSamples: number, coverage?: [string | null, string | null]) {
  const e: { start?: string; duration?: string; samples?: string } = {};
  const t = Date.parse(w.start + ":00Z");
  if (!w.start || Number.isNaN(t)) e.start = "Enter a valid UTC date and time.";
  else if (coverage?.[0] && coverage?.[1]) {
    const d = Number(w.durationDays);
    if (t < Date.parse(coverage[0]) || t + d * 86400e3 > Date.parse(coverage[1])) {
      e.start = `Window must lie within kernel coverage (${coverage[0].slice(0, 10)} to ${coverage[1].slice(0, 10)}).`;
    }
  }
  const d = Number(w.durationDays);
  if (!Number.isFinite(d) || d * 24 < 1) e.duration = "Duration must be at least 1 hour (0.042 d).";
  else if (d > 366) e.duration = "Duration must be 366 days or less.";
  else if (w.stepMinutes > d * 1440) e.duration = "Duration must be at least one sampling step.";
  const n = sampleCount(w);
  if (n !== null && n > maxSamples) e.samples = `${n.toLocaleString()} samples exceeds the ${maxSamples.toLocaleString()} limit. Use a coarser step or a shorter window.`;
  return e;
}

const inputCls =
  "w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[13px] text-text placeholder:text-faint focus:border-accent focus:outline-none aria-[invalid=true]:border-danger";
const labelCls = "mb-1 block text-[11px] uppercase tracking-wider text-muted";

function FieldError({ id, msg }: { id: string; msg?: string }) {
  if (!msg) return null;
  return (
    <p id={id} className="mt-1 text-[11px] text-danger">
      {msg}
    </p>
  );
}

export function SiteCard({
  letter, draft, onChange, picking, onTogglePick,
}: {
  letter: "A" | "B";
  draft: SiteDraft;
  onChange: (d: SiteDraft) => void;
  picking: boolean;
  onTogglePick: () => void;
}) {
  const uid = useId();
  const err = siteErrors(draft);
  const preset = PRESETS.find((p) => p.key === draft.presetKey);
  const set = (patch: Partial<SiteDraft>) => onChange({ ...draft, ...patch, presetKey: patch.presetKey ?? "custom" });

  return (
    <fieldset className="rounded-md border border-line bg-panel p-3">
      <legend className="sr-only">Site {letter}</legend>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="flex h-5 w-5 items-center justify-center rounded-sm border border-line-strong text-[11px] font-semibold">{letter}</span>
          Site {letter}
        </span>
        <button
          type="button"
          onClick={onTogglePick}
          aria-pressed={picking}
          className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
            picking ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-text"
          }`}
        >
          {picking ? "Click the globe…" : "Place on globe"}
        </button>
      </div>

      <label htmlFor={`${uid}-preset`} className={labelCls}>Preset</label>
      <select
        id={`${uid}-preset`}
        className={inputCls + " font-sans"}
        value={draft.presetKey}
        onChange={(e) => {
          const p = PRESETS.find((x) => x.key === e.target.value);
          if (p) onChange({ presetKey: p.key, label: p.label, lat: String(p.lat), lon: String(p.lon) });
          else onChange({ ...draft, presetKey: "custom" });
        }}
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>{p.label}</option>
        ))}
        <option value="custom">Custom coordinates</option>
      </select>
      {preset && <p className="mt-1 text-[11px] leading-snug text-faint">{preset.note}</p>}

      <label htmlFor={`${uid}-label`} className={labelCls + " mt-2.5"}>Label</label>
      <input
        id={`${uid}-label`}
        className={inputCls + " font-sans"}
        value={draft.label}
        maxLength={64}
        aria-invalid={!!err.label}
        aria-describedby={err.label ? `${uid}-label-err` : undefined}
        onChange={(e) => set({ label: e.target.value })}
      />
      <FieldError id={`${uid}-label-err`} msg={err.label} />

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${uid}-lat`} className={labelCls}>Lat (°, +N)</label>
          <input
            id={`${uid}-lat`}
            className={inputCls}
            inputMode="decimal"
            value={draft.lat}
            aria-invalid={!!err.lat}
            aria-describedby={err.lat ? `${uid}-lat-err` : undefined}
            onChange={(e) => set({ lat: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${uid}-lon`} className={labelCls}>Lon (°, +E)</label>
          <input
            id={`${uid}-lon`}
            className={inputCls}
            inputMode="decimal"
            value={draft.lon}
            aria-invalid={!!err.lon}
            aria-describedby={err.lon ? `${uid}-lon-err` : undefined}
            onChange={(e) => set({ lon: e.target.value })}
          />
        </div>
      </div>
      <FieldError id={`${uid}-lat-err`} msg={err.lat} />
      <FieldError id={`${uid}-lon-err`} msg={err.lon} />
    </fieldset>
  );
}

export function WindowCard({
  draft, onChange, maxSamples, coverage,
}: {
  draft: WindowDraft;
  onChange: (d: WindowDraft) => void;
  maxSamples: number;
  coverage?: [string | null, string | null];
}) {
  const uid = useId();
  const err = windowErrors(draft, maxSamples, coverage);
  const n = sampleCount(draft);
  return (
    <fieldset className="rounded-md border border-line bg-panel p-3">
      <legend className="sr-only">Simulation window</legend>
      <div className="mb-2.5 text-sm font-medium">Window</div>

      <label htmlFor={`${uid}-start`} className={labelCls}>Start (UTC)</label>
      <input
        id={`${uid}-start`}
        type="datetime-local"
        className={inputCls}
        value={draft.start}
        step={60}
        aria-invalid={!!err.start}
        aria-describedby={`${uid}-start-hint`}
        onChange={(e) => onChange({ ...draft, start: e.target.value })}
      />
      <p id={`${uid}-start-hint`} className={`mt-1 text-[11px] ${err.start ? "text-danger" : "text-faint"}`}>
        {err.start ?? "Interpreted as UTC, not your local time zone."}
      </p>

      <label htmlFor={`${uid}-dur`} className={labelCls + " mt-2.5"}>Duration (days)</label>
      <input
        id={`${uid}-dur`}
        className={inputCls}
        inputMode="decimal"
        value={draft.durationDays}
        aria-invalid={!!err.duration}
        aria-describedby={err.duration ? `${uid}-dur-err` : undefined}
        onChange={(e) => onChange({ ...draft, durationDays: e.target.value })}
      />
      <div className="mt-1.5 flex flex-wrap gap-1">
        {DURATION_CHIPS.map(([label, d]) => (
          <button
            key={label}
            type="button"
            onClick={() => onChange({ ...draft, durationDays: String(d) })}
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              Number(draft.durationDays) === d ? "border-accent text-accent" : "border-line text-muted hover:text-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <FieldError id={`${uid}-dur-err`} msg={err.duration} />

      <label htmlFor={`${uid}-step`} className={labelCls + " mt-2.5"}>Sampling interval</label>
      <select
        id={`${uid}-step`}
        className={inputCls}
        value={draft.stepMinutes}
        onChange={(e) => onChange({ ...draft, stepMinutes: Number(e.target.value) })}
      >
        {STEP_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {m < 60 ? `${m} min` : `${m / 60} h`}
          </option>
        ))}
      </select>
      <p className={`mt-1 font-mono text-[11px] ${err.samples ? "text-danger" : "text-faint"}`}>
        {err.samples ?? (n ? `${n.toLocaleString()} samples / site · limit ${maxSamples.toLocaleString()}` : "—")}
      </p>

      <details className="mt-3 border-t border-line pt-2">
        <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-muted hover:text-text">Data source</summary>
        <div className="mt-2 space-y-1.5 text-[12px]" role="radiogroup" aria-label="Data source">
          {(
            [
              ["spice", "NASA NAIF SPICE (DE440)", "Scientific computation from official kernels."],
              ["synthetic", "Synthetic demo data", "Analytic approximation for UI development. Not scientific, not NASA data."],
            ] as [Mode, string, string][]
          ).map(([m, title, desc]) => (
            <label key={m} className="flex cursor-pointer gap-2">
              <input
                type="radio"
                name={`${uid}-mode`}
                className="mt-0.5 accent-[var(--color-accent)]"
                checked={draft.mode === m}
                onChange={() => onChange({ ...draft, mode: m })}
              />
              <span>
                <span className={m === "synthetic" ? "text-sun" : "text-text"}>{title}</span>
                <span className="block text-[11px] text-faint">{desc}</span>
              </span>
            </label>
          ))}
        </div>
      </details>
    </fieldset>
  );
}
