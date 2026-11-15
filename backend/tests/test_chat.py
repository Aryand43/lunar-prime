"""Mission analyst tests. The LLM provider and embeddings are mocked: no network, no paid calls."""

import asyncio
import json
import re

import pytest

from app import chat_api
from app.chat_service import ChatConfig, ChatService, FinalTurn, ProviderError
from app.chat_tools import Tools, resolve_ref, visibility_intervals
from app.persistence import Store, get_store
from app.retrieval import HashingEmbedder, QdrantStore, Retriever

ROUTE = {"start": {"id": "S", "label": "Start", "lat_deg": -86.0, "lon_deg": 0.0},
         "departure_utc": "2027-02-13T00:00:00Z", "horizon_hours": 240, "speed_kmh": 3, "max_leg_km": 60,
         "grid_minutes": 60, "max_wait_hours": 12, "auto_network": True, "mode": "synthetic"}


class FakeProvider:
    """Scripted provider. Each script step is a function(messages) -> (text, tool_uses, stop_reason)."""

    name, model = "fake", "fake-model"

    def __init__(self, steps):
        self.steps, self.calls = list(steps), []

    async def stream(self, system, messages, tools, max_tokens, effort=None):
        self.calls.append(dict(system=system, messages=json.loads(json.dumps(messages, default=str)), tools=tools))
        step = self.steps.pop(0) if self.steps else (lambda m: ("Done.", [], "end_turn"))
        text, uses, stop = step(messages)
        if isinstance(text, Exception):
            raise text
        for chunk in re.findall(r".{1,12}", text, flags=re.S):
            yield ("text", chunk)
            await asyncio.sleep(0)
        blocks = ([dict(type="text", text=text)] if text else []) + [
            dict(type="tool_use", id=f"tu_{i}_{len(self.calls)}", name=n, input=a) for i, (n, a) in enumerate(uses)]
        yield ("final", FinalTurn(blocks, blocks, stop, 100, 20))


def last_tool_result(messages):
    for m in reversed(messages):
        if m["role"] == "user" and isinstance(m["content"], list):
            return json.loads(m["content"][0]["content"])
    raise AssertionError("no tool result")


def sse(resp):
    out = []
    for block in resp.text.strip().split("\n\n"):
        ev = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((ev["event"], json.loads(ev["data"])))
    return out


@pytest.fixture
def run_id(client):
    r = client.post("/api/route", json=ROUTE)
    assert r.status_code == 200
    return r.json()["run"]["run_id"]


@pytest.fixture
def session(client):
    d = client.post("/api/chat/sessions").json()
    return d["session_id"], {"x-session-token": d["token"]}


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("LUNAR_PRIME_LLM_ASSUME_CREDENTIALS", "1")
    svc = chat_api.STATE.service

    def install(steps):
        p = FakeProvider(steps)
        monkeypatch.setattr(svc, "provider", p)
        return p

    return install


# ------------------------------------------------------------------------------- availability


def test_missing_credentials_disable_chat_not_simulation(client, session, run_id):
    sid, h = session
    st = client.get("/api/chat/status").json()
    assert st["enabled"] is False and "ANTHROPIC_API_KEY" in st["reason"]
    r = client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "hi", "run_id": run_id}, headers=h)
    assert r.status_code == 503 and r.json()["error"]["code"] == "chat_disabled"
    assert client.post("/api/route", json=ROUTE).status_code == 200


def test_session_token_required(client, session, fake):
    sid, _ = session
    fake([])
    r = client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "hi"}, headers={"x-session-token": "nope"})
    assert r.status_code == 404
    assert client.get(f"/api/chat/sessions/{sid}/messages").status_code == 404


def test_message_size_limit(client, session, fake):
    sid, h = session
    fake([])
    r = client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "x" * 4001}, headers=h)
    assert r.status_code == 422


# ------------------------------------------------------------------------------- grounding


def test_numeric_answer_uses_stored_run_data(client, session, run_id, fake):
    sid, h = session

    def answer(messages):
        s = last_tool_result(messages)
        hours = s["metrics_hours"]["darkness_h"]
        return (f"Darkness totals {hours:.2f} h [ref:{s['refs']['darkness']}].", [], "end_turn")

    p = fake([lambda m: ("", [("get_run_summary", {"run_id": run_id})], "tool_use"), answer])
    r = client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "How much darkness?", "run_id": run_id},
                    headers=h)
    events = sse(r)
    kinds = [k for k, _ in events]
    assert kinds[0] == "meta" and "delta" in kinds and kinds[-1] == "done"
    assert ("tool", {"name": "get_run_summary", "status": "done"}) in events
    msg = events[-1][1]["message"]
    stored = get_store().get_run(run_id)["response"]["route"]["metrics"]["darkness_s"]
    assert f"{stored / 3600:.2f} h [1]" in msg["content"]
    ref = msg["refs"][0]
    assert ref["type"] == "computed" and ref["run_id"] == run_id and ref["value"] == stored
    assert msg["meta"]["unverified_numbers"] == []
    assert "<turn_context run_id=\"%s\"" % run_id in p.calls[0]["messages"][-1]["content"]


