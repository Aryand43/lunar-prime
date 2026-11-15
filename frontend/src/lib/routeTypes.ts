// Mirrors backend/app/routing_models.py (POST /api/route).
import type { KernelOut, Mode } from "./types";

export interface RouteBaseInput {
  id: string;
  label: string;
  lat_deg: number;
  lon_deg: number;
}

export interface RouteWeights {
  distance: number;
  darkness: number;
  earth_invisible: number;
}

export interface RouteRequest {
  start: RouteBaseInput;
  destination: RouteBaseInput;
  waypoints: RouteBaseInput[];
  departure_utc: string;
  horizon_hours: number;
  speed_kmh: number;
  max_leg_km: number;
  grid_minutes: number;
  max_wait_hours: number;
  weights: RouteWeights;
  distance_scale_km: number;
  exposure_scale_hours: number;
  local_search: boolean;
  auto_network: boolean;
  include_catalog_sites: boolean;
  planning_mode: "exact" | "coarse";
  mode: Mode;
}

export interface BaseOut extends RouteBaseInput {
  role: "start" | "waypoint" | "destination";
  kind: "user" | "planning" | "catalog";
}

export interface NetworkOut {
  generated: boolean;
  generator: string | null;
  n_generated: number;
  n_user_waypoints: number;
  n_catalog_sites: number;
  catalog_site_ids: string[];
  corridors: number;
  along_spacing_km: number | null;
  lateral_offset_km: number | null;
  planning_mode: "exact" | "coarse";
  notes: string[];
  approximations: string[];
}

export interface DiagnosticsOut {
  great_circle_km: number;
  min_travel_hours: number;
  horizon_hours: number;
  binding_constraint: string | null;
  suggestion: string | null;
}

export interface RunRef {
  run_id: string;
  input_hash: string;
  result_hash: string;
  parent_run_id: string | null;
}

export interface PreflightResponse {
  great_circle_km: number;
  min_travel_hours: number;
  horizon_hours: number;
  within_limits: boolean;
  start_at_destination: boolean;
  binding_constraints: string[];
  suggestions: string[];
  network: NetworkOut | null;
  work: { n_steps: number; n_bases: number; n_candidate_legs: number; time_states: number; estimated_sample_evals: number; grid_minutes: number } | null;
  coarse_available: boolean;
}

export interface SegmentOut {
  kind: "move" | "wait";
  base_id: string;
  to_id: string | null;
  start_utc: string;
  end_utc: string;
  start_elapsed_s: number;
  duration_s: number;
  alignment_wait_s: number;
  distance_km: number;
  darkness_s: number;
  earth_invisible_s: number;
  both_visible_s: number;
}

export interface ItineraryLeg {
  from_id: string;
  to_id: string;
  depart_utc: string;
  arrive_utc: string;
  distance_km: number;
  movement_s: number;
  darkness_s: number;
  earth_invisible_s: number;
  both_visible_s: number;
}

export interface StopOut {
  order: number;
  base_id: string;
  arrive_utc: string | null;
  depart_utc: string | null;
  wait_s: number;
  alignment_wait_s: number;
}

export interface Trajectory {
  time_utc: string[];
  elapsed_s: number[];
  lat_deg: number[];
  lon_deg: number[];
  sun_az_deg: number[];
  sun_el_deg: number[];
  earth_az_deg: number[];
  earth_el_deg: number[];
  status: ("move" | "wait")[];
  segment_index: number[];
  subsolar_lat_deg: number[];
  subsolar_lon_deg: number[];
  sub_earth_lat_deg: number[];
  sub_earth_lon_deg: number[];
}

export interface RouteMetrics {
  distance_km: number;
  departure_utc: string;
  arrival_utc: string;
  elapsed_s: number;
  movement_s: number;
  waiting_s: number;
  alignment_wait_s: number;
  discretionary_wait_s: number;
  darkness_s: number;
  earth_invisible_s: number;
  both_visible_s: number;
  longest_darkness_s: number;
  longest_earth_invisible_s: number;
  cost: { distance: number; darkness: number; earth_invisible: number; total: number };
}

export interface RoutePlan {
  visited: string[];
  stops: StopOut[];
  legs: ItineraryLeg[];
  segments: SegmentOut[];
  metrics: RouteMetrics;
  trajectory: Trajectory | null;
}

export interface Alternative {
  name: string;
  feasible: boolean;
  reason: string | null;
  distance_km: number;
  plan: RoutePlan | null;
}

export interface ComparisonRow {
  metric: string;
  unit: string;
  optimized: number | null;
  baseline: number | null;
  difference: number | null;
  percent_change: number | null;
  lower_is_better: boolean;
}

export interface RouteResponse {
  status: "feasible" | "infeasible";
  reason: string | null;
  bases: BaseOut[];
  candidate_legs: { from_id: string; to_id: string; distance_km: number }[];
  route: RoutePlan | null;
  baseline: Alternative;
  direct: Alternative;
  comparison: ComparisonRow[];
  explanation: string[];
  objective: { formula: string; weights: RouteWeights; distance_scale_km: number; exposure_scale_hours: number };
  search: {
    method: string;
    optimality_scope: string;
    grid_minutes: number;
    sampling_minutes: number;
    n_time_steps: number;
    n_bases: number;
    n_candidate_legs: number;
    n_states_expanded: number;
    n_labels: number;
    n_edges_relaxed: number;
    estimated_sample_evaluations: number;
    ephemeris_epochs: number;
    graph_status: "feasible" | "infeasible";
    graph_cost: number | null;
    local_search: {
      performed: boolean;
      explanation: string;
      evaluations: number;
      selected_seed: string | null;
      seeds: { seed: string; start_cost: number; end_cost: number; accepted: number }[];
      accepted: { seed: string; move: string; cost_before: number; cost_after: number }[];
    };
    compute_time_ms: number;
  };
  metadata: {
    mode: Mode;
    provenance: string;
    disclaimer: string;
    computed_at_utc: string;
    conventions: Record<string, string>;
    limitations: string[];
    kernels: KernelOut[];
    toolkit_version: string | null;
  };
  network?: NetworkOut | null;
  diagnostics?: DiagnosticsOut | null;
  run?: RunRef | null;
}
