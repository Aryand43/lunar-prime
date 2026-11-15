// Mirrors backend/app/models.py. Keep in sync with the FastAPI response models.

export type Mode = "spice" | "synthetic";

export interface SiteInput {
  id: string;
  label: string;
  lat_deg: number;
  lon_deg: number;
  /** This scenario's start (ISO 8601 UTC). Omitted means the request's start_utc. */
  start_utc?: string;
}

export interface CompareRequest {
  sites: [SiteInput, SiteInput];
  start_utc: string;
  duration_hours: number;
  step_minutes: number;
  mode: Mode;
}

export interface AzEl {
  az_deg: number[];
  el_deg: number[];
}

export interface IntervalOut {
  start_utc: string;
  end_utc: string;
  duration_s: number;
  starts_at_window_start: boolean;
  ends_at_window_end: boolean;
}

export interface GapOut {
  start_utc: string;
  end_utc: string;
  duration_s: number;
  open_start: boolean;
  open_end: boolean;
}

export interface BodyMetrics {
  visible_duration_s: number;
  visible_fraction: number;
  longest_visible_s: number;
  longest_gap: GapOut | null;
  n_intervals: number;
  el_min_deg: number;
  el_max_deg: number;
  near_horizon_fraction: number;
}

export interface SiteMetrics {
  sun: BodyMetrics;
  earth: BodyMetrics;
  both_duration_s: number;
  both_fraction: number;
}

export type Lane = "sun" | "earth" | "both";

export interface SubPoints {
  subsolar_lat_deg: number[];
  subsolar_lon_deg: number[];
  sub_earth_lat_deg: number[];
  sub_earth_lon_deg: number[];
  earth_distance_km: number[];
}

export interface SiteResult {
  id: string;
  label: string;
  lat_deg: number;
  lon_deg: number;
  position_me_km: number[];
  sun: AzEl;
  earth: AzEl;
  masks: Record<Lane, boolean[]>;
  intervals: Record<Lane, IntervalOut[]>;
  metrics: SiteMetrics;
  /** This scenario's window start, sample times and sub-points (they differ from site A's when starts differ). */
  start_utc: string;
  timestamps_utc: string[];
  subpoints: SubPoints;
}

export interface Statement {
  id: string;
  text: string;
  favors: string | null;
  kind: "comparison" | "observation" | "caveat";
}

export interface KernelOut {
  name: string;
  kind: string;
  purpose: string;
  source_url: string;
  sha256: string | null;
}

export interface Metadata {
  mode: Mode;
  provenance: string;
  computed_at_utc: string;
  window_start_utc: string;
  window_end_utc: string;
  window_duration_s: number;
  starts_differ: boolean;
  step_s: number;
  n_samples: number;
  refinement_tolerance_s: number;
  n_refined_transitions: number;
  conventions: Record<string, string>;
  limitations: string[];
  kernels: KernelOut[];
  toolkit_version: string | null;
  compute_time_ms: number;
}

export interface CompareResponse {
  timestamps_utc: string[];
  elapsed_s: number[];
  sites: [SiteResult, SiteResult];
  subpoints: SubPoints;
  comparison: { headline: string; statements: Statement[]; tolerance_s: number };
  metadata: Metadata;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  spice_available: boolean;
  synthetic_available: boolean;
  error: string | null;
  toolkit_version: string;
  coverage_start_utc: string | null;
  coverage_end_utc: string | null;
  kernels: KernelOut[];
  limits: Record<string, number>;
  conventions: Record<string, string>;
  limitations: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details: { field: string | null; message: string }[] };
}
