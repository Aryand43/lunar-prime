import type { PreflightResponse, RouteRequest, RouteResponse } from "./routeTypes";
import type { Catalogue } from "./siteTypes";
import type { ApiErrorBody, CompareRequest, CompareResponse, HealthResponse } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details: { field: string | null; message: string }[] = [],
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error (e.g. proxy failure) */
  }
  if (body?.error) throw new ApiError(body.error.message, body.error.code, res.status, body.error.details);
  if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ApiError(
      "Cannot reach the Lunar Prime backend. Start it with `cd backend && uv run uvicorn app.main:app --port 8000`.",
      "backend_unreachable",
      res.status,
    );
  }
  throw new ApiError(`Request failed (HTTP ${res.status}).`, "http_error", res.status);
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  try {
    return await parse<HealthResponse>(await fetch("/api/health", { signal, cache: "no-store" }));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Cannot reach the Lunar Prime backend.", "backend_unreachable", 0);
  }
}

export async function postCompare(req: CompareRequest, signal?: AbortSignal): Promise<CompareResponse> {
  try {
    const res = await fetch("/api/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    return await parse<CompareResponse>(res);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Cannot reach the Lunar Prime backend.", "backend_unreachable", 0);
  }
}

export async function postRoute(req: RouteRequest, signal?: AbortSignal): Promise<RouteResponse> {
  try {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    return await parse<RouteResponse>(res);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Cannot reach the Lunar Prime backend.", "backend_unreachable", 0);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    return await parse<T>(await fetch(url, init));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Cannot reach the Lunar Prime backend.", "backend_unreachable", 0);
  }
}

export function fetchSites(signal?: AbortSignal): Promise<Catalogue> {
  return call<Catalogue>("/api/sites", { signal });
}

export function postPreflight(req: RouteRequest, signal?: AbortSignal): Promise<PreflightResponse> {
  return call<PreflightResponse>("/api/route/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
}

export interface StoredRun {
  run_id: string;
  created_at: number;
  mode: string;
  status: string;
  input_hash: string;
  result_hash: string;
  parent_run_id: string | null;
  request: RouteRequest;
  response?: RouteResponse;
}

export function fetchRun(runId: string, full = false, signal?: AbortSignal): Promise<StoredRun> {
  return call<StoredRun>(`/api/runs/${encodeURIComponent(runId)}${full ? "?full=1" : ""}`, { signal });
}
