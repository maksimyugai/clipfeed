import "./env.d.ts";

const COUNTER_TTL_SECONDS = 48 * 60 * 60;

function dailyCounterKey(now: Date): string {
  return `llm_calls:${now.toISOString().slice(0, 10)}`;
}

// Best-effort daily budget for Anthropic calls. KV reads/writes aren't
// atomic, so concurrent requests can race past the limit by a small margin —
// acceptable for a personal, low-concurrency app; a hard guarantee would
// need a Durable Object.
export async function tryConsumeSummaryBudget(
  cache: KVNamespace,
  limit: number,
  now: Date = new Date(),
): Promise<boolean> {
  const key = dailyCounterKey(now);
  const current = await cache.get(key);
  const count = current ? Number(current) : 0;
  if (count >= limit) {
    return false;
  }
  await cache.put(key, String(count + 1), { expirationTtl: COUNTER_TTL_SECONDS });
  return true;
}
