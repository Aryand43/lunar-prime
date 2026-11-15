// Client for the mission analyst (/api/chat/*). Responses stream as server-sent events over fetch,
// so a request can be cancelled with an AbortController. Mirrors backend/app/chat_api.py.

export interface ChatRef {
  n: number;
  ref: string;
  type: "computed" | "source" | "conversation";
  label: string;
  run_id?: string;
  path?: string;
  value?: unknown;
  mode?: string;
  url?: string | null;
  excerpt?: string;
  site_id?: string;
  category?: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "event";
  content: string;
  run_id: string | null;
  refs: ChatRef[];
  meta: {
    status?: string;
    error?: string | null;
    unverified_numbers?: string[];
    kind?: string;
    proposal_id?: string;
    base_run_id?: string;
    run_id?: string;
    tools?: { name: string; ok: boolean }[];
    tokens?: number;
  };
  created_at?: number;
}

export interface Proposal {
  proposal_id: string;
  base_run_id: string;
  changes: Record<string, unknown>;
  rationale: string;
  preflight: { great_circle_km: number; min_travel_hours: number; binding_constraints: string[] } | null;
}

export interface ChatStatus {
  enabled: boolean;
  reason: string | null;
  provider: string | null;
  model: string | null;
  retrieval: { available: boolean; embedder: string | null; vector_store: string | null; degraded: string | null };
  limits: { max_message_chars: number; messages_per_minute: number; token_budget_per_request: number };
}

export interface Session {
  session_id: string;
  token: string;
}

export type StreamEvent =
  | { event: "meta"; user_message_id: number; run_id: string | null }
  | { event: "delta"; text: string }
  | { event: "tool"; name: string; status: "running" | "done" | "error" }
  | ({ event: "proposal" } & Proposal)
  | { event: "error"; code: string; message: string; retryable?: boolean }
  | { event: "done"; message: ChatMessage };

export class ChatError extends Error {
  constructor(message: string, public code: string, public status = 0) {
    super(message);
  }
}

const KEY = "lunar-prime:analyst-session";

export function loadSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return typeof s.session_id === "string" && typeof s.token === "string" ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) window.localStorage.setItem(KEY, JSON.stringify(s));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the session lasts for this page only */
  }
}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: { error?: { code: string; message: string } } | null = null;
  try {
    body = await res.json();
  } catch {
    /* proxy error */
  }
  throw new ChatError(body?.error?.message ?? `Request failed (HTTP ${res.status}).`, body?.error?.code ?? "http_error", res.status);
}

const h = (s: Session) => ({ "x-session-token": s.token });

export async function chatStatus(signal?: AbortSignal): Promise<ChatStatus> {
  return json<ChatStatus>(await fetch("/api/chat/status", { signal, cache: "no-store" }));
}

export async function createSession(): Promise<Session> {
  return json<Session>(await fetch("/api/chat/sessions", { method: "POST" }));
}

export async function fetchMessages(s: Session, beforeId?: number, limit = 30) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (beforeId !== undefined) q.set("before_id", String(beforeId));
  return json<{ messages: ChatMessage[]; has_more: boolean; total: number }>(
    await fetch(`/api/chat/sessions/${s.session_id}/messages?${q}`, { headers: h(s), cache: "no-store" }),
  );
}

export async function deleteSession(s: Session) {
  return json<{ deleted: boolean }>(await fetch(`/api/chat/sessions/${s.session_id}`, { method: "DELETE", headers: h(s) }));
}

export async function runProposal(s: Session, proposalId: string) {
  return json<{ proposal_id: string; run_id: string; base_run_id: string; message: ChatMessage }>(
    await fetch(`/api/chat/sessions/${s.session_id}/proposals/${proposalId}/run`, { method: "POST", headers: h(s) }),
  );
}

export async function rejectProposal(s: Session, proposalId: string) {
  return json<{ status: string }>(
    await fetch(`/api/chat/sessions/${s.session_id}/proposals/${proposalId}/reject`, { method: "POST", headers: h(s) }),
  );
}

/** POST a message and dispatch each SSE event as it arrives. Rejects with AbortError when cancelled. */
export async function streamMessage(
  s: Session,
  content: string,
  runId: string | null,
  onEvent: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${s.session_id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...h(s) },
    body: JSON.stringify({ content, run_id: runId }),
    signal,
  });
  if (!res.ok || !res.body) await json(res);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let kind = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) kind = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!kind) continue;
      try {
        onEvent({ event: kind, ...JSON.parse(data) } as StreamEvent);
      } catch {
        /* ignore a malformed event */
      }
    }
  }
}
