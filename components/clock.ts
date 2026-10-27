"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

/* --- the one-second clock -------------------------------------------------

   A module-scope external store, not a piece of `Tracker` state. A per-second
   value held up in `Tracker` would re-render every controlled field on the
   board once a second. Here only the countdowns that subscribe re-render, and
   the 30s clock in `Tracker` — the one that drives ordering and the figures
   strip — is left completely alone. The seconds must never reach the ordering,
   or a task crossing its deadline would re-sort the track out from under a
   click.

   Everything that touches `document`, `window` or a timer lives INSIDE
   `subscribe`, which React never calls during SSR. A `document.addEventListener`
   at module scope is a `ReferenceError: document is not defined` at build time.
   -------------------------------------------------------------------------- */

/** Epoch SECONDS as an integer — not a `Date`, and never a fresh object. */
let snapshot = 0;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

/**
 * Recompute from the wall clock; never decrement a stored number. Browsers
 * throttle timers in a hidden tab and freeze them on sleep, so a decrementing
 * counter comes back minutes wrong. Re-reading on `visibilitychange` is what
 * makes the figure correct the instant the tab is looked at again.
 */
function readClock() {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds === snapshot) return;
  snapshot = seconds;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  // Seed before returning. React re-reads the snapshot immediately after
  // subscribing and re-renders if it moved, so seeding here resolves the figure
  // to seconds on the first frame after hydration instead of leaving it on the
  // coarse label for up to a whole second. Re-seeded whenever the clock starts
  // again, too: after every countdown has unmounted (a stay on "Done &
  // dismissed"), the value left behind is as old as that stay.
  if (listeners.size === 0) snapshot = Math.floor(Date.now() / 1000);

  listeners.add(listener);
  if (listeners.size === 1) {
    const handle = setInterval(readClock, 1_000);
    document.addEventListener("visibilitychange", readClock);
    stop = () => {
      clearInterval(handle);
      document.removeEventListener("visibilitychange", readClock);
    };
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

/**
 * The CACHED value. Returning a freshly-constructed one — `Date.now()`, a new
 * `Date` — hands React a different value on every read and loops for ever.
 */
function getSnapshot(): number {
  return snapshot;
}

/** The sentinel the server renders on. The server never renders a seconds figure. */
function getServerSnapshot(): number {
  return 0;
}

/**
 * Epoch seconds, ticking once a second — or 0 on the server and during
 * hydration, which is the caller's cue to render its coarse label instead, so
 * the server and the first client pass agree.
 */
export function useSecondClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* --- the person's time zone ------------------------------------------------

   Every time the board prints, and where "today" ends, is read in the person's
   own zone (`tt_profiles.timezone`) — never the machine's. The server renders
   in UTC and the browser wherever the person is; if the two render different
   text, React throws the server's page away on arrival (2026-09-30 audit).
   `Tracker` provides it, so no card or countdown has to be handed it.
   -------------------------------------------------------------------------- */

export const TimeZoneContext = createContext("UTC");

export function useTimeZone(): string {
  return useContext(TimeZoneContext);
}
