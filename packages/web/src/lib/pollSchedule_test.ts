import { assertEquals } from "@std/assert";
import {
  FAST_INTERVAL_MS,
  FAST_PHASE_MS,
  GIVE_UP_AFTER_MS,
  nextPollDelayMs,
  pollReducer,
  SLOW_INTERVAL_MS,
} from "./pollSchedule.ts";

// --- nextPollDelayMs: interval schedule ---

Deno.test("nextPollDelayMs: at 0ms elapsed, uses the fast interval", () => {
  assertEquals(nextPollDelayMs(0), FAST_INTERVAL_MS);
});

Deno.test("nextPollDelayMs: just under the fast-phase boundary still uses the fast interval", () => {
  assertEquals(nextPollDelayMs(FAST_PHASE_MS - 1), FAST_INTERVAL_MS);
});

Deno.test("nextPollDelayMs: exactly at the fast-phase boundary switches to the slow interval", () => {
  assertEquals(nextPollDelayMs(FAST_PHASE_MS), SLOW_INTERVAL_MS);
});

Deno.test("nextPollDelayMs: mid slow phase still uses the slow interval", () => {
  assertEquals(nextPollDelayMs(FAST_PHASE_MS + 30_000), SLOW_INTERVAL_MS);
});

Deno.test("nextPollDelayMs: just under the give-up boundary still returns a delay", () => {
  assertEquals(nextPollDelayMs(GIVE_UP_AFTER_MS - 1), SLOW_INTERVAL_MS);
});

Deno.test("nextPollDelayMs: exactly at the give-up boundary returns null (no more polls)", () => {
  assertEquals(nextPollDelayMs(GIVE_UP_AFTER_MS), null);
});

Deno.test("nextPollDelayMs: past the give-up boundary returns null", () => {
  assertEquals(nextPollDelayMs(GIVE_UP_AFTER_MS + 60_000), null);
});

// --- pollReducer: give-up / resume state transitions ---

Deno.test("pollReducer: tick-still-pending within budget stays polling", () => {
  assertEquals(pollReducer("polling", { type: "tick-still-pending", elapsedMs: 0 }), "polling");
  assertEquals(
    pollReducer("polling", { type: "tick-still-pending", elapsedMs: FAST_PHASE_MS + 1 }),
    "polling",
  );
});

Deno.test("pollReducer: tick-still-pending past the give-up budget transitions to given-up", () => {
  assertEquals(
    pollReducer("polling", { type: "tick-still-pending", elapsedMs: GIVE_UP_AFTER_MS }),
    "given-up",
  );
});

Deno.test("pollReducer: tick-error transitions straight to given-up regardless of elapsed time", () => {
  assertEquals(pollReducer("polling", { type: "tick-error" }), "given-up");
});

Deno.test("pollReducer: manual-check-still-pending resumes polling from given-up", () => {
  assertEquals(pollReducer("given-up", { type: "manual-check-still-pending" }), "polling");
});

Deno.test("pollReducer: manual-check-still-pending is a no-op transition when already polling", () => {
  assertEquals(pollReducer("polling", { type: "manual-check-still-pending" }), "polling");
});

Deno.test("pollReducer: never returns a third state — give-up always has a way back to polling", () => {
  const allStates: ReturnType<typeof pollReducer>[] = [
    pollReducer("polling", { type: "tick-still-pending", elapsedMs: 0 }),
    pollReducer("polling", { type: "tick-still-pending", elapsedMs: GIVE_UP_AFTER_MS }),
    pollReducer("polling", { type: "tick-error" }),
    pollReducer("given-up", { type: "manual-check-still-pending" }),
  ];
  for (const s of allStates) {
    assertEquals(s === "polling" || s === "given-up", true);
  }
});
