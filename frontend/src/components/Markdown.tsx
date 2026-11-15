"use client";

import { Fragment, type ReactNode } from "react";

import type { ChatRef } from "@/lib/chatApi";

/**
 * Minimal, safe Markdown: paragraphs, "-"/"1." lists, #-headings, **bold**, *italic*, `code`, and [n]
 * citation chips. Text is rendered as React text nodes only: no HTML, links or images from the model.
 */
export default function Markdown({ text, refs, onRef }: { text: string; refs: ChatRef[]; onRef: (r: ChatRef) => void }) {
  const byN = new Map(refs.map((r) => [r.n, r]));
  const inline = (s: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[\d{1,3}\])/g;
    let last = 0;
    let i = 0;
    for (const m of s.matchAll(re)) {
      if (m.index! > last) out.push(s.slice(last, m.index));
      const t = m[0];
      const k = `${key}-${i++}`;
      if (t.startsWith("**")) out.push(<strong key={k} className="font-semibold text-white">{t.slice(2, -2)}</strong>);
      else if (t.startsWith("`")) out.push(<code key={k} className="rounded bg-black/40 px-1 font-mono text-[11.5px]">{t.slice(1, -1)}</code>);
      else if (t.startsWith("[")) {
        const r = byN.get(Number(t.slice(1, -1)));
        out.push(
          r ? (
            <button
              key={k}
              type="button"
              onClick={() => onRef(r)}
              title={r.label}
              className={`mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded px-1 align-[1px] font-mono text-[10px] ${
                r.type === "computed" ? "bg-accent/15 text-accent hover:bg-accent/25" : "bg-earth/15 text-earth hover:bg-earth/25"
              }`}
            >
              {r.n}
            </button>
          ) : (
            <Fragment key={k} />
          ),
        );
      } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
      last = m.index! + t.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };

  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").replace(/\][ \t]+\[(?=\d)/g, "][").replace(/[ \t]+(\[\d{1,3}\])/g, "$1").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(" "), `p${blocks.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const k = `l${blocks.length}`;
    const items = list.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>);
    blocks.push(list.ordered ? <ol key={k} className="ml-4 list-decimal space-y-1 marker:text-faint">{items}</ol> : <ul key={k} className="ml-4 list-disc space-y-1 marker:text-faint">{items}</ul>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || num) {
      flushPara();
      const ordered = !!num;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? num)![1]);
    } else if (head) {
      flushPara();
      flushList();
      blocks.push(<p key={`h${blocks.length}`} className="font-medium text-text">{inline(head[1], `h${blocks.length}`)}</p>);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="space-y-2 text-text">{blocks}</div>;
}
