"""HTTP surface of the mission analyst: sessions, paginated history, streamed turns (SSE), proposals.

Access control: each session has a random bearer token (X-Session-Token), stored only as a SHA-256
hash. This isolates sessions from each other on a local, single-user deployment; it is NOT user
authentication. Public multi-user deployment needs real authentication, per-user authorisation,
TLS and a shared rate limiter (see README).
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections import defaultdict, deque
from typing import Callable, Optional

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from .chat_models import MAX_MESSAGE_CHARS, ChatMessageIn, ChatStatus, SessionCreated
from .chat_service import AnthropicProvider, ChatConfig, ChatService, provider_status
from .chat_tools import ToolError, insight_text
from .persistence import get_store

log = logging.getLogger("lunar_prime.chat_api")
router = APIRouter(prefix="/api/chat")


class RateLimiter:
    """In-process sliding-window limiter (single process only; use a shared store when scaling out)."""

    def __init__(self, limit: int, window_s: float):
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True


CHAT_LIMITER = RateLimiter(20, 60)  # messages per client per minute
SESSION_LIMITER = RateLimiter(12, 60)  # messages per session per minute
ROUTE_LIMITER = RateLimiter(60, 60)  # route computations per client per minute


def client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


class State:
    service: Optional[ChatService] = None
    retriever = None
    retrieval_error: Optional[str] = None
    compute_route: Optional[Callable] = None


STATE = State()


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "details": []}})


def _validate_request(req: dict) -> dict:
    """Validate a counterfactual request with the normal contract and preflight work limits."""
    from .route_network import preflight
    from .routing import RoutingError
    from .routing_models import RouteRequest

    try:
        model = RouteRequest(**req)
    except ValidationError as exc:
        first = exc.errors()[0]
        raise ToolError(f"invalid change: {'.'.join(map(str, first.get('loc', [])))}: {first.get('msg')}") from exc
    try:
        pf = preflight(model)
    except RoutingError as exc:
        raise ToolError(str(exc)) from exc
    if not pf["within_limits"]:
        raise ToolError("over the planner work limits: " + "; ".join(pf["binding_constraints"]))
    return dict(great_circle_km=pf["great_circle_km"], min_travel_hours=pf["min_travel_hours"],
                binding_constraints=pf["binding_constraints"])


def _run_route(req: dict, parent_run_id: Optional[str]) -> dict:
    from .routing_models import RouteRequest

    code, body = STATE.compute_route(RouteRequest(**req), parent_run_id)
    if code != 200:
        raise ValueError(body.get("error", {}).get("message", "comparison run failed"))
    if "run" not in body:
        raise ValueError("the comparison run could not be stored")
    return dict(run_id=body["run"]["run_id"], mode=body["metadata"]["mode"])


def startup(compute_route: Callable) -> None:
    STATE.compute_route = compute_route
    store = get_store()
    try:
        from .retrieval import Retriever, embedder_from_env, vector_store_from_env

        vectors = None
        try:
            vectors = vector_store_from_env()
        except Exception as exc:
            STATE.retrieval_error = f"vector store unavailable ({type(exc).__name__}); lexical retrieval only"
            log.warning(STATE.retrieval_error)
        STATE.retriever = Retriever(store, embedder_from_env(), vectors)
        threading.Thread(target=_ingest_static, daemon=True).start()
    except Exception as exc:
        STATE.retriever = None
        STATE.retrieval_error = f"retrieval disabled ({type(exc).__name__})"
        log.warning(STATE.retrieval_error)
    enabled, _ = provider_status()
    provider = None
    if enabled:
        try:
            provider = AnthropicProvider(ChatConfig())
        except Exception as exc:
            log.warning("LLM provider could not be initialised (%s)", type(exc).__name__)
    STATE.service = ChatService(store, STATE.retriever, provider, ChatConfig(), _validate_request, _run_route)


def _ingest_static() -> None:
    try:
        n = STATE.retriever.ingest_static()
        log.info("retrieval: %d static chunks indexed (%s)", n, STATE.retriever.collection)
    except Exception as exc:
        log.warning("static ingestion failed (%s)", type(exc).__name__)


def shutdown() -> None:
    vec = getattr(STATE.retriever, "vectors", None)
    client = getattr(vec, "client", None)
    if client is not None:
        try:
            client.close()
        except Exception:
            pass


def index_run_async(run_id: str) -> None:
    """Index a compact route insight for a new run (never the trajectory samples)."""
    if STATE.retriever is None:
        return

    def work():
        try:
            run = get_store().get_run(run_id)
            if run:
                STATE.retriever.ingest("route_insight", f"run:{run_id}", f"Route insight {run_id}", insight_text(run),
                                       None, None, run_id, run["mode"])
        except Exception:
            log.warning("route insight indexing failed", exc_info=False)

    threading.Thread(target=work, daemon=True).start()


def _auth(session_id: str, token: Optional[str]) -> Optional[JSONResponse]:
    if not get_store().check_session(session_id, token):
        return _err(404, "session_not_found", "Session not found or token invalid.")
    return None


# --------------------------------------------------------------------------------- endpoints


@router.get("/status", response_model=ChatStatus)
def status():
    enabled, reason = provider_status()
    svc = STATE.service
    if enabled and (svc is None or svc.provider is None):
        enabled, reason = False, "The language model provider could not be initialised."
    r = STATE.retriever
    cfg = ChatConfig()
    return ChatStatus(
        enabled=enabled, reason=reason, provider="anthropic" if enabled else None,
        model=cfg.model if enabled else None,
        retrieval=dict(available=r is not None, embedder=getattr(getattr(r, "embedder", None), "model_id", None),
                       vector_store=getattr(getattr(r, "vectors", None), "mode", None),
                       degraded=(getattr(r, "degraded", None) or STATE.retrieval_error)),
        limits=dict(max_message_chars=MAX_MESSAGE_CHARS, messages_per_minute=SESSION_LIMITER.limit,
                    token_budget_per_request=cfg.token_budget, max_output_tokens=cfg.max_tokens,
                    max_tool_rounds=cfg.max_tool_rounds),
    )


@router.post("/sessions", response_model=SessionCreated)
def create_session(request: Request):
    if not CHAT_LIMITER.allow("session:" + client_key(request)):
        return _err(429, "rate_limited", "Too many requests; wait a moment and retry.")
    sid, token = get_store().create_session()
    return SessionCreated(session_id=sid, token=token)


@router.get("/sessions/{session_id}/messages")
def list_messages(session_id: str, before_id: Optional[int] = None, limit: int = 50,
                  x_session_token: Optional[str] = Header(None)):
    if (e := _auth(session_id, x_session_token)) is not None:
        return e
    store = get_store()
    limit = max(1, min(100, limit))
    msgs = store.messages(session_id, before_id=before_id, limit=limit)
    return dict(messages=msgs, has_more=bool(msgs) and len(store.messages(session_id, before_id=msgs[0]["id"],
                                                                           limit=1)) > 0,
                total=store.count_messages(session_id))


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, x_session_token: Optional[str] = Header(None)):
    if (e := _auth(session_id, x_session_token)) is not None:
        return e
    if STATE.retriever is not None:
        STATE.retriever.delete_session(session_id)  # indexed summaries removed from the vector store
    get_store().delete_session(session_id)
    return dict(deleted=True)


def _sse(ev: dict) -> bytes:
    kind = ev.pop("event")
    return f"event: {kind}\ndata: {json.dumps(ev, default=str)}\n\n".encode()


@router.post("/sessions/{session_id}/messages")
async def post_message(session_id: str, body: ChatMessageIn, request: Request,
                       x_session_token: Optional[str] = Header(None)):
    if (e := await asyncio.to_thread(_auth, session_id, x_session_token)) is not None:
        return e
    if not CHAT_LIMITER.allow(client_key(request)) or not SESSION_LIMITER.allow(session_id):
        return _err(429, "rate_limited", "Too many messages; wait a moment and retry.")
    enabled, reason = provider_status()
    svc = STATE.service
    if not enabled or svc is None or svc.provider is None:
        return _err(503, "chat_disabled", reason or "The mission analyst is not configured.")
    if body.run_id is not None:
        allowed_new = body.run_id in svc.allowed_runs(session_id)
        if not allowed_new and get_store().get_run(body.run_id) is None:
            return _err(404, "unknown_run", "Run not found.")

    async def gen():
        try:
            async for ev in svc.turn(session_id, body.content, body.run_id):
                yield _sse(ev)
        except asyncio.CancelledError:
            raise

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@router.post("/sessions/{session_id}/proposals/{proposal_id}/run")
async def run_proposal(session_id: str, proposal_id: str, request: Request,
                       x_session_token: Optional[str] = Header(None)):
    """Execute an analyst-proposed comparison. Only ever triggered by an explicit user action."""
    if (e := await asyncio.to_thread(_auth, session_id, x_session_token)) is not None:
        return e
    if not ROUTE_LIMITER.allow(client_key(request)):
        return _err(429, "rate_limited", "Too many route requests; wait a moment and retry.")
    svc = STATE.service
    try:
        return await asyncio.to_thread(svc.run_proposal, session_id, proposal_id)
    except KeyError:
        return _err(404, "not_found", "Proposal not found.")
    except ValueError as exc:
        return _err(409 if "already" in str(exc) else 422, "proposal_failed", str(exc))


@router.post("/sessions/{session_id}/proposals/{proposal_id}/reject")
def reject_proposal(session_id: str, proposal_id: str, x_session_token: Optional[str] = Header(None)):
    if (e := _auth(session_id, x_session_token)) is not None:
        return e
    p = get_store().get_proposal(proposal_id)
    if p is None or p["session_id"] != session_id:
        return _err(404, "not_found", "Proposal not found.")
    if not get_store().claim_proposal(proposal_id, "rejected"):
        return _err(409, "proposal_failed", f"Proposal is already {p['status']}.")
    return dict(proposal_id=proposal_id, status="rejected")
