"""SQLite persistence: immutable simulation runs, chat sessions, messages, rolling summaries,
counterfactual proposals, and a lexical (FTS5) index of text chunks.

One connection per operation (sqlite3 connections are cheap); WAL mode lets the routing threads and
the async chat handlers read and write concurrently in a single process.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from . import config

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_at REAL NOT NULL,
  kind TEXT NOT NULL,                -- route
  mode TEXT NOT NULL,                -- spice | synthetic
  status TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  parent_run_id TEXT,                -- set for approved counterfactual comparisons
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_input ON runs(input_hash);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  title TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL,                -- user | assistant | event
  content TEXT NOT NULL,
  run_id TEXT,                       -- the run this turn is about (immutable binding)
  refs_json TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  upto_message_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  base_run_id TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | executed | rejected | failed
  result_run_id TEXT,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,         -- uuid5 of the content hash + scope
  content_hash TEXT NOT NULL,
  doc_type TEXT NOT NULL,            -- method_doc | site | route_insight | conversation_summary
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  session_id TEXT,                   -- NULL = global
  run_id TEXT,
  mode TEXT,
  text TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, title, text);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, session_id UNINDEXED, content);
"""


def canonical_hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._mem = sqlite3.connect(":memory:", check_same_thread=False) if self.path == ":memory:" else None
        self._lock = threading.Lock()  # serialises writes on the shared in-memory connection (tests)
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        if self._mem is not None:
            with self._lock:
                self._mem.row_factory = sqlite3.Row
                yield self._mem
                self._mem.commit()
            return
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        try:
            yield c
            c.commit()
        finally:
            c.close()

    # ------------------------------------------------------------------ runs
    def save_run(self, request: dict, response: dict, parent_run_id: Optional[str] = None) -> dict:
        """Persist an immutable run. Volatile fields (compute time, timestamp) are excluded from the result hash."""
        stable = json.loads(json.dumps(response, default=str))
        stable.get("search", {}).pop("compute_time_ms", None)
        stable.get("metadata", {}).pop("computed_at_utc", None)
        stable.pop("run", None)
        input_hash, result_hash = canonical_hash(request), canonical_hash(stable)
        run_id = "run_" + uuid.uuid4().hex[:16]
        with self.conn() as c:
            c.execute(
                "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)",
                (run_id, time.time(), "route", response.get("metadata", {}).get("mode", "unknown"),
                 response.get("status", "unknown"), input_hash, result_hash, parent_run_id,
                 json.dumps(request, default=str), json.dumps(response, default=str)),
            )
        return dict(run_id=run_id, input_hash=input_hash, result_hash=result_hash)

    def get_run(self, run_id: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if r is None:
            return None
        return dict(run_id=r["run_id"], created_at=r["created_at"], mode=r["mode"], status=r["status"],
                    input_hash=r["input_hash"], result_hash=r["result_hash"], parent_run_id=r["parent_run_id"],
                    request=json.loads(r["request_json"]), response=json.loads(r["response_json"]))

    # -------------------------------------------------------------- sessions
    def create_session(self, title: str = "") -> tuple[str, str]:
        sid = "ses_" + uuid.uuid4().hex[:16]
        token = secrets.token_urlsafe(24)
        now = time.time()
        with self.conn() as c:
            c.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", (sid, _token_hash(token), now, now, title[:120]))
        return sid, token

    def check_session(self, session_id: str, token: Optional[str]) -> bool:
        if not token:
            return False
        with self.conn() as c:
            r = c.execute("SELECT token_hash FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        return r is not None and secrets.compare_digest(r["token_hash"], _token_hash(token))

    def delete_session(self, session_id: str) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM messages_fts WHERE session_id=?", (session_id,))
            ids = [r["chunk_id"] for r in c.execute("SELECT chunk_id FROM chunks WHERE session_id=?", (session_id,))]
            for cid in ids:
                c.execute("DELETE FROM chunks_fts WHERE chunk_id=?", (cid,))
            c.execute("DELETE FROM chunks WHERE session_id=?", (session_id,))
            for t in ("messages", "summaries", "proposals"):
                c.execute(f"DELETE FROM {t} WHERE session_id=?", (session_id,))
            c.execute("DELETE FROM sessions WHERE session_id=?", (session_id,))

    # -------------------------------------------------------------- messages
    def add_message(self, session_id: str, role: str, content: str, run_id: Optional[str],
                    refs: list | None = None, meta: dict | None = None) -> int:
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO messages (session_id, role, content, run_id, refs_json, meta_json, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (session_id, role, content, run_id, json.dumps(refs or []), json.dumps(meta or {}), time.time()),
            )
            mid = int(cur.lastrowid)
            if role in ("user", "assistant"):
                c.execute("INSERT INTO messages_fts VALUES (?,?,?)", (mid, session_id, content))
            c.execute("UPDATE sessions SET updated_at=? WHERE session_id=?", (time.time(), session_id))
        return mid

    def update_message(self, mid: int, content: str, refs: list, meta: dict) -> None:
        with self.conn() as c:
            c.execute("UPDATE messages SET content=?, refs_json=?, meta_json=? WHERE id=?",
                      (content, json.dumps(refs), json.dumps(meta), mid))
            c.execute("DELETE FROM messages_fts WHERE message_id=?", (mid,))
            r = c.execute("SELECT session_id, role FROM messages WHERE id=?", (mid,)).fetchone()
            if r and r["role"] in ("user", "assistant"):
                c.execute("INSERT INTO messages_fts VALUES (?,?,?)", (mid, r["session_id"], content))

    def messages(self, session_id: str, before_id: Optional[int] = None, after_id: Optional[int] = None,
                 limit: int = 50) -> list[dict]:
        q, args = "SELECT * FROM messages WHERE session_id=?", [session_id]
        if before_id is not None:
            q += " AND id<?"
            args.append(before_id)
        if after_id is not None:
            q += " AND id>?"
            args.append(after_id)
        q += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        with self.conn() as c:
            rows = c.execute(q, args).fetchall()
        return [self._msg(r) for r in reversed(rows)]

    def count_messages(self, session_id: str) -> int:
        with self.conn() as c:
            return int(c.execute("SELECT COUNT(*) FROM messages WHERE session_id=?", (session_id,)).fetchone()[0])

    @staticmethod
    def _msg(r) -> dict:
        return dict(id=r["id"], role=r["role"], content=r["content"], run_id=r["run_id"],
                    refs=json.loads(r["refs_json"]), meta=json.loads(r["meta_json"]), created_at=r["created_at"])

    def search_messages(self, session_id: str, query: str, exclude_after: Optional[int] = None,
                        limit: int = 4) -> list[dict]:
        """Lexical recall of older messages, strictly within one session."""
        terms = _fts_query(query)
        if not terms:
            return []
        with self.conn() as c:
            rows = c.execute(
                "SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.message_id "
                "WHERE messages_fts MATCH ? AND f.session_id=? AND (? IS NULL OR m.id < ?) "
                "ORDER BY bm25(messages_fts) LIMIT ?",
                (terms, session_id, exclude_after, exclude_after, limit),
            ).fetchall()
        return [self._msg(r) for r in rows]

    # ------------------------------------------------------------- summaries
    def latest_summary(self, session_id: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute("SELECT * FROM summaries WHERE session_id=? ORDER BY id DESC LIMIT 1",
                          (session_id,)).fetchone()
        return None if r is None else dict(upto=r["upto_message_id"], content=r["content"])

    def add_summary(self, session_id: str, upto: int, content: str) -> None:
        with self.conn() as c:
            c.execute("INSERT INTO summaries (session_id, upto_message_id, content, created_at) VALUES (?,?,?,?)",
                      (session_id, upto, content, time.time()))

    # ------------------------------------------------------------- proposals
    def add_proposal(self, session_id: str, base_run_id: str, changes: dict, rationale: str) -> str:
        pid = "prop_" + uuid.uuid4().hex[:12]
        with self.conn() as c:
            c.execute("INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?)",
                      (pid, session_id, base_run_id, json.dumps(changes), rationale[:500], "pending", None, time.time()))
        return pid

    def get_proposal(self, pid: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute("SELECT * FROM proposals WHERE proposal_id=?", (pid,)).fetchone()
        if r is None:
            return None
        return dict(proposal_id=r["proposal_id"], session_id=r["session_id"], base_run_id=r["base_run_id"],
                    changes=json.loads(r["changes_json"]), rationale=r["rationale"], status=r["status"],
                    result_run_id=r["result_run_id"])

    def claim_proposal(self, pid: str, to: str = "running") -> bool:
        """Atomically move a pending proposal on; False if it was not pending (no double execution)."""
        with self.conn() as c:
            cur = c.execute("UPDATE proposals SET status=? WHERE proposal_id=? AND status='pending'", (to, pid))
            return cur.rowcount > 0

    def finish_proposal(self, pid: str, status: str, result_run_id: Optional[str] = None) -> None:
        with self.conn() as c:
            c.execute("UPDATE proposals SET status=?, result_run_id=? WHERE proposal_id=?",
                      (status, result_run_id, pid))

    # ---------------------------------------------------------------- chunks
    def upsert_chunk(self, chunk: dict) -> bool:
        """Insert if new (content-hash dedup). Returns True when inserted."""
        with self.conn() as c:
            if c.execute("SELECT 1 FROM chunks WHERE chunk_id=?", (chunk["chunk_id"],)).fetchone():
                return False
            c.execute("INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (chunk["chunk_id"], chunk["content_hash"], chunk["doc_type"], chunk["source"], chunk["title"],
                       chunk.get("url"), chunk.get("session_id"), chunk.get("run_id"), chunk.get("mode"),
                       chunk["text"], time.time()))
            c.execute("INSERT INTO chunks_fts VALUES (?,?,?)", (chunk["chunk_id"], chunk["title"], chunk["text"]))
        return True

    def get_chunk(self, chunk_id: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute("SELECT * FROM chunks WHERE chunk_id=?", (chunk_id,)).fetchone()
        return None if r is None else dict(r)

    def all_chunks(self) -> list[dict]:
        with self.conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM chunks")]

    def lexical_chunks(self, query: str, session_id: Optional[str], doc_types: Optional[list[str]] = None,
                       run_id: Optional[str] = None, limit: int = 8) -> list[dict]:
        """BM25 search over chunks; global chunks plus (only) this session's chunks."""
        terms = _fts_query(query)
        if not terms:
            return []
        q = ("SELECT c.* FROM chunks_fts f JOIN chunks c ON c.chunk_id = f.chunk_id WHERE chunks_fts MATCH ? "
             "AND (c.session_id IS NULL OR c.session_id = ?)")
        args: list = [terms, session_id]
        if doc_types:
            q += f" AND c.doc_type IN ({','.join('?' * len(doc_types))})"
            args += doc_types
        q += " AND (c.run_id IS NULL OR c.run_id = ?)"  # run-scoped chunks only for the run in question
        args.append(run_id)
        q += " ORDER BY bm25(chunks_fts) LIMIT ?"
        args.append(limit)
        with self.conn() as c:
            return [dict(r) for r in c.execute(q, args)]


def _fts_query(text: str) -> str:
    words = [w for w in "".join(ch if ch.isalnum() else " " for ch in text.lower()).split() if len(w) > 2]
    return " OR ".join(f'"{w}"' for w in words[:24])


_STORE: Optional[Store] = None
_STORE_LOCK = threading.Lock()


def get_store() -> Store:
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = Store(os.environ.get("LUNAR_PRIME_DB_PATH", str(config.BACKEND_DIR / ".data" / "lunar_prime.db")))
        return _STORE


def set_store(store: Optional[Store]) -> None:
    global _STORE
    with _STORE_LOCK:
        _STORE = store