def test_unknown_values_and_fake_refs_are_not_accepted(client, session, run_id, fake):
    sid, h = session
    fake([lambda m: (f"Battery margin was 123.45 kWh [ref:run:{run_id}#metrics.battery_kwh] "
                     "[ref:doc:not-a-real-chunk].", [], "end_turn")])
    msg = sse(client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "battery?", "run_id": run_id},
                          headers=h))[-1][1]["message"]
    assert msg["refs"] == [] and "[ref:" not in msg["content"]
    assert "123.45" in msg["meta"]["unverified_numbers"]


def test_refs_resolve_to_real_fields(client, run_id, session):
    sid, _ = session
    store = get_store()
    store.add_message(sid, "user", "q", run_id)
    allowed = {run_id}
    assert resolve_ref(store, f"run:{run_id}#metrics.cost.total", allowed, sid)["type"] == "computed"
    assert resolve_ref(store, f"run:{run_id}#segments[0]", allowed, sid)["value"]["kind"] in ("move", "wait")
    assert resolve_ref(store, f"run:{run_id}#comparison[Darkness exposure]", allowed, sid) is not None
    assert resolve_ref(store, "site:apollo-11", allowed, sid)["url"].startswith("https://nssdc")
    assert resolve_ref(store, f"run:{run_id}#metrics.cost.total", set(), sid) is None  # not in this session
    assert resolve_ref(store, f"run:{run_id}#metrics.nope", allowed, sid) is None


def test_visibility_intervals_consistent_with_metrics(client, run_id):
    run = get_store().get_run(run_id)
    iv = visibility_intervals(run, "sun")
    m = run["response"]["route"]["metrics"]
    total = sum(x["duration_s"] for x in iv["hidden"])
    assert total == pytest.approx(m["darkness_s"], abs=max(60, 0.01 * m["darkness_s"]))
    if iv["longest_hidden"]:
        assert iv["longest_hidden"]["duration_s"] == pytest.approx(m["longest_darkness_s"], abs=120)


# ---------------------------------------------------------------------------- run binding


def test_followups_keep_their_run_and_new_runs_do_not_contaminate(client, session, run_id, fake):
    sid, h = session
    run_b = client.post("/api/route", json=dict(ROUTE, departure_utc="2027-02-20T00:00:00Z")).json()["run"]["run_id"]
    p = fake([lambda m: ("About A.", [], "end_turn"), lambda m: ("About B.", [], "end_turn"),
              lambda m: ("", [("get_run_summary", {"run_id": run_id})], "tool_use"),
              lambda m: (f"A departed {last_tool_result(m)['inputs']['departure_utc'][:10]}.", [], "end_turn")])
    for q, rid in (("first", run_id), ("second", run_b), ("back to the first", run_b)):
        sse(client.post(f"/api/chat/sessions/{sid}/messages", json={"content": q, "run_id": rid}, headers=h))
    msgs = client.get(f"/api/chat/sessions/{sid}/messages", headers=h).json()["messages"]
    assert [(m["role"], m["run_id"]) for m in msgs] == [("user", run_id), ("assistant", run_id), ("user", run_b),
                                                       ("assistant", run_b), ("user", run_b), ("assistant", run_b)]
    hist = p.calls[1]["messages"]
    assert f'run_id="{run_id}"' in hist[0]["content"] and f'run_id="{run_b}"' in hist[-1]["content"]
    assert "2027-02-13" in msgs[-1]["content"]  # earlier run still readable, unchanged
    assert get_store().get_run(run_id)["request"]["departure_utc"].startswith("2027-02-13")


def test_runs_are_isolated_between_sessions(client, run_id):
    store = get_store()
    s1, _ = store.create_session()
    s2, _ = store.create_session()
    store.add_message(s1, "user", "q", run_id)
    svc = chat_api.STATE.service
    t2 = Tools(store, s2, svc.allowed_runs(s2))
    with pytest.raises(Exception, match="not available"):
        t2.call("get_run_summary", {"run_id": run_id})
    assert Tools(store, s1, svc.allowed_runs(s1)).call("get_run_summary", {"run_id": run_id})["run_id"] == run_id


# ------------------------------------------------------------------------- counterfactuals


