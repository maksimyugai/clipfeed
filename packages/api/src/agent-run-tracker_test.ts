import "./env.d.ts";
import { assertEquals } from "@std/assert";
import {
  type AgentRunRecord,
  formatUtcHourMinute,
  hasRunToday,
  readAgentRunHistory,
  recordAgentRun,
  utcDateString,
} from "./agent-run-tracker.ts";

class FakeKV {
  store = new Map<string, { value: string; expirationTtl?: number }>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key)?.value ?? null);
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

const DAY1 = new Date("2026-07-23T05:00:00.000Z");
const RECORD_1: AgentRunRecord = {
  startedAt: "2026-07-23T05:00:48.000Z",
  picks: 10,
  trigger: "scheduled",
};
const RECORD_2: AgentRunRecord = {
  startedAt: "2026-07-23T08:47:33.000Z",
  picks: 10,
  trigger: "manual",
};

// --- utcDateString / formatUtcHourMinute ---

Deno.test("utcDateString: formats the UTC calendar date, not local time", () => {
  assertEquals(utcDateString(new Date("2026-07-23T23:59:59.000Z")), "2026-07-23");
  assertEquals(utcDateString(new Date("2026-01-01T00:00:00.000Z")), "2026-01-01");
});

Deno.test("formatUtcHourMinute: formats HH:MM, zero-padded", () => {
  assertEquals(formatUtcHourMinute("2026-07-23T05:00:48.000Z"), "05:00");
  assertEquals(formatUtcHourMinute("2026-07-23T08:47:33.000Z"), "08:47");
  assertEquals(formatUtcHourMinute("2026-07-23T23:05:00.000Z"), "23:05");
});

// --- readAgentRunHistory / hasRunToday ---

Deno.test("readAgentRunHistory: empty when nothing has run today", async () => {
  const cache = new FakeKV() as unknown as KVNamespace;
  assertEquals(await readAgentRunHistory(cache, DAY1), []);
  assertEquals(await hasRunToday(cache, DAY1), false);
});

Deno.test("readAgentRunHistory: malformed stored value is treated as empty, not a throw", async () => {
  const cache = new FakeKV() as unknown as KVNamespace;
  await cache.put(`agentrun:${utcDateString(DAY1)}`, "not json");
  assertEquals(await readAgentRunHistory(cache, DAY1), []);
});

Deno.test("readAgentRunHistory: a non-array JSON value is treated as empty", async () => {
  const cache = new FakeKV() as unknown as KVNamespace;
  await cache.put(`agentrun:${utcDateString(DAY1)}`, JSON.stringify({ not: "an array" }));
  assertEquals(await readAgentRunHistory(cache, DAY1), []);
});

// --- recordAgentRun ---

Deno.test("recordAgentRun: writes a single run, readable back, hasRunToday true", async () => {
  const cache = new FakeKV() as unknown as KVNamespace;
  await recordAgentRun(cache, RECORD_1, DAY1);
  assertEquals(await readAgentRunHistory(cache, DAY1), [RECORD_1]);
  assertEquals(await hasRunToday(cache, DAY1), true);
});

Deno.test("recordAgentRun: a second run the same day appends, doesn't overwrite the first", async () => {
  const cache = new FakeKV() as unknown as KVNamespace;
  await recordAgentRun(cache, RECORD_1, DAY1);
  await recordAgentRun(cache, RECORD_2, DAY1);
  assertEquals(await readAgentRunHistory(cache, DAY1), [RECORD_1, RECORD_2]);
});

Deno.test("recordAgentRun: writes with a 48h TTL", async () => {
  const kv = new FakeKV();
  await recordAgentRun(kv as unknown as KVNamespace, RECORD_1, DAY1);
  const stored = kv.store.get(`agentrun:${utcDateString(DAY1)}`);
  assertEquals(stored?.expirationTtl, 48 * 60 * 60);
});

Deno.test("recordAgentRun: a run on a different UTC date writes a separate key, doesn't affect the other day's history", async () => {
  const cache = new FakeKV() as unknown as KVNamespace;
  await recordAgentRun(cache, RECORD_1, DAY1);
  const day2 = new Date("2026-07-24T05:00:00.000Z");
  await recordAgentRun(cache, RECORD_2, day2);
  assertEquals(await readAgentRunHistory(cache, DAY1), [RECORD_1]);
  assertEquals(await readAgentRunHistory(cache, day2), [RECORD_2]);
});

Deno.test("recordAgentRun: history is capped at 5, oldest dropped first", async () => {
  const cache = new FakeKV() as unknown as KVNamespace;
  for (let i = 0; i < 7; i++) {
    await recordAgentRun(cache, {
      startedAt: `2026-07-23T0${i}:00:00.000Z`,
      picks: i,
      trigger: "manual",
    }, DAY1);
  }
  const history = await readAgentRunHistory(cache, DAY1);
  assertEquals(history.length, 5);
  // The two oldest (picks 0 and 1) were dropped — the surviving list starts
  // at picks 2 and ends at picks 6.
  assertEquals(history.map((r) => r.picks), [2, 3, 4, 5, 6]);
});
