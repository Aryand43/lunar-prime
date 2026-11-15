import type { IntervalOut } from "./types";

/** What happens next to one body (Sun or Earth) at one site, seen from a given time. */
export interface NextChange {
  state: "up" | "down";
  secondsUntil: number; // time until the change, or until the window ends if beyondWindow
  atUtc: string | null; // time of the change; null if beyondWindow
  beyondWindow: boolean; // true when the change happens after the window ends
}

// Backend timestamps look like "2026-12-01T00:00:00Z" (SPICE et2utc ISOC + "Z"), which Date.parse reads as UTC.
const ms = (iso: string) => Date.parse(iso);

/**
 * Next rise or set of a body, from its refined visibility intervals.
 * Up: the change is the end of the current interval (or the window end, if the interval runs to it).
 * Down: the change is the start of the next interval (or the window end, if there is none).
 */
export function nextChange(intervals: IntervalOut[], nowUtc: string, windowEndUtc: string): NextChange {
  const now = ms(nowUtc);
  const end = ms(windowEndUtc);
  const toEnd = Math.max(0, (end - now) / 1000);

  // At the very last sample, an interval that runs to the window end still counts as "up".
  const current = intervals.find((iv) => {
    const s = ms(iv.start_utc);
    const e = ms(iv.end_utc);
    return s <= now && (now < e || (iv.ends_at_window_end && now <= e));
  });
  if (current) {
    if (current.ends_at_window_end) return { state: "up", secondsUntil: toEnd, atUtc: null, beyondWindow: true };
    return { state: "up", secondsUntil: Math.max(0, (ms(current.end_utc) - now) / 1000), atUtc: current.end_utc, beyondWindow: false };
  }
  const next = intervals.find((iv) => ms(iv.start_utc) > now);
  if (!next) return { state: "down", secondsUntil: toEnd, atUtc: null, beyondWindow: true };
  return { state: "down", secondsUntil: Math.max(0, (ms(next.start_utc) - now) / 1000), atUtc: next.start_utc, beyondWindow: false };
}
