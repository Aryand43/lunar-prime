"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { fmtUtc } from "@/lib/format";
import type { CompareResponse } from "@/lib/types";

interface Props {
  result: CompareResponse;
  index: number;
  onIndex: (i: number) => void;
}

const PLAY_SECONDS = 24; // wall-clock time to play the whole window

/** 12 px playback icons drawn with currentColor. */
export function Icon({ name }: { name: "play" | "pause" | "prev" | "next" | "back" | "fwd" }) {
  const p = {
    play: <path d="M2 1l9 5-9 5z" />,
    pause: <path d="M2 1h3v10H2zM7 1h3v10H7z" />,
    prev: <path d="M2 1v10M12 1L5 6l7 5z" stroke="currentColor" strokeWidth={1.6} />,
    next: <path d="M12 1v10M2 1l7 5-7 5z" stroke="currentColor" strokeWidth={1.6} />,
    back: <path d="M7 1L2 6l5 5" fill="none" stroke="currentColor" strokeWidth={1.8} />,
    fwd: <path d="M1 1l5 5-5 5" fill="none" stroke="currentColor" strokeWidth={1.8} />,
  }[name];
  return (
    <svg width={12} height={12} viewBox="0 0 13 12" fill="currentColor" aria-hidden>
      {p}
    </svg>
  );
}

const btn =
  "flex h-7 min-w-7 items-center justify-center rounded-[2px] border border-line bg-field px-1.5 text-text hover:border-text disabled:opacity-40";

export default function Scrubber({ result, index, onIndex }: Props) {
  const n = result.timestamps_utc.length;
  const [playing, setPlaying] = useState(false);
  const idxRef = useRef(index);
  useEffect(() => {
    idxRef.current = index;
  }, [index]);

  // Sample indices where any visibility state changes at either site (for event jumping).
  const events = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < n; i++) {
      for (const s of result.sites) {
        if (s.masks.sun[i] !== s.masks.sun[i - 1] || s.masks.earth[i] !== s.masks.earth[i - 1]) {
          out.push(i);
          break;
        }
      }
    }
    return out;
  }, [result, n]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = idxRef.current;
    const rate = n / PLAY_SECONDS;
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * rate;
      last = now;
      const next = Math.floor(acc);
      if (next >= n - 1) {
        onIndex(n - 1);
        setPlaying(false);
        return;
      }
      if (next !== idxRef.current) onIndex(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, n, onIndex]);

  const prevEvent = [...events].reverse().find((e) => e < index);
  const nextEvent = events.find((e) => e > index);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-line bg-bg/95 py-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={btn}
          onClick={() => {
            if (!playing && index >= n - 1) onIndex(0);
            setPlaying((p) => !p);
          }}
          aria-label={playing ? "Pause playback" : "Play through the window"}
        >
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button type="button" className={btn} disabled={prevEvent === undefined} onClick={() => prevEvent !== undefined && onIndex(prevEvent)} aria-label="Jump to previous rise or set event" title="Previous rise/set event">
          <Icon name="prev" />
        </button>
        <button type="button" className={btn} disabled={index <= 0} onClick={() => onIndex(Math.max(0, index - 1))} aria-label="Previous sample">
          <Icon name="back" />
        </button>
        <button type="button" className={btn} disabled={index >= n - 1} onClick={() => onIndex(Math.min(n - 1, index + 1))} aria-label="Next sample">
          <Icon name="fwd" />
        </button>
        <button type="button" className={btn} disabled={nextEvent === undefined} onClick={() => nextEvent !== undefined && onIndex(nextEvent)} aria-label="Jump to next rise or set event" title="Next rise/set event">
          <Icon name="next" />
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={n - 1}
        step={1}
        value={index}
        onChange={(e) => {
          setPlaying(false);
          onIndex(Number(e.target.value));
        }}
        className="min-w-[160px] flex-1"
        aria-label="Simulation time"
        aria-valuetext={fmtUtc(result.timestamps_utc[index])}
      />
      {result.metadata.starts_differ ? (
        <div className="flex flex-wrap items-baseline gap-x-3 text-[13px] tabular-nums">
          <span className="font-bold text-text">day {(result.elapsed_s[index] / 86400).toFixed(1)}</span>
          <span className="text-text"><b>A</b> {fmtUtc(result.sites[0].timestamps_utc[index])}</span>
          <span className="text-text"><b>B</b> {fmtUtc(result.sites[1].timestamps_utc[index])}</span>
        </div>
      ) : (
        <div className="flex items-baseline gap-2 text-[13px] tabular-nums">
        <span className="text-text">{fmtUtc(result.timestamps_utc[index])}</span>
        <span className="text-muted">day {(result.elapsed_s[index] / 86400).toFixed(1)}</span>
      </div>
      )}
    </div>
  );
}
