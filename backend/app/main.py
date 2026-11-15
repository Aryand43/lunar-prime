"""FastAPI application: compare, route planner, site catalogue, stored runs and the mission analyst."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from spiceypy.utils.exceptions import SpiceyError

from . import config, kernels
from .geometry import SpiceProvider, SyntheticProvider
from .models import CompareRequest, CompareResponse, HealthResponse, KernelOut
from .routing import RoutingError
from .routing_models import RouteRequest, RouteResponse
from .routing_service import build_response
from .service import ComputeError, run_compare
from .windows import WindowsRequest, find_windows
from . import chat_api

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("lunar_prime")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    kernels.load_kernels()  # once, at startup
    chat_api.startup(compute_route)
    yield
    chat_api.shutdown()


app = FastAPI(
    title="Lunar Prime API",
    version="0.1.0",
    description="Geometric sunlight and direct-to-Earth visibility for lunar surface sites, computed with NAIF SPICE.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("LUNAR_PRIME_CORS", "http://localhost:3000,http://127.0.0.1:3000").split(","),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["content-type", "x-session-token"],
)


_SYNTHETIC_DISABLED = "Synthetic data is disabled. All results are computed with NASA/JPL NAIF SPICE kernels."


def _error(status: int, code: str, message: str, details: list | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "details": details or []}})


@app.exception_handler(RequestValidationError)
async def _validation_handler(_req: Request, exc: RequestValidationError):
    details = []
    for e in exc.errors():
        loc = ".".join(str(p) for p in e.get("loc", []) if p != "body")
        msg = e.get("msg", "invalid value").removeprefix("Value error, ")
        details.append({"field": loc or None, "message": msg})
    summary = "; ".join(f"{d['field']}: {d['message']}" if d["field"] else d["message"] for d in details)
    return _error(422, "invalid_request", summary or "Invalid request", details)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    st = kernels.STATUS
    return HealthResponse(
        status="ok" if st.loaded else "degraded",
        spice_available=st.loaded,
        synthetic_available=config.ALLOW_SYNTHETIC,
        error=st.error,
        toolkit_version=st.toolkit_version,
        coverage_start_utc=st.coverage_start_utc,
        coverage_end_utc=st.coverage_end_utc,
        kernels=[KernelOut(name=k.name, kind=k.kind, purpose=k.purpose, source_url=k.source_url, sha256=k.sha256)
                 for k in st.kernels],
        limits={
            "max_samples": config.MAX_SAMPLES,
            "min_step_minutes": config.MIN_STEP_MINUTES,
            "max_step_minutes": config.MAX_STEP_MINUTES,
            "min_duration_hours": config.MIN_DURATION_HOURS,
            "max_duration_hours": config.MAX_DURATION_HOURS,
            "refinement_tolerance_s": config.REFINE_TOLERANCE_S,
        },
        conventions=config.CONVENTIONS,
        limitations=config.LIMITATIONS,
    )


@app.post("/api/compare", response_model=CompareResponse, responses={422: {}, 503: {}})
def compare(req: CompareRequest):
    if req.mode == "spice":
        if not kernels.STATUS.loaded:
            return _error(
                503, "spice_unavailable",
                (kernels.STATUS.error or "SPICE kernels are not loaded.")
                + " Run scripts/fetch_kernels.sh and restart the backend.",
            )
        provider = SpiceProvider()
    elif not config.ALLOW_SYNTHETIC:
        return _error(422, "synthetic_disabled", _SYNTHETIC_DISABLED)
    else:
        provider = SyntheticProvider()
    try:
        with kernels.SPICE_LOCK:  # CSPICE is not thread-safe
            return run_compare(req, provider)
    except ComputeError as exc:
        return _error(422, "invalid_request", str(exc))
    except SpiceyError as exc:
        log.exception("SPICE error")
        return _error(500, "spice_error", f"SPICE computation failed: {exc.short or exc}")


@app.post("/api/windows")
def windows(req: WindowsRequest):
    """Best landing windows for one site over a period (screening resolution; see resolution_note)."""
    if req.mode == "spice":
        if not kernels.STATUS.loaded:
            return _error(503, "spice_unavailable", (kernels.STATUS.error or "SPICE kernels are not loaded.")
                          + " Run scripts/fetch_kernels.sh and restart the backend.")
        provider = SpiceProvider()
    elif not config.ALLOW_SYNTHETIC:
        return _error(422, "synthetic_disabled", _SYNTHETIC_DISABLED)
    else:
        provider = SyntheticProvider()
    try:
        with kernels.SPICE_LOCK:
            return find_windows(req, provider)
    except ComputeError as exc:
        return _error(422, "invalid_request", str(exc))
    except SpiceyError as exc:
        log.exception("SPICE error")
        return _error(500, "spice_error", f"SPICE computation failed: {exc.short or exc}")


@app.get("/api/terrain/status")
def terrain_status():
    """Precomputed LOLA skylines available to /api/compare and /api/windows (by horizon_key)."""
    import json
    keys = []
    for path in sorted(config.HORIZON_DIR.glob("*.json")):
        try:
            d = json.loads(path.read_text())
            keys.append(dict(key=d["key"], label=d["label"], lat_deg=d["lat_deg"], lon_deg=d["lon_deg"],
                             dems=[x["name"] for x in d.get("dems", [])]))
        except (OSError, ValueError, KeyError):
            continue
    return dict(skylines=keys, source="LOLA south-polar elevation maps, NASA GSFC PGDA product 90",
                source_url="https://pgda.gsfc.nasa.gov/products/90")


@app.get("/api/sites")
def sites():
    """Source-cited site catalogue. Not derived from SPICE; no site implies infrastructure."""
    from .site_catalog import load
    return load()


@app.post("/api/route/preflight")
def route_preflight(req: RouteRequest):
    """Distance, travel-time lower bound and work estimate. Pure geometry: no SPICE, no search."""
    from .route_network import preflight
    try:
        return preflight(req)
    except RoutingError as exc:
        return _error(422, "invalid_request", str(exc))


def compute_route(req: RouteRequest, parent_run_id: str | None = None) -> tuple[int, dict]:
    """Shared by POST /api/route and approved analyst comparisons: identical limits and SPICE handling.

    The SPICE lock is held only around the computation, never during persistence, indexing or LLM calls.
    """
    if req.mode == "spice":
        if not kernels.STATUS.loaded:  # never fall back to synthetic silently
            return 503, _err_body(
                "spice_unavailable",
                (kernels.STATUS.error or "SPICE kernels are not loaded.")
                + " Run scripts/fetch_kernels.sh and restart the backend.")
        provider = SpiceProvider()
    elif not config.ALLOW_SYNTHETIC:
        return 422, _err_body("synthetic_disabled", _SYNTHETIC_DISABLED)
    else:
        provider = SyntheticProvider()
    try:
        with kernels.SPICE_LOCK:  # one acquisition; routing code never takes the lock itself
            resp = build_response(req, provider)
    except RoutingError as exc:
        return 422, _err_body("invalid_request", str(exc))
    except SpiceyError as exc:
        log.exception("SPICE error")
        return 500, _err_body("spice_error", f"SPICE computation failed: {exc.short or exc}")
    body = resp.model_dump(mode="json")
    try:
        from .persistence import get_store
        ref = get_store().save_run(req.model_dump(mode="json"), body, parent_run_id)
        body["run"] = dict(ref, parent_run_id=parent_run_id)
        chat_api.index_run_async(ref["run_id"])
    except Exception:  # persistence must never break routing
        log.warning("could not persist run", exc_info=False)
    return 200, body


def _err_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message, "details": []}}


@app.post("/api/route", response_model=RouteResponse, responses={422: {}, 503: {}})
def route(req: RouteRequest, request: Request):
    """South Pole Route Planner. A valid request with no route returns 200 with status 'infeasible'."""
    if not chat_api.ROUTE_LIMITER.allow(chat_api.client_key(request)):
        return _error(429, "rate_limited", "Too many route requests; wait a moment and retry.")
    code, body = compute_route(req)
    return JSONResponse(status_code=code, content=body)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str, full: bool = False):
    """Stored run metadata and request (immutable). The full response is included with ?full=1."""
    from .persistence import get_store
    run = get_store().get_run(run_id) if run_id.startswith("run_") and len(run_id) == 20 else None
    if run is None:
        return _error(404, "not_found", "Run not found.")
    out = {k: run[k] for k in ("run_id", "created_at", "mode", "status", "input_hash", "result_hash",
                               "parent_run_id", "request")}
    if full:
        out["response"] = dict(run["response"], run=dict(run_id=run["run_id"], input_hash=run["input_hash"],
                                                         result_hash=run["result_hash"],
                                                         parent_run_id=run["parent_run_id"]))
    return out


app.include_router(chat_api.router)
