// Mirrors backend/app/site_catalog.py (GET /api/sites). Catalogue positions are independent of SPICE.

export type SiteCategory = "crewed_landing" | "robotic_landing" | "proposed_region" | "planning_waypoint" | "user_defined";

export interface Site {
  id: string;
  name: string;
  mission: string;
  agency: string;
  category: SiteCategory;
  status: string;
  lat_deg: number | null;
  lon_deg: number | null;
  frame: string | null;
  source_title: string;
  source_url: string;
  source_date: string | null;
  retrieved: string;
  precision_note: string;
  region: Record<string, unknown> | null;
}

export interface Catalogue {
  version: string;
  note: string;
  sites: Site[];
}

export const CATEGORY_LABEL: Record<SiteCategory, string> = {
  crewed_landing: "Historical crewed landing",
  robotic_landing: "Robotic landing",
  proposed_region: "Proposed landing region",
  planning_waypoint: "Planning waypoint (hypothetical)",
  user_defined: "User-defined location",
};

export const CATEGORY_COLOR: Record<SiteCategory, string> = {
  crewed_landing: "#f4ecd2",
  robotic_landing: "#c39bea",
  proposed_region: "#e58f65",
  planning_waypoint: "#8b919b",
  user_defined: "#ffffff",
};
