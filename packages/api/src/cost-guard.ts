import "./env.d.ts";

const COUNTER_TTL_SECONDS = 48 * 60 * 60;

function dailyCounterKey(now: Date): string {
  return `llm_calls:${now.toISOString().slice(0, 10)}`;
}

export interface BudgetCheckResult {
  ok: boolean;
  // Calls already made today (before this one) — what the caller needs to
  // log `used`/`limit` on an exhausted check (see pipeline.ts's budget
  // stage), since a silent same-second fetch->extract->done run with no
  // summarize stage was previously indistinguishable from any other
  // fast-failing pipeline without checking KV directly.
  used: number;
  limit: number;
}

// Best-effort daily budget for Anthropic calls. KV reads/writes aren't
// atomic, so concurrent requests can race past the limit by a small margin —
// acceptable for a personal, low-concurrency app; a hard guarantee would
// need a Durable Object.
export async function tryConsumeSummaryBudget(
  cache: KVNamespace,
  limit: number,
  now: Date = new Date(),
): Promise<BudgetCheckResult> {
  const key = dailyCounterKey(now);
  const current = await cache.get(key);
  const count = current ? Number(current) : 0;
  if (count >= limit) {
    return { ok: false, used: count, limit };
  }
  await cache.put(key, String(count + 1), { expirationTtl: COUNTER_TTL_SECONDS });
  return { ok: true, used: count + 1, limit };
}

// Today's usage, read-only — powers GET /api/admin/health-report's
// llm_calls block. Never increments the counter.
export async function readSummaryBudgetUsage(
  cache: KVNamespace,
  limit: number,
  now: Date = new Date(),
): Promise<{ used: number; limit: number }> {
  const current = await cache.get(dailyCounterKey(now));
  return { used: current ? Number(current) : 0, limit };
}
