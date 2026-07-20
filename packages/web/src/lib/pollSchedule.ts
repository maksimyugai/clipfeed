// Pure polling-cadence/state-machine logic for a pending article card —
// kept separate from the DOM timers in ArticleCard.tsx so the schedule and
// give-up/resume transitions are unit-testable without mounting a component
// or faking setInterval. Queue pipelines legitimately run 1-4 minutes (a
// ~90s LLM call, possibly twice on a corrective retry) — polling faster at
// first (while a fast pipeline is the common case) and slower later (once
// it's clearly a longer run, cheaper to keep checking) covers that without
// hammering the API for the whole window.
export const FAST_INTERVAL_MS = 4_000;
export const FAST_PHASE_MS = 60_000;
export const SLOW_INTERVAL_MS = 10_000;
export const GIVE_UP_AFTER_MS = 6 * 60_000;

// Given total elapsed time since the current polling cycle started, returns
// the delay before the next poll — or null once the give-up budget
// (GIVE_UP_AFTER_MS) is exhausted, meaning no more automatic polls this
// cycle.
export function nextPollDelayMs(elapsedMs: number): number | null {
  if (elapsedMs >= GIVE_UP_AFTER_MS) return null;
  return elapsedMs < FAST_PHASE_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
}

export type PollState = "polling" | "given-up";

export type PollEvent =
  // A poll ran, the article is still pending, and this much time has
  // elapsed in the current cycle — decides whether to keep polling or give
  // up (never a dead end either way: "given-up" always has a Check-now
  // button back to "polling").
  | { type: "tick-still-pending"; elapsedMs: number }
  // A poll's fetch itself failed (network error) — treated as an
  // immediate give-up rather than silently retrying on a schedule, since a
  // fetch failure means the poll itself isn't working, not that the
  // pipeline is merely slow.
  | { type: "tick-error" }
  // The user's manual "Check now" found the article still pending —
  // resumes automatic polling for a fresh cycle (the caller resets its own
  // elapsed-time clock to 0 alongside this transition).
  | { type: "manual-check-still-pending" };

export function pollReducer(_state: PollState, event: PollEvent): PollState {
  switch (event.type) {
    case "tick-still-pending":
      return nextPollDelayMs(event.elapsedMs) === null ? "given-up" : "polling";
    case "tick-error":
      return "given-up";
    case "manual-check-still-pending":
      return "polling";
  }
}