def test_counterfactual_requires_explicit_approval(client, session, run_id, fake):
    sid, h = session
    fake([lambda m: ("", [("propose_comparison", {"base_run_id": run_id,
                                                  "changes": {"departure_utc": "2027-02-14T00:00:00Z"},
                                                  "rationale": "later departure"})], "tool_use"),
          lambda m: ("I proposed a comparison; click Run comparison to execute it.", [], "end_turn")])
    with get_store().conn() as c:
        n_before = c.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    events = sse(client.post(f"/api/chat/sessions/{sid}/messages",
                             json={"content": "What if I depart a day later?", "run_id": run_id}, headers=h))
    prop = next(d for k, d in events if k == "proposal")
    assert prop["changes"] == {"departure_utc": "2027-02-14T00:00:00Z"} and prop["preflight"]["min_travel_hours"] > 0
    with get_store().conn() as c:
        assert c.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == n_before  # nothing simulated yet
    r = client.post(f"/api/chat/sessions/{sid}/proposals/{prop['proposal_id']}/run", headers=h)
    assert r.status_code == 200, r.text
    d = r.json()
    new = get_store().get_run(d["run_id"])
    assert new["parent_run_id"] == run_id and new["request"]["departure_utc"].startswith("2027-02-14")
    assert d["message"]["refs"] and "vs base run" in d["message"]["content"]
    assert client.post(f"/api/chat/sessions/{sid}/proposals/{prop['proposal_id']}/run", headers=h).status_code == 409


def test_counterfactual_rejects_unbounded_or_invalid_changes(client, session, run_id):
    store = get_store()
    sid, _ = session
    store.add_message(sid, "user", "q", run_id)
    svc = chat_api.STATE.service
    t = Tools(store, sid, svc.allowed_runs(sid), validate_request=svc._validate)
    with pytest.raises(Exception, match="unsupported"):
        t.call("propose_comparison", {"base_run_id": run_id, "changes": {"mode": "spice"}, "rationale": ""})
    with pytest.raises(Exception, match="invalid change"):
        t.call("propose_comparison", {"base_run_id": run_id, "changes": {"speed_kmh": -5}, "rationale": ""})
    with pytest.raises(Exception, match="work limits"):
        t.call("propose_comparison", {"base_run_id": run_id, "changes": {"grid_minutes": 1, "horizon_hours": 1440},
                                      "rationale": ""})


# ------------------------------------------------------------------- streaming & failures


def test_cancellation_saves_partial_answer(run_id):
    store = get_store()
    sid, _ = store.create_session()
    svc = ChatService(store, None, FakeProvider([lambda m: ("A long answer " * 20, [], "end_turn")]), ChatConfig())

    async def go():
        agen = svc.turn(sid, "explain", run_id)
        async for ev in agen:
            if ev["event"] == "delta":
                break
        await agen.aclose()

    asyncio.run(go())
    last = store.messages(sid)[-1]
    assert last["role"] == "assistant" and last["meta"]["status"] == "cancelled" and last["content"]


def test_provider_failure_emits_error_event(client, session, fake):
    sid, h = session
    fake([lambda m: (ProviderError("rate_limited", "The language model provider is rate limiting requests.", True),
                     [], None)])
    events = sse(client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "hi"}, headers=h))
    err = next(d for k, d in events if k == "error")
    assert err["code"] == "rate_limited" and err["retryable"] is True
    assert events[-1][0] == "done" and events[-1][1]["message"]["meta"]["status"] == "error"


def test_rolling_summary_bounds_context(run_id):
    store = get_store()
    sid, _ = store.create_session()
    for i in range(30):
        store.add_message(sid, "user" if i % 2 == 0 else "assistant", f"message number {i} about darkness", run_id)
    cfg = ChatConfig()
    cfg.summary_trigger, cfg.recent_messages = 20, 6
    prov = FakeProvider([lambda m: ("Summary: user asked about darkness for the run.", [], "end_turn")])
    svc = ChatService(store, None, prov, cfg)
    assert asyncio.run(svc.maybe_summarize(sid)) is True
    s = store.latest_summary(sid)
    assert s and s["upto"] == store.messages(sid, limit=500)[-7]["id"]
    uid = store.add_message(sid, "user", "and the darkness?", run_id)
    msgs = svc.build_messages(sid, uid, "and the darkness?", run_id, [])
    assert "<conversation_summary>" in msgs[0]["content"]
    assert sum(1 for m in msgs if m["role"] in ("user", "assistant")) <= 2 + cfg.recent_messages + 1


# --------------------------------------------------------------------------- persistence


def test_history_survives_restart(tmp_path):
    path = tmp_path / "db.sqlite"
    s1 = Store(path)
    sid, tok = s1.create_session()
    s1.add_message(sid, "user", "hello", None)
    s2 = Store(path)  # a fresh process would build a new Store on the same file
    assert s2.check_session(sid, tok) and [m["content"] for m in s2.messages(sid)] == ["hello"]


