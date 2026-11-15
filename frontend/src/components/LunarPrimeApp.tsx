"use client";

import { useState } from "react";

import RoutePlanner from "./RoutePlanner";
import SiteNavigator from "./SiteNavigator";

type Tab = "navigator" | "route";

const TABS: [Tab, string, string][] = [
  ["navigator", "Site Navigator", "Compare landing sites and dates: sunlight for power, Earth in view for direct-to-Earth comms"],
  ["route", "Route simulator", "Plan a conceptual traverse from anywhere to the South Pole"],
];

export default function LunarPrimeApp() {
  const [tab, setTab] = useState<Tab>("navigator");
  const [routeMounted, setRouteMounted] = useState(false);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 flex h-12 items-center gap-3 border-b border-line bg-bg/95 px-4 backdrop-blur">
        <h1 className="shrink-0 text-[15px] font-semibold tracking-tight">Lunar Prime</h1>
        <div role="tablist" aria-label="Tool" className="flex rounded-md border border-line p-0.5">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                if (t === "route") setRouteMounted(true);
              }}
              className={`rounded px-2.5 py-0.5 text-[12px] ${tab === t ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="hidden truncate text-[12px] text-muted lg:inline">{TABS.find(([t]) => t === tab)![2]}</span>
      </header>

      <div className={tab === "navigator" ? "flex flex-1 flex-col" : "hidden"}>
        <SiteNavigator active={tab === "navigator"} />
      </div>
      {routeMounted && (
        <div className={tab === "route" ? "flex flex-1 flex-col" : "hidden"}>
          <RoutePlanner active={tab === "route"} />
        </div>
      )}
    </div>
  );
}
