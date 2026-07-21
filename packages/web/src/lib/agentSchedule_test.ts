import { assertEquals } from "@std/assert";
import { formatCountdown, nextAgentRunMs } from "./agentSchedule.ts";

// --- nextAgentRunMs ---

Deno.test("nextAgentRunMs - upcoming hour today is used as-is", () => {
  const now = new Date("2026-07-21T05:00:00.000Z");
  const next = nextAgentRunMs(9, now);
  assertEquals(new Date(next).toISOString(), "2026-07-21T09:00:00.000Z");
});

Deno.test("nextAgentRunMs - hour already passed today rolls over to tomorrow", () => {
  const now = new Date("2026-07-21T10:00:00.000Z");
  const next = nextAgentRunMs(9, now);
  assertEquals(new Date(next).toISOString(), "2026-07-22T09:00:00.000Z");
});

Deno.test("nextAgentRunMs - exactly at the hour rolls over (already ran this instant)", () => {
  const now = new Date("2026-07-21T09:00:00.000Z");
  const next = nextAgentRunMs(9, now);
  assertEquals(new Date(next).toISOString(), "2026-07-22T09:00:00.000Z");
});

Deno.test("nextAgentRunMs - works across a UTC month/year boundary", () => {
  const now = new Date("2025-12-31T23:30:00.000Z");
  const next = nextAgentRunMs(5, now);
  assertEquals(new Date(next).toISOString(), "2026-01-01T05:00:00.000Z");
});

Deno.test("nextAgentRunMs - is DST-safe: pure epoch arithmetic, unaffected by local-timezone offset changes", () => {
  // Regardless of what local timezone the test runner is in, the UTC-hour
  // target must always resolve to the same absolute instant.
  const now = new Date("2026-03-08T12:00:00.000Z"); // a US DST-transition date
  const next = nextAgentRunMs(5, now);
  assertEquals(new Date(next).toISOString(), "2026-03-09T05:00:00.000Z");
});

// --- formatCountdown ---

Deno.test("formatCountdown - hours and minutes both present", () => {
  const threeHoursTwelveMin = (3 * 60 + 12) * 60_000;
  assertEquals(formatCountdown(threeHoursTwelveMin), {
    hours: 3,
    minutes: 12,
    lessThanMinute: false,
  });
});

Deno.test("formatCountdown - minutes only, zero hours", () => {
  assertEquals(formatCountdown(45 * 60_000), { hours: 0, minutes: 45, lessThanMinute: false });
});

Deno.test("formatCountdown - rounds up to the next whole minute", () => {
  const oneMinuteOneSecond = 61_000;
  assertEquals(formatCountdown(oneMinuteOneSecond), {
    hours: 0,
    minutes: 2,
    lessThanMinute: false,
  });
});

Deno.test("formatCountdown - under a minute remaining -> lessThanMinute", () => {
  assertEquals(formatCountdown(30_000), { hours: 0, minutes: 0, lessThanMinute: true });
});

Deno.test("formatCountdown - zero or negative (already passed) -> lessThanMinute, never negative", () => {
  assertEquals(formatCountdown(0), { hours: 0, minutes: 0, lessThanMinute: true });
  assertEquals(formatCountdown(-5_000), { hours: 0, minutes: 0, lessThanMinute: true });
});

Deno.test("formatCountdown - exactly on an hour boundary", () => {
  assertEquals(formatCountdown(2 * 60 * 60_000), { hours: 2, minutes: 0, lessThanMinute: false });
});
