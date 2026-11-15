"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ChatError, chatStatus, createSession, deleteSession, fetchMessages, loadSession, rejectProposal, runProposal,
  saveSession, streamMessage, type ChatMessage, type ChatRef, type ChatStatus, type Proposal, type Session,
} from "@/lib/chatApi";
import Markdown from "./Markdown";

const SUGGESTIONS = [
  "Why was this route chosen?",
  "Why is it longer than the baseline?",
  "Where is the longest darkness interval?",
  "Which inputs limit feasibility?",
  "What changes if I depart a day later?",
  "What does Earth visibility mean here?",
];

const TOOL_LABEL: Record<string, string> = {
  get_run_summary: "Reading run summary",
  get_route_segments: "Reading segments",
  get_baseline_comparison: "Reading baseline comparison",
  get_visibility_intervals: "Computing visibility intervals",
  get_site_details: "Reading site record",
  search_documents: "Searching documentation",
  list_session_runs: "Listing runs",
  propose_comparison: "Preparing a comparison proposal",
};

const shortRun = (id: string | null) => (id ? `·${id.slice(-6)}` : "none");

function RefList({ refs, onRef }: { refs: ChatRef[]; onRef: (r: ChatRef) => void }) {
  const [open, setOpen] = useState(false);
  if (!refs.length) return null;
  const computed = refs.filter((r) => r.type === "computed").length;
  const docs = refs.length - computed;
  const summary = [computed ? `${computed} computed` : "", docs ? `${docs} source${docs > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="mt-1.5">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-[10.5px] text-faint hover:text-muted">
        {open ? "▾" : "▸"} References ({summary})
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5">
          {refs.map((r) => (
            <li key={r.n}>
              <button
                type="button"
                onClick={() => onRef(r)}
                title={r.excerpt ?? r.label}
                className={`flex max-w-full items-baseline gap-1.5 text-left text-[10.5px] hover:underline ${r.type === "computed" ? "text-accent" : "text-earth"}`}
              >
                <span className="font-mono">[{r.n}]</span>
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 text-faint">{r.type === "computed" ? "computed" : "source"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MissionAnalyst({
  runId, runFresh, onOpenRun, onRef, onClose,
}: {
  /** The run currently shown; new questions are bound to it. */
  runId: string | null;
  /** False when inputs changed since that run (the displayed result is stale). */
  runFresh: boolean;
  onOpenRun: (runId: string) => void;
  onRef: (r: ChatRef) => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<{ text: string; tool: string | null; runId: string | null; question: string } | null>(null);
  const [proposals, setProposals] = useState<(Proposal & { state: "pending" | "running" | "done" | "dismissed" | "failed"; error?: string })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const maxChars = status?.limits.max_message_chars ?? 4000;

  useEffect(() => {
    const ac = new AbortController();
    chatStatus(ac.signal).then(setStatus).catch((e) => (e as Error).name !== "AbortError" && setStatusErr("Analyst status unavailable."));
    const s = loadSession();
    if (s) {
      fetchMessages(s)
        .then((page) => {
          setSession(s);
          setMsgs(page.messages);
          setHasMore(page.has_more);
        })
        .catch(() => saveSession(null)); // expired or deleted session: start fresh on the next question
    }
    return () => {
      ac.abort();
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, streaming?.text, proposals.length]);

  const ensureSession = useCallback(async () => {
    if (session) return session;
    const s = await createSession();
    saveSession(s);
    setSession(s);
    return s;
  }, [session]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || streaming || q.length > maxChars) return;
    setError(null);
    setDraft("");
    const ac = new AbortController();
    abortRef.current = ac;
    const boundRun = runId; // binding is fixed at send time; later runs never change it
    setStreaming({ text: "", tool: null, runId: boundRun, question: q });
    let userMsg: ChatMessage | null = null;
    try {
      const s = await ensureSession();
      await streamMessage(s, q, boundRun, (ev) => {
        if (ev.event === "meta") {
          userMsg = { id: ev.user_message_id, role: "user", content: q, run_id: boundRun, refs: [], meta: {} };
          setMsgs((m) => [...m, userMsg!]);
        } else if (ev.event === "delta") setStreaming((st) => (st ? { ...st, text: st.text + ev.text } : st));
        else if (ev.event === "tool") setStreaming((st) => (st ? { ...st, tool: ev.status === "running" ? ev.name : null } : st));
        else if (ev.event === "proposal") setProposals((p) => [...p, { ...ev, state: "pending" }]);
        else if (ev.event === "error") setError(ev.message);
        else if (ev.event === "done") setMsgs((m) => [...m, ev.message]);
      }, ac.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // The server keeps the partial answer marked as cancelled; refresh the tail to show it.
        if (session) fetchMessages(session).then((p) => setMsgs(p.messages)).catch(() => undefined);
      } else if (e instanceof ChatError && e.code === "session_not_found") {
        saveSession(null);
        setSession(null);
        setError("This conversation is no longer available. Ask again to start a new one.");
      } else setError(e instanceof Error ? e.message : "The analyst request failed.");
      if (!userMsg) setDraft(q);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setStreaming(null);
    }
  };

  const loadOlder = async () => {
    if (!session || !msgs.length) return;
    const page = await fetchMessages(session, msgs[0].id);
    setMsgs((m) => [...page.messages, ...m]);
    setHasMore(page.has_more);
  };

  const newChat = async (del: boolean) => {
    abortRef.current?.abort();
    if (del && session) await deleteSession(session).catch(() => undefined);
    saveSession(null);
    setSession(null);
    setMsgs([]);
    setProposals([]);
    setHasMore(false);
    setError(null);
  };

  const decide = async (p: Proposal, approve: boolean) => {
    if (!session) return;
    setProposals((all) => all.map((x) => (x.proposal_id === p.proposal_id ? { ...x, state: approve ? "running" : "dismissed" } : x)));
    try {
      if (!approve) return void (await rejectProposal(session, p.proposal_id));
      const r = await runProposal(session, p.proposal_id);
      setMsgs((m) => [...m, r.message]);
      setProposals((all) => all.map((x) => (x.proposal_id === p.proposal_id ? { ...x, state: "done" } : x)));
    } catch (e) {
      setProposals((all) => all.map((x) => (x.proposal_id === p.proposal_id ? { ...x, state: "failed", error: (e as Error).message } : x)));
    }
  };

  const disabled = status !== null && !status.enabled;
  // Hide raw citation markers while streaming (they may contain one level of brackets).
  const liveText = streaming?.text.replace(/\[ref:(?:[^[\]\s]|\[[^[\]]*\])*\]?/g, "") ?? "";

  return (
    <aside aria-label="Mission analyst" className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium">Mission analyst</h2>
          <p className="truncate text-[10.5px] text-faint">
            {runId ? <>Questions about run <span className="font-mono text-muted">{shortRun(runId)}</span>{!runFresh && <span className="text-sun"> · inputs changed since</span>}</> : "No run yet: answers use documentation only"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {session && (
            <>
              <button type="button" onClick={() => newChat(false)} className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-text" title="Start a new conversation (this one stays saved)">New</button>
              <button type="button" onClick={() => confirm("Delete this conversation and its indexed summaries?") && newChat(true)} className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-danger">Delete</button>
            </>
          )}
          <button type="button" onClick={onClose} aria-label="Close analyst" className="rounded px-1.5 text-[15px] text-faint hover:text-text">×</button>
        </div>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-[12.5px] leading-relaxed" aria-live="polite">
        {disabled && (
          <div role="status" className="rounded border border-line bg-panel-2 p-2.5 text-[12px] text-muted">
            <p className="font-medium text-text">Analyst unavailable</p>
            <p className="mt-0.5">{status?.reason}</p>
          </div>
        )}
        {statusErr && <p className="text-[12px] text-danger">{statusErr}</p>}
        {hasMore && (
          <button type="button" onClick={loadOlder} className="mx-auto block rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-text">Load earlier messages</button>
        )}
        {!msgs.length && !streaming && !disabled && (
          <div className="space-y-2">
            <p className="text-[12px] text-muted">Ask about the computed route. Numbers come from the stored run; untested what-ifs are proposed as comparison runs you approve.</p>
            <div className="flex flex-wrap gap-1">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} disabled={!status?.enabled} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent/50 hover:text-text disabled:opacity-40">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="ml-6 rounded-md bg-panel-2 px-2.5 py-1.5">
              <p className="whitespace-pre-wrap text-text">{m.content}</p>
              <p className="mt-0.5 text-right font-mono text-[9.5px] text-faint">
                run {shortRun(m.run_id)}{m.run_id && m.run_id !== runId ? " · earlier run" : ""}
              </p>
            </div>
          ) : m.role === "event" ? (
            <div key={m.id} className="rounded-md border border-accent/30 bg-accent/[0.05] px-2.5 py-2">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-accent">Comparison run · deterministic</p>
              <Markdown text={m.content} refs={m.refs} onRef={onRef} />
              {m.meta.kind === "comparison_result" && m.run_id && (
                <button type="button" onClick={() => onOpenRun(m.run_id!)} className="mt-1.5 rounded border border-accent/40 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/10">
                  Show this run on the globe
                </button>
              )}
            </div>
          ) : (
            <div key={m.id} className="border-l-2 border-accent/40 pl-2.5">
              <Markdown text={m.content || "_(no answer)_"} refs={m.refs} onRef={onRef} />
              <RefList refs={m.refs} onRef={onRef} />
              {(m.meta.unverified_numbers?.length ?? 0) > 0 && (
                <p className="mt-1 text-[10.5px] text-sun">Not matched to computed data: {m.meta.unverified_numbers!.join(", ")}. Treat these as unverified.</p>
              )}
              {m.meta.status && m.meta.status !== "complete" && <p className="mt-1 text-[10.5px] text-faint">{m.meta.error ?? m.meta.status}</p>}
            </div>
          ),
        )}
        {streaming && (
          <div>
            {liveText ? <Markdown text={liveText} refs={[]} onRef={onRef} /> : <p className="text-faint">Thinking…</p>}
            {streaming.tool && <p className="mt-1 text-[11px] text-muted">{TOOL_LABEL[streaming.tool] ?? streaming.tool}…</p>}
          </div>
        )}
        {proposals.filter((p) => p.state !== "dismissed").map((p) => (
          <div key={p.proposal_id} className="rounded-md border border-sun/40 bg-sun/[0.05] p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-sun">Proposed comparison · not yet simulated</p>
            <ul className="mt-1 font-mono text-[11px] text-text">
              {Object.entries(p.changes).map(([k, v]) => (
                <li key={k}>{k} → {JSON.stringify(v)}</li>
              ))}
            </ul>
            {p.rationale && <p className="mt-1 text-[11.5px] text-muted">{p.rationale}</p>}
            {p.preflight && <p className="mt-1 font-mono text-[10.5px] text-faint">≥ {p.preflight.min_travel_hours.toFixed(1)} h travel · same planner limits</p>}
            {p.state === "pending" && (
              <div className="mt-2 flex gap-1.5">
                <button type="button" onClick={() => decide(p, true)} className="rounded bg-sun px-2 py-1 text-[11px] font-medium text-black hover:opacity-90">Run comparison</button>
                <button type="button" onClick={() => decide(p, false)} className="rounded border border-line px-2 py-1 text-[11px] text-muted hover:text-text">Dismiss</button>
              </div>
            )}
            {p.state === "running" && <p className="mt-1 text-[11px] text-muted">Running with the same planner…</p>}
            {p.state === "failed" && <p className="mt-1 text-[11px] text-danger">{p.error}</p>}
          </div>
        ))}
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>

      <form
        className="border-t border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <textarea
          aria-label="Ask the mission analyst"
          rows={2}
          value={draft}
          disabled={disabled}
          maxLength={maxChars}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
          placeholder={disabled ? "Analyst unavailable" : runId ? "Ask about this run…" : "Ask about the method…"}
          className="w-full resize-none rounded border border-line bg-panel-2 px-2 py-1.5 text-[12.5px] text-text placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10px] text-faint">{draft.length > maxChars * 0.8 ? `${draft.length}/${maxChars}` : "Enter to send · Shift+Enter for a new line"}</span>
          {streaming ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="rounded border border-line px-2 py-0.5 text-[11px] text-text hover:border-danger/60">Stop</button>
          ) : (
            <button type="submit" disabled={!draft.trim() || disabled} className="rounded bg-accent px-2.5 py-0.5 text-[11px] font-medium text-black hover:opacity-90 disabled:opacity-40">Send</button>
          )}
        </div>
      </form>
    </aside>
  );
}
