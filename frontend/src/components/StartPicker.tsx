"use client";

import { useId, useMemo, useState } from "react";

import { fmtLatLon, magString, parseAngle, parsePair, type LatLon } from "@/lib/coords";
import { CATEGORY_COLOR, CATEGORY_LABEL, type Site } from "@/lib/siteTypes";

const inputCls =
  "w-full min-w-0 rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[12px] text-text placeholder:text-faint focus:border-accent focus:outline-none aria-[invalid=true]:border-danger";

export interface StartValue extends LatLon {
  label: string;
  siteId?: string;
}

function HemToggle({ options, value, onChange, label }: { options: [string, string]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 overflow-hidden rounded border border-line">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(o)}
          className={`w-7 py-1.5 font-mono text-[12px] ${value === o ? "bg-accent/15 text-accent" : "text-muted hover:text-text"}`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/**
 * Typed entry. Remounted (via `key`) whenever the value changes from outside (globe pick, site, paste),
 * so the fields always show the current value while typing never fights the parent.
 */
function CoordFields({ value, onChange }: { value: LatLon; onChange: (v: LatLon) => void }) {
  const uid = useId();
  const [lat, setLat] = useState(magString(value.lat));
  const [latH, setLatH] = useState(value.lat < 0 ? "S" : "N");
  const [lon, setLon] = useState(magString(value.lon));
  const [lonH, setLonH] = useState(value.lon < 0 ? "W" : "E");
  const pLat = parseAngle(`${lat} ${latH}`, "lat");
  const pLon = parseAngle(`${lon} ${lonH}`, "lon");

  const emit = (la: string, lah: string, lo: string, loh: string) => {
    const a = parseAngle(`${la} ${lah}`, "lat");
    const b = parseAngle(`${lo} ${loh}`, "lon");
    if (a.ok && b.ok) onChange({ lat: a.value, lon: b.value });
  };
  const err = !pLat.ok ? pLat.error : !pLon.ok ? pLon.error : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <label htmlFor={`${uid}-lat`} className="w-8 text-[10px] uppercase tracking-wider text-muted">Lat</label>
        <input
          id={`${uid}-lat`}
          className={inputCls}
          inputMode="decimal"
          value={lat}
          aria-invalid={!pLat.ok}
          aria-describedby={`${uid}-err`}
          onChange={(e) => { setLat(e.target.value); emit(e.target.value, latH, lon, lonH); }}
        />
        <HemToggle label="Latitude hemisphere" options={["N", "S"]} value={latH} onChange={(v) => { setLatH(v); emit(lat, v, lon, lonH); }} />
      </div>
      <div className="flex items-center gap-1.5">
        <label htmlFor={`${uid}-lon`} className="w-8 text-[10px] uppercase tracking-wider text-muted">Lon</label>
        <input
          id={`${uid}-lon`}
          className={inputCls}
          inputMode="decimal"
          value={lon}
          aria-invalid={!pLon.ok}
          aria-describedby={`${uid}-err`}
          onChange={(e) => { setLon(e.target.value); emit(lat, latH, e.target.value, lonH); }}
        />
        <HemToggle label="Longitude hemisphere" options={["E", "W"]} value={lonH} onChange={(v) => { setLonH(v); emit(lat, latH, lon, v); }} />
      </div>
      <p id={`${uid}-err`} className={`text-[11px] ${err ? "text-danger" : "sr-only"}`}>{err ?? "Coordinates valid."}</p>
    </div>
  );
}

export default function StartPicker({
  value, rev, onChange, picking, onTogglePick, sites, onSelectSite,
}: {
  value: StartValue;
  /** Increment when the value is set from outside the typed fields. */
  rev: number;
  onChange: (v: StartValue, external: boolean) => void;
  picking: boolean;
  onTogglePick: () => void;
  sites: Site[];
  onSelectSite: (s: Site) => void;
}) {
  const uid = useId();
  const [paste, setPaste] = useState("");
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return sites.filter((s) => `${s.name} ${s.mission} ${s.agency}`.toLowerCase().includes(t)).slice(0, 6);
  }, [q, sites]);

  const applyPaste = () => {
    const r = parsePair(paste);
    if (!r.ok) return setPasteErr(r.error);
    setPasteErr(null);
    setPaste("");
    onChange({ ...r.value, label: "Custom start" }, true);
  };

  return (
    <section aria-labelledby={`${uid}-h`} className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <h2 id={`${uid}-h`} className="text-[13px] font-medium"><span className="text-accent">1</span> · Start: landing site or any point</h2>
        <span className="text-[10px] text-faint" title="Planetocentric latitude, east-positive longitude (MOON_ME). Latitude first.">lat, lon · °</span>
      </div>

      <CoordFields key={rev} value={value} onChange={(v) => onChange({ ...v, label: value.siteId ? "Custom start" : value.label }, false)} />

      <div className="flex gap-1.5">
        <input
          aria-label="Paste decimal degrees, latitude first"
          className={inputCls}
          placeholder="Paste “-86.2, 35.4”"
          value={paste}
          aria-invalid={!!pasteErr}
          onChange={(e) => { setPaste(e.target.value); setPasteErr(null); }}
          onKeyDown={(e) => e.key === "Enter" && paste.trim() && applyPaste()}
        />
        <button type="button" onClick={applyPaste} disabled={!paste.trim()} className="shrink-0 rounded border border-line px-2 text-[11px] text-muted hover:text-text disabled:opacity-40">
          Set
        </button>
      </div>
      {pasteErr && <p className="text-[11px] text-danger" role="alert">{pasteErr}</p>}

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onTogglePick}
          aria-pressed={picking}
          className={`flex-1 rounded border px-2 py-1.5 text-[12px] ${picking ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-text"}`}
        >
          {picking ? "Click the globe · Esc cancels" : "⌖ Pick on globe"}
        </button>
      </div>

      <div className="relative">
        <input
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={`${uid}-list`}
          aria-label="Search verified mission sites"
          className={inputCls + " font-sans"}
          placeholder="Search mission sites (e.g. Apollo 17)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches[0]) {
              onSelectSite(matches[0]);
              setQ("");
            }
            if (e.key === "Escape") setQ("");
          }}
        />
        {matches.length > 0 && (
          <ul id={`${uid}-list`} role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded border border-line-strong bg-panel shadow-lg">
            {matches.map((s) => (
              <li key={s.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  disabled={s.lat_deg === null}
                  onClick={() => { onSelectSite(s); setQ(""); }}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-panel-2 disabled:opacity-60"
                >
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[s.category] }} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="shrink-0 text-[10px] text-faint">{s.lat_deg === null ? "region · no point" : CATEGORY_LABEL[s.category].split(" ")[1] ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between rounded border border-line bg-panel-2 px-2 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-white" />
          <span className="truncate text-[11px] text-muted">{value.label}</span>
        </span>
        <output aria-live="polite" className="shrink-0 font-mono text-[11px] tabular-nums text-text">{fmtLatLon(value, 3)}</output>
      </div>
    </section>
  );
}
