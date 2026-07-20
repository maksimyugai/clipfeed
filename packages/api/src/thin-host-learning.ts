import "./env.d.ts";

// A host crosses from "occasionally noisy" to "learned thin" after this
// many distinct 'extraction: insufficient text' failures — one bad article
// isn't enough evidence (could be a one-off thin post on an otherwise fine
// site), but a second confirms the pattern.
export const THIN_HOST_LEARN_THRESHOLD = 2;

// 30 days: long enough that an occasional agent run (daily, via
// AGENT_HOUR_UTC) still sees the accumulated count, short enough that a
// host which stops producing thin pages (a redesign, a different section
// linked) eventually falls back out of the learned list on its own instead
// of being blocked forever from one bad month.
const THIN_HOST_LEARN_TTL_SECONDS = 30 * 24 * 60 * 60;

function thinHostKey(host: string): string {
  return `thinhost:${host}`;
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Called on every 'extraction: insufficient text' failure — see
// pipeline.ts's MIN_EXTRACTED_TEXT_CHARS guard and healing.ts's backfill
// classification of pre-existing rows. Manual/extension/telegram-added
// articles call this too (the count itself doesn't distinguish added_via)
// — it's isLearnedThinHost's caller (the agent pool filter) that only ever
// consults this list for agent candidates, so manual saves are never
// blocked by what they teach the system (see that function's doc comment).
export async function recordThinHostFailure(cache: KVNamespace, url: string): Promise<void> {
  const host = hostname(url);
  if (!host) return;

  const key = thinHostKey(host);
  const current = Number(await cache.get(key)) || 0;
  const next = current + 1;
  await cache.put(key, String(next), { expirationTtl: THIN_HOST_LEARN_TTL_SECONDS });

  if (next === THIN_HOST_LEARN_THRESHOLD) {
    console.log(JSON.stringify({ event: "thinhost_learned", host, count: next }));
  }
}

// Consulted only by the agent's candidate-pool filter (agent-pool.ts) —
// never by manual/extension/telegram add paths, which is what makes
// "manual adds are never blocked by this list" true: this function only
// gets called from code that filters agent candidates in the first place.
export async function isLearnedThinHost(cache: KVNamespace, host: string): Promise<boolean> {
  const current = Number(await cache.get(thinHostKey(host))) || 0;
  return current >= THIN_HOST_LEARN_THRESHOLD;
}

export interface LearnedThinHost {
  host: string;
  count: number;
}

// Powers GET /api/admin/health-report — every host that's actually crossed
// the threshold (i.e. currently being filtered from the agent's candidate
// pool), sorted by count descending. A host still below the threshold
// isn't "learned" yet, so it's left out rather than shown as a false
// positive.
export async function listLearnedThinHosts(cache: KVNamespace): Promise<LearnedThinHost[]> {
  const learned: LearnedThinHost[] = [];
  let cursor: string | undefined;
  do {
    const page = await cache.list({ prefix: "thinhost:", cursor });
    for (const key of page.keys) {
      const count = Number(await cache.get(key.name)) || 0;
      if (count >= THIN_HOST_LEARN_THRESHOLD) {
        learned.push({ host: key.name.slice("thinhost:".length), count });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  learned.sort((a, b) => b.count - a.count);
  return learned;
}
