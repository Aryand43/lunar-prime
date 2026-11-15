"use client";

import { fmtLatLon } from "@/lib/coords";
import { CATEGORY_COLOR, CATEGORY_LABEL, type Site } from "@/lib/siteTypes";

export default function SiteDetails({
  site, onClose, onUseAsStart, onInclude, included,
}: {
  site: Site;
  onClose: () => void;
  onUseAsStart: (s: Site) => void;
  onInclude: (s: Site) => void;
  included: boolean;
}) {
  const hasPoint = site.lat_deg !== null && site.lon_deg !== null;
  return (
    <div role="dialog" aria-label={`${site.name} details`} className="w-[290px] max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-panel/95 p-3 text-[12px] shadow-xl backdrop-blur">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-medium">{site.name}</h3>
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: CATEGORY_COLOR[site.category] }} />
            {CATEGORY_LABEL[site.category]} · {site.status}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close site details" className="text-faint hover:text-text">×</button>
      </div>
      <dl className="grid grid-cols-[68px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-faint">Mission</dt><dd>{site.mission}</dd>
        <dt className="text-faint">Agency</dt><dd>{site.agency}</dd>
        <dt className="text-faint">Position</dt>
        <dd className="font-mono">{hasPoint ? fmtLatLon({ lat: site.lat_deg!, lon: site.lon_deg! }, 4) : "No sourced point or boundary"}</dd>
        <dt className="text-faint">Precision</dt><dd className="text-muted">{site.precision_note}</dd>
        <dt className="text-faint">Source</dt>
        <dd>
          <a href={site.source_url} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:decoration-accent">
            {site.source_title}
          </a>
          {site.source_date && <span className="text-faint"> · {site.source_date}</span>}
        </dd>
      </dl>
      <p className="mt-2 text-[10.5px] leading-snug text-faint">Not an operational base. Implies no infrastructure, power, supplies or communications.</p>
      {hasPoint && (
        <div className="mt-2 flex gap-1.5">
          <button type="button" onClick={() => onUseAsStart(site)} className="flex-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-black hover:opacity-90">
            Use as start
          </button>
          <button type="button" onClick={() => onInclude(site)} aria-pressed={included} className="flex-1 rounded border border-line px-2 py-1 text-[11px] text-muted hover:text-text">
            {included ? "✓ Candidate waypoint" : "Include as waypoint"}
          </button>
        </div>
      )}
    </div>
  );
}
