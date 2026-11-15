"""FastAPI application: POST /api/compare, GET /api/health."""

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
from .service import ComputeError, run_compare

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("lunar_prime")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    kernels.load_kernels()  # once, at startup
    yield


app = FastAPI(
    title="Lunar Prime API",
    version="0.1.0",
    description="Geometric sunlight and direct-to-Earth visibility for lunar surface sites, computed with NAIF SPICE.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("LUNAR_PRIME_CORS", "http://localhost:3000,http://127.0.0.1:3000").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)


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
        synthetic_available=True,
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
                + " Synthetic demo mode is available for UI development, but its results are not scientific.",
            )
        provider = SpiceProvider()
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
