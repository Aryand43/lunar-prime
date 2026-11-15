"use client";

import { useId } from "react";

import { PRESET_GROUPS, PRESETS } from "@/lib/sites";
import type { Mode } from "@/lib/types";

export interface SiteDraft {
  presetKey: string; // preset key or "custom"
  label: string;
  lat: string;
  lon: string;
}

export interface WindowDraft {
  start: string; // "YYYY-MM-DDTHH:mm", interpreted as UTC
  startB: string | null; // site B's own start (same format), or null when B uses the shared start
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

function startError(start: string, durationDays: string, coverage?: [string | null, string | null]): string | undefined {
  const t = Date.parse(start + ":00Z");
  if (!start || Number.isNaN(t)) return "Enter a valid UTC date and time.";
  if (coverage?.[0] && coverage?.[1]) {
    const d = Number(durationDays);
    if (t < Date.parse(coverage[0]) || t + d * 86400e3 > Date.parse(coverage[1])) {
      return `Window must lie within kernel coverage (${coverage[0].slice(0, 10)} to ${coverage[1].slice(0, 10)}).`;
    }
  }
  return undefined;
}

export function windowErrors(w: WindowDraft, maxSamples: number, coverage?: [string | null, string | null]) {
  const e: { start?: string; startB?: string; duration?: string; samples?: string } = {};
  e.start = startError(w.start, w.durationDays, coverage);
  if (w.startB !== null) e.startB = startError(w.startB, w.durationDays, coverage);
  const d = Number(w.durationDays);
  if (!Number.isFinite(d) || d * 24 < 1) e.duration = "Duration must be at least 1 hour (0.042 d).";
  else if (d > 366) e.duration = "Duration must be 366 days or less.";
  else if (w.stepMinutes > d * 1440) e.duration = "Duration must be at least one sampling step.";
  const n = sampleCount(w);
  if (n !== null && n > maxSamples) e.samples = `${n.toLocaleString()} samples exceeds the ${maxSamples.toLocaleString()} limit. Use a coarser step or a shorter window.`;
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as typeof e;
}

const inputCls =
  "w-full rounded-[2px] border border-line bg-field px-3 py-2 tabular-nums text-[14px] text-text placeholder:text-muted focus:border-text focus:outline-none aria-[invalid=true]:border-danger";
const labelCls = "mb-1.5 block text-[13px] text-muted";

function FieldError({ id, msg }: { id: string; msg?: string }) {
  if (!msg) return null;
  return (
    <p id={id} className="mt-1 text-[13px] text-danger">
      {msg}
    </p>
  );
}

export function SiteCard({
  letter, draft, onChange, picking, onTogglePick, onSameAsA,
}: {
  letter: "A" | "B";
  draft: SiteDraft;
  onChange: (d: SiteDraft) => void;
  picking: boolean;
  onTogglePick: () => void;
  /** Site B only: copy site A's label and coordinates. */
  onSameAsA?: () => void;
}) {
  const uid = useId();
  const err = siteErrors(draft);
  const preset = PRESETS.find((p) => p.key === draft.presetKey);
  const set = (patch: Partial<SiteDraft>) => onChange({ ...draft, ...patch, presetKey: patch.presetKey ?? "custom" });

  return (
    <fieldset>
      <legend className="sr-only">Site {letter}</legend>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2.5 text-[18px] leading-[24px] font-bold">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-text text-[13px] font-bold text-bg">{letter}</span>
          Site {letter}
        </span>
        <button
          type="button"
          onClick={onTogglePick}
          aria-pressed={picking}
          className={`rounded-[2px] border px-2 py-0.5 text-[13px] transition-colors ${
            picking ? "border-text bg-text text-bg" : "border-line bg-field text-text hover:border-text"
          }`}
        >
          {picking ? `Click the Moon to place site ${letter}` : "Pick on globe"}
        </button>
      </div>

      <label htmlFor={`${uid}-preset`} className={labelCls}>Preset</label>
      <select
        id={`${uid}-preset`}
        className={inputCls}
        value={draft.presetKey}
        onChange={(e) => {
          const p = PRESETS.find((x) => x.key === e.target.value);
          if (p) onChange({ presetKey: p.key, label: p.label, lat: String(p.lat), lon: String(p.lon) });
          else onChange({ ...draft, presetKey: "custom" });
        }}
      >
        {PRESET_GROUPS.map((g) => (
          <optgroup key={g} label={g}>
            {PRESETS.filter((p) => p.group === g).map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </optgroup>
        ))}
        <option value="custom">Custom coordinates</option>
      </select>
      {preset && <p className="mt-1.5 text-[13px] leading-[18px] text-muted">{preset.note}</p>}

      <label htmlFor={`${uid}-label`} className={labelCls + " mt-4"}>Label</label>
      <input
        id={`${uid}-label`}
        className={inputCls}
        value={draft.label}
        maxLength={64}
        aria-invalid={!!err.label}
        aria-describedby={err.label ? `${uid}-label-err` : undefined}
        onChange={(e) => set({ label: e.target.value })}
      />
      <FieldError id={`${uid}-label-err`} msg={err.label} />

      <div className="mt-4 grid grid-cols-2 gap-3">
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
      {onSameAsA && (
        <button
          type="button"
          onClick={onSameAsA}
          className="mt-3 rounded-[2px] border border-line bg-field px-2 py-1 text-[13px] text-text hover:border-text"
        >
          Same place as A
        </button>
      )}
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
    <fieldset>
      <legend className="sr-only">Simulation window</legend>
      <div className="mb-3 text-[18px] leading-[24px] font-bold">Window</div>

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
      <p id={`${uid}-start-hint`} className={`mt-1 text-[13px] ${err.start ? "text-danger" : "text-muted"}`}>
        {err.start ?? "Interpreted as UTC, not your local time zone."}
      </p>

      <label className="mt-3 flex cursor-pointer items-start gap-2 text-[14px] text-text">
        <input
          type="checkbox"
          className="mt-[3px] accent-[var(--color-text)]"
          checked={draft.startB !== null}
          onChange={(e) => onChange({ ...draft, startB: e.target.checked ? draft.start : null })}
        />
        Site B starts on a different date
      </label>
      {draft.startB !== null && (
        <>
          <label htmlFor={`${uid}-startB`} className={labelCls + " mt-3"}>Start for site B (UTC)</label>
          <input
            id={`${uid}-startB`}
            type="datetime-local"
            className={inputCls}
            value={draft.startB}
            step={60}
            aria-invalid={!!err.startB}
            aria-describedby={`${uid}-startB-hint`}
            onChange={(e) => onChange({ ...draft, startB: e.target.value })}
          />
          <p id={`${uid}-startB-hint`} className={`mt-1 text-[13px] ${err.startB ? "text-danger" : "text-muted"}`}>
            {err.startB ?? "Same duration and sampling as site A. Site B may be the same place as A."}
          </p>
        </>
      )}

      <label htmlFor={`${uid}-dur`} className={labelCls + " mt-4"}>Duration (days)</label>
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
            className={`rounded-[2px] border px-2 py-1 text-[13px] ${
              Number(draft.durationDays) === d ? "border-text bg-text text-bg" : "border-line bg-field text-text hover:border-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <FieldError id={`${uid}-dur-err`} msg={err.duration} />

      <label htmlFor={`${uid}-step`} className={labelCls + " mt-4"}>Sampling interval</label>
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
      <p className={`mt-1 tabular-nums text-[13px] ${err.samples ? "text-danger" : "text-muted"}`}>
        {err.samples ?? (n ? `${n.toLocaleString()} samples per site (limit ${maxSamples.toLocaleString()})` : "—")}
      </p>

      <details className="mt-3 border-t border-line pt-2">
        <summary className="cursor-pointer text-[13px] text-muted hover:text-text">Data source</summary>
        <div className="mt-2 space-y-1.5 text-[13px]" role="radiogroup" aria-label="Data source">
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
                className="mt-0.5 accent-[var(--color-text)]"
                checked={draft.mode === m}
                onChange={() => onChange({ ...draft, mode: m })}
              />
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
