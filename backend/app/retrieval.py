"""Retrieval for the mission analyst: documentation, catalogue records, route insights and conversation
summaries. Semantic search via Qdrant (behind a small VectorStore interface) fused with SQLite FTS5
BM25 lexical search (reciprocal-rank fusion).

Vector similarity is used only to *find text*; it never produces numerical results.

Qdrant is the default because it offers a persistent embedded "local mode" for single-process
development and the same client API against a Qdrant server for concurrent deployments, with exact
payload filters (session, run, doc type, source). That is a fit-for-this-project choice, not a claim
that it is the best vector database in general.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol

from . import config
from .persistence import Store

log = logging.getLogger("lunar_prime.retrieval")

DOCS_DIR = config.BACKEND_DIR / "data" / "docs"
GLOBAL_TYPES = ["method_doc", "site"]
NS = uuid.UUID("6c1f1d0e-5f0a-4d43-9a39-0b6a7c3c2f11")


# ---------------------------------------------------------------------------------- embedders


class Embedder(Protocol):
    model_id: str  # includes version; part of the collection name
    dim: int

    def embed(self, texts: list[str], kind: str = "document") -> list[list[float]]: ...


class HashingEmbedder:
    """Deterministic local feature-hashing embedder (word unigrams + bigrams, signed, L2-normalised).

    No network, no cost. It captures lexical overlap only, not meaning; configure a real embedding
    provider for semantic retrieval. Used by default when no provider is configured, and in tests.
    """

    def __init__(self, dim: int = 512):
        self.dim = dim
        self.model_id = f"hash-v1-{dim}"

    def embed(self, texts: list[str], kind: str = "document") -> list[list[float]]:
        out = []
        for t in texts:
            v = [0.0] * self.dim
            words = re.findall(r"[a-z0-9]+", t.lower())
            feats = words + [a + "_" + b for a, b in zip(words, words[1:])]
            for f in feats:
                h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "little")
                v[h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / n for x in v])
        return out


class HttpEmbedder:
    """OpenAI-compatible /embeddings endpoint (e.g. Voyage AI: base https://api.voyageai.com/v1).

    Configured via LUNAR_PRIME_EMBED_BASE_URL, LUNAR_PRIME_EMBED_MODEL, LUNAR_PRIME_EMBED_API_KEY and
    LUNAR_PRIME_EMBED_DIM. The key is sent only in the Authorization header and never logged.
    """

    def __init__(self, base_url: str, model: str, api_key: str, dim: int, timeout_s: float = 20.0):
        import httpx

        self.dim, self.model = dim, model
        self.model_id = f"http-{re.sub(r'[^a-z0-9]+', '-', model.lower())}-{dim}"
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout_s,
                                    headers={"Authorization": f"Bearer {api_key}"})

    def embed(self, texts: list[str], kind: str = "document") -> list[list[float]]:
        body = {"model": self.model, "input": texts}
        if "voyage" in self.model:
            body["input_type"] = "query" if kind == "query" else "document"
        r = self._client.post("/embeddings", json=body)
        if r.status_code != 200:
            raise RuntimeError(f"embedding provider returned HTTP {r.status_code}")
        data = sorted(r.json()["data"], key=lambda d: d["index"])
        vecs = [d["embedding"] for d in data]
        if any(len(v) != self.dim for v in vecs):
            raise RuntimeError(f"embedding dimension mismatch (expected {self.dim})")
        return vecs


def embedder_from_env() -> Embedder:
    base = os.environ.get("LUNAR_PRIME_EMBED_BASE_URL")
    key = os.environ.get("LUNAR_PRIME_EMBED_API_KEY")
    model = os.environ.get("LUNAR_PRIME_EMBED_MODEL")
    if base and key and model:
        return HttpEmbedder(base, model, key, int(os.environ.get("LUNAR_PRIME_EMBED_DIM", "1024")))
    return HashingEmbedder()


# ------------------------------------------------------------------------------- vector store


@dataclass
class Hit:
    chunk_id: str
    score: float


class VectorStore(Protocol):
    def ensure(self, name: str, dim: int) -> None: ...
    def upsert(self, name: str, items: list[tuple[str, list[float], dict]]) -> None: ...
    def search(self, name: str, vector: list[float], limit: int, session_id: Optional[str],
               doc_types: Optional[list[str]], run_id: Optional[str]) -> list[Hit]: ...
    def delete_session(self, name: str, session_id: str) -> None: ...
    def existing_ids(self, name: str, ids: list[str]) -> set[str]: ...


class QdrantStore:
    """Qdrant local (embedded, persistent) or server mode."""

    def __init__(self, url: Optional[str] = None, path: Optional[str] = None, api_key: Optional[str] = None):
        from qdrant_client import QdrantClient

        if url:
            self.client = QdrantClient(url=url, api_key=api_key, timeout=10)
            self.mode = "server"
        elif path == ":memory:":
            self.client = QdrantClient(location=":memory:")
            self.mode = "memory"
        else:
            Path(path).mkdir(parents=True, exist_ok=True)
            self.client = QdrantClient(path=path)
            self.mode = "local"

    def ensure(self, name: str, dim: int) -> None:
        from qdrant_client import models as m

        if not self.client.collection_exists(name):
            self.client.create_collection(name, vectors_config=m.VectorParams(size=dim, distance=m.Distance.COSINE))
            for field in ("session_id", "doc_type", "run_id", "source", "mode"):
                try:
                    self.client.create_payload_index(name, field, m.PayloadSchemaType.KEYWORD)
                except Exception:  # local mode ignores payload indexes
                    pass

    def upsert(self, name, items):
        from qdrant_client import models as m

        if items:
            self.client.upsert(name, points=[m.PointStruct(id=i, vector=v, payload=p) for i, v, p in items])

    def existing_ids(self, name, ids):
        if not ids:
            return set()
        return {str(p.id) for p in self.client.retrieve(name, ids=ids, with_payload=False, with_vectors=False)}

    def search(self, name, vector, limit, session_id, doc_types, run_id):
        from qdrant_client import models as m

        hits: list[Hit] = []
        # Separate scoped queries make isolation structural: global docs, this session only, this run only.
        global_types = [t for t in (doc_types or GLOBAL_TYPES) if t in GLOBAL_TYPES]
        scopes = []
        if global_types:
            scopes.append(m.Filter(must=[
                m.FieldCondition(key="doc_type", match=m.MatchAny(any=global_types)),
                m.IsEmptyCondition(is_empty=m.PayloadField(key="session_id")),
                m.IsEmptyCondition(is_empty=m.PayloadField(key="run_id"))]))
        if session_id:
            must = [m.FieldCondition(key="session_id", match=m.MatchValue(value=session_id))]
            if doc_types:
                must.append(m.FieldCondition(key="doc_type", match=m.MatchAny(any=doc_types)))
            scopes.append(m.Filter(must=must))
        if run_id and (not doc_types or "route_insight" in doc_types):
            scopes.append(m.Filter(must=[m.FieldCondition(key="run_id", match=m.MatchValue(value=run_id)),
                                         m.FieldCondition(key="doc_type", match=m.MatchValue(value="route_insight"))]))
        for f in scopes:
            res = self.client.query_points(name, query=vector, query_filter=f, limit=limit, with_payload=True)
            hits += [Hit(str(p.payload.get("chunk_id")), float(p.score)) for p in res.points]
        return sorted(hits, key=lambda h: -h.score)[:limit]

    def delete_session(self, name, session_id):
        from qdrant_client import models as m

        if self.client.collection_exists(name):
            self.client.delete(name, points_selector=m.FilterSelector(filter=m.Filter(must=[
                m.FieldCondition(key="session_id", match=m.MatchValue(value=session_id))])))


def vector_store_from_env() -> VectorStore:
    url = os.environ.get("LUNAR_PRIME_QDRANT_URL")
    return QdrantStore(url=url, api_key=os.environ.get("LUNAR_PRIME_QDRANT_API_KEY"),
                       path=os.environ.get("LUNAR_PRIME_QDRANT_PATH", str(config.BACKEND_DIR / ".data" / "qdrant")))


# ---------------------------------------------------------------------------------- retriever


def chunk_markdown(text: str, max_chars: int = 1200) -> list[tuple[str, str]]:
    """Split on headings; keep (heading, body) chunks under max_chars."""
    out, title, buf = [], "Overview", []
    for line in text.splitlines():
        if line.startswith("#"):
            if "".join(buf).strip():
                out.append((title, "\n".join(buf).strip()))
            title, buf = line.lstrip("#").strip(), []
        else:
            buf.append(line)
    if "".join(buf).strip():
        out.append((title, "\n".join(buf).strip()))
    final = []
    for t, body in out:
        while len(body) > max_chars:
            cut = body.rfind("\n", 0, max_chars)
            cut = cut if cut > 200 else max_chars
            final.append((t, body[:cut].strip()))
            body = body[cut:].strip()
        final.append((t, body))
    return final


class Retriever:
    def __init__(self, store: Store, embedder: Embedder, vectors: Optional[VectorStore]):
        self.store, self.embedder, self.vectors = store, embedder, vectors
        self.collection = f"lunar_prime__{embedder.model_id}"
        self.degraded: Optional[str] = None
        if vectors is not None:
            try:
                vectors.ensure(self.collection, embedder.dim)
            except Exception as exc:  # pragma: no cover - depends on the environment
                self._degrade(exc)

    def _degrade(self, exc: Exception) -> None:
        self.degraded = f"vector store unavailable ({type(exc).__name__}); using lexical retrieval only"
        log.warning(self.degraded)
        self.vectors = None

    # -------------------------------------------------------------- ingestion
    def ingest(self, doc_type: str, source: str, title: str, text: str, url: Optional[str] = None,
               session_id: Optional[str] = None, run_id: Optional[str] = None, mode: Optional[str] = None) -> str:
        content_hash = hashlib.sha256(f"{doc_type}|{source}|{title}|{text}".encode()).hexdigest()
        chunk_id = str(uuid.uuid5(NS, f"{content_hash}|{session_id or ''}|{run_id or ''}"))
        chunk = dict(chunk_id=chunk_id, content_hash=content_hash, doc_type=doc_type, source=source, title=title,
                     url=url, session_id=session_id, run_id=run_id, mode=mode, text=text)
        self.store.upsert_chunk(chunk)
        self._index([chunk])
        return chunk_id

    def _index(self, chunks: list[dict]) -> None:
        if self.vectors is None or not chunks:
            return
        try:
            have = self.vectors.existing_ids(self.collection, [c["chunk_id"] for c in chunks])
            todo = [c for c in chunks if c["chunk_id"] not in have]
            if not todo:
                return
            vecs = self.embedder.embed([f"{c['title']}\n{c['text']}" for c in todo])
            self.vectors.upsert(self.collection, [
                (c["chunk_id"], v, {k: c.get(k) for k in ("chunk_id", "doc_type", "source", "session_id", "run_id",
                                                          "mode", "title", "content_hash")}
                 | {"embed_model": self.embedder.model_id})
                for c, v in zip(todo, vecs)])
        except Exception as exc:
            self._degrade(exc)

    def reindex(self) -> int:
        """Embed every stored chunk into the current model's collection (safe after a model/dim change:
        a new collection name is used, old collections are left untouched)."""
        chunks = self.store.all_chunks()
        for i in range(0, len(chunks), 64):
            self._index(chunks[i:i + 64])
        return len(chunks)

    def ingest_static(self) -> int:
        """Project documentation + catalogue records. Idempotent (content-hash dedup)."""
        n = 0
        for p in sorted(DOCS_DIR.glob("*.md")):
            for title, body in chunk_markdown(p.read_text()):
                self.ingest("method_doc", f"docs/{p.name}", title, body)
                n += 1
        for title, body in (("Route planner limitations", "\n".join(f"- {x}" for x in config.ROUTE_LIMITATIONS)),
                            ("Geometry limitations", "\n".join(f"- {x}" for x in config.LIMITATIONS)),
                            *[(f"Convention: {k}", v) for k, v in config.CONVENTIONS.items()]):
            self.ingest("method_doc", "app/config.py", title, body)
            n += 1
        from .site_catalog import load
        cat = load()
        for s in cat.sites:
            pos = (f"{s.lat_deg}°, {s.lon_deg}° E ({s.frame})" if s.lat_deg is not None
                   else "no point coordinates published")
            text = (f"{s.name} ({s.mission}, {s.agency}). Category: {s.category.replace('_', ' ')}; status: {s.status}. "
                    f"Position: {pos}. Precision: {s.precision_note} Source: {s.source_title} ({s.source_date}). "
                    "Not an operational base; implies no infrastructure, power, supplies or communications.")
            self.ingest("site", f"catalogue:{s.id}", s.name, text, url=s.source_url)
            n += 1
        return n

    def delete_session(self, session_id: str) -> None:
        if self.vectors is not None:
            try:
                self.vectors.delete_session(self.collection, session_id)
            except Exception as exc:
                self._degrade(exc)

    # ------------------------------------------------------------------ search
    def search(self, query: str, session_id: Optional[str], doc_types: Optional[list[str]] = None,
               run_id: Optional[str] = None, limit: int = 6) -> list[dict]:
        """Hybrid search; reciprocal-rank fusion of semantic (Qdrant) and lexical (FTS5) rankings."""
        ranked: dict[str, float] = {}
        lex = self.store.lexical_chunks(query, session_id, doc_types, run_id, limit=limit * 2)
        for r, c in enumerate(lex):
            ranked[c["chunk_id"]] = ranked.get(c["chunk_id"], 0.0) + 1.0 / (60 + r)
        if self.vectors is not None:
            try:
                qv = self.embedder.embed([query], kind="query")[0]
                hits = self.vectors.search(self.collection, qv, limit * 2, session_id, doc_types, run_id)
                for r, h in enumerate(hits):
                    ranked[h.chunk_id] = ranked.get(h.chunk_id, 0.0) + 1.0 / (60 + r)
            except Exception as exc:
                self._degrade(exc)
        out = []
        for cid, score in sorted(ranked.items(), key=lambda kv: -kv[1]):
            c = self.store.get_chunk(cid)
            # Re-check scope from SQLite (defence in depth against a mis-scoped vector hit).
            if c is None or c["session_id"] not in (None, session_id) or c["run_id"] not in (None, run_id):
                continue
            if doc_types and c["doc_type"] not in doc_types:
                continue
            out.append(dict(c, score=round(score, 5)))
            if len(out) >= limit:
                break
        return out