def test_pagination(client, session):
    sid, h = session
    store = get_store()
    for i in range(7):
        store.add_message(sid, "user", f"m{i}", None)
    page = client.get(f"/api/chat/sessions/{sid}/messages?limit=3", headers=h).json()
    assert [m["content"] for m in page["messages"]] == ["m4", "m5", "m6"] and page["has_more"]
    older = client.get(f"/api/chat/sessions/{sid}/messages?limit=3&before_id={page['messages'][0]['id']}",
                       headers=h).json()
    assert [m["content"] for m in older["messages"]] == ["m1", "m2", "m3"]


# ----------------------------------------------------------------------------- retrieval


def _retriever(tmp_path, vectors="memory"):
    store = Store(tmp_path / "r.db")
    vs = QdrantStore(path=":memory:") if vectors == "memory" else vectors
    r = Retriever(store, HashingEmbedder(), vs)
    r.ingest_static()
    return store, r


def test_retrieval_finds_docs_and_isolates_sessions(tmp_path):
    store, r = _retriever(tmp_path)
    hits = r.search("What does Earth visibility mean? communication link", None)
    assert any("Earth visibility" in h["title"] for h in hits)
    s1, _ = store.create_session()
    s2, _ = store.create_session()
    r.ingest("conversation_summary", f"session:{s1}", "Summary", "secret plan zeta-violet discussed", None, s1)
    assert any("zeta" in h["text"] for h in r.search("zeta-violet plan", s1))
    assert not any("zeta" in h["text"] for h in r.search("zeta-violet plan", s2))
    assert not any("zeta" in h["text"] for h in r.search("zeta-violet plan", None))


def test_ingestion_is_deduplicated(tmp_path):
    store, r = _retriever(tmp_path)
    n = len(store.all_chunks())
    r.ingest_static()
    assert len(store.all_chunks()) == n
    assert r.collection.endswith(HashingEmbedder().model_id)  # model/version in the collection name


def test_vector_store_failure_degrades_to_lexical(tmp_path):
    class Broken:
        mode = "broken"

        def ensure(self, *a):
            pass

        def __getattr__(self, name):
            def fail(*a, **k):
                raise ConnectionError("down")
            return fail

    store, r = _retriever(tmp_path, Broken())
    hits = r.search("darkness sun centre ideal horizon", None)
    assert hits and r.degraded and "lexical" in r.degraded


def test_session_deletion_removes_indexed_content(client, session):
    sid, h = session
    r = chat_api.STATE.retriever
    store = get_store()
    store.add_message(sid, "user", "unique-token-quokka", None)
    r.ingest("conversation_summary", f"session:{sid}", "Summary", "unique-token-quokka summary", None, sid)
    assert r.search("unique-token-quokka", sid)
    assert client.delete(f"/api/chat/sessions/{sid}", headers=h).json()["deleted"]
    assert not any("quokka" in x["text"] for x in r.search("unique-token-quokka", sid))
    assert not any("quokka" in c["text"] for c in store.all_chunks())
    assert store.messages(sid) == [] and not store.check_session(sid, h["x-session-token"])


def test_refs_with_brackets_resolve(client, session, run_id, fake):
    sid, h = session
    fake([lambda m: ("", [("get_visibility_intervals", {"run_id": run_id, "body": "sun"})], "tool_use"),
          lambda m: (f"First interval [ref:{(last_tool_result(m)['hidden'] or last_tool_result(m)['visible'])[0]['ref']}] and leg "
                     f"[ref:run:{run_id}#segments[0]] vs [ref:run:{run_id}#comparison[Darkness exposure]].", [],
                     "end_turn")])
    msg = sse(client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "gaps?", "run_id": run_id},
                          headers=h))[-1][1]["message"]
    assert "]" not in msg["content"].replace("[1]", "").replace("[2]", "").replace("[3]", "")
    paths = [r["path"] for r in msg["refs"]]
    assert paths[0].startswith("intervals.sun.") and paths[0].endswith("[0]")
    assert paths[1:] == ["segments[0]", "comparison[Darkness exposure]"]


def test_grounding_check_handles_times_and_dates():
    from app.chat_tools import unverified_numbers
    tools = [{"display": {"when": "2027-02-14 19:41 to 2027-02-14 21:11 UTC", "darkness": "7.4 h"}}]
    ok = "Darkness of 7.4 h from 19:41 to 21:11 UTC on 14 February 2027."
    assert unverified_numbers(ok, tools) == []
    assert unverified_numbers("It ends at 22:05 after 9.9 h.", tools) == ["22:05", "9.9"]
