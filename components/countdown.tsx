"use client";

import { useSecondClock, useTimeZone } from "@/components/clock";
import { type Urgency, formatWhen } from "@/lib/board";
import { countdownFull, relativeTime } from "@/lib/reminders";

/**
 * The live figure for a deadline: time left, to the second, or — once it has
 * passed — how long it has been overdue, said in words rather than by a sign.
 *
 * It subscribes to the one-second clock, so only this leaf re-renders each
 * second. On the server and during hydration the clock reads 0 and the coarse
 * `relativeTime` label renders instead, so both passes print the same text and
 * the seconds arrive a moment later with no layout pop.
 *
 * WHETHER it is overdue is not decided here. It is the board's `urgency`, from
 * the board's own clock — the one the counts and the order read, and which the
 * board ticks at the exact instant any deadline passes (`nextDeadlineAfter`).
 * Lucky35, 2026-09-29: when this leaf decided for itself, a card said
 * "Overdue" while the count beside it said nothing was — for up to half a
 * minute — and people trusted the count. One clock decides; this one only
 * counts. In the sliver where the two clocks straddle the deadline the figure
 * holds at 0:00:00 rather than contradict the word beside it.
 *
 * No live region: a politely announced region changing every second makes the
 * page unusable with a screen reader. The absolute deadline is on `title`.
 */
export function LiveCountdown({ deadline, urgency, now, size = "sm" }: { deadline: string; urgency: Urgency; now: Date; size?: "sm" | "lg" }) {
  const tick = useSecondClock();
  const zone = useTimeZone();
  const past = urgency === "overdue";
  const full = tick === 0 ? null : countdownFull(deadline, new Date(tick * 1000));
  const figure = full ? (full.past === past ? full.text : "0:00:00") : relativeTime(deadline, now);
  const absolute = formatWhen(deadline, zone);

  return (
    <span className="live-countdown" data-urgency={urgency} data-size={size} title={`Due ${absolute}`}>
      {past ? <span className="lc-word">Overdue</span> : null}
      <span className="lc-figure">{figure}</span>
      {!past && full ? <span className="lc-word">left</span> : null}
    </span>
  );
}
