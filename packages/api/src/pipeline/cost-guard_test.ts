import "../env.d.ts";
import { assertEquals } from "@std/assert";
import { readSummaryBudgetUsage, tryConsumeSummaryBudget } from "./cost-guard.ts";
import { FakeKv } from "../testing/fake_kv.ts";

const NOW = new Date("2026-01-01T12:00:00.000Z");

Deno.test("tryConsumeSummaryBudget: under the limit, consumes one and reports the new used count", async () => {
  const cache = new FakeKv();
  const result = await tryConsumeSummaryBudget(cache, 5, NOW);
  assertEquals(result, { ok: true, used: 1, limit: 5 });
});

Deno.test("tryConsumeSummaryBudget: at the limit, rejects and reports the current used count (unchanged)", async () => {
  const cache = new FakeKv();
  await cache.put("llm_calls:2026-01-01", "5");
  const result = await tryConsumeSummaryBudget(cache, 5, NOW);
  assertEquals(result, { ok: false, used: 5, limit: 5 });
});

Deno.test("tryConsumeSummaryBudget: successive calls increment used until the limit rejects", async () => {
  const cache = new FakeKv();
  const first = await tryConsumeSummaryBudget(cache, 2, NOW);
  const second = await tryConsumeSummaryBudget(cache, 2, NOW);
  const third = await tryConsumeSummaryBudget(cache, 2, NOW);
  assertEquals(first, { ok: true, used: 1, limit: 2 });
  assertEquals(second, { ok: true, used: 2, limit: 2 });
  assertEquals(third, { ok: false, used: 2, limit: 2 });
});

// --- readSummaryBudgetUsage: read-only, powers GET /api/admin/health-report ---

Deno.test("readSummaryBudgetUsage: reports 0 used when nothing has been consumed today", async () => {
  const cache = new FakeKv();
  assertEquals(await readSummaryBudgetUsage(cache, 50, NOW), { used: 0, limit: 50 });
});

Deno.test("readSummaryBudgetUsage: reflects the current counter without incrementing it", async () => {
  const cache = new FakeKv();
  await cache.put("llm_calls:2026-01-01", "12");
  assertEquals(await readSummaryBudgetUsage(cache, 50, NOW), { used: 12, limit: 50 });
  // Reading again doesn't change anything.
  assertEquals(await readSummaryBudgetUsage(cache, 50, NOW), { used: 12, limit: 50 });
});

Deno.test("readSummaryBudgetUsage: is keyed per UTC day, same as tryConsumeSummaryBudget", async () => {
  const cache = new FakeKv();
  await tryConsumeSummaryBudget(cache, 50, NOW);
  const nextDay = new Date("2026-01-02T00:00:01.000Z");
  assertEquals(await readSummaryBudgetUsage(cache, 50, nextDay), { used: 0, limit: 50 });
  assertEquals(await readSummaryBudgetUsage(cache, 50, NOW), { used: 1, limit: 50 });
});
