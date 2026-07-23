import "../env.d.ts";
import type { FailureClassification } from "../../../shared/src/classify-failure.ts";
import { hostname } from "../lib/url-host.ts";

// Task 33 §7: KV-only auto-learned blocks, structurally separate from
// manual policy (blocklist.json/curation.json, both in git). Automation
// writes ONLY `autostat:<domain>`/`autoblock:<domain>` keys — no code path
// outside this module and index.ts's admin endpoints ever touches them
// (see the isolation assertion test in autoblock_test.ts), so neither
// mechanism can overwrite the other by construction.

export const DEFAULT_AUTOBLOCK_THRESHOLD = 3;
export const DEFAULT_AUTOBLOCK_TTL_DAYS = 60;

// [vars] strings, parsed defensively — same "missing/invalid -> logged
// warning + safe default" convention as ranking.ts's parseAgentDailyPicks.
export function parseAutoblockThreshold(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_AUTOBLOCK_THRESHOLD;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(JSON.stringify({
      event: "autoblock_threshold_invalid",
      raw: trimmed,
      fallback: DEFAULT_AUTOBLOCK_THRESHOLD,
    }));
    return DEFAULT_AUTOBLOCK_THRESHOLD;
  }
  return Math.round(n);
}

export function parseAutoblockTtlDays(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_AUTOBLOCK_TTL_DAYS;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(JSON.stringify({
      event: "autoblock_ttl_days_invalid",
      raw: trimmed,
      fallback: DEFAULT_AUTOBLOCK_TTL_DAYS,
    }));
    return DEFAULT_AUTOBLOCK_TTL_DAYS;
  }
  return Math.round(n);
}

function autostatKey(domain: string): string {
  return `autostat:${domain}`;
}

function autoblockKey(domain: string): string {
  return `autoblock:${domain}`;
}

// Signal weight per a classified pipeline failure. Extraction 'insufficient
// text' and fetch 402/403 (paywall) both contribute +1 — a domain that
// keeps yielding either is a real, repeatable signal that scraping it is a
// waste. Transient failures (5xx/timeouts, classifyFailure's 'transient'
// class) contribute +0 deliberately: an outage or a slow response is
// evidence the UPSTREAM had a bad moment, not that the domain is
// structurally unusable — scoring it would eventually auto-block any
// flaky-but-otherwise-fine source given enough traffic and no way to tell
// the two cases apart after the fact.
export function autoblockSignalWeight(classification: FailureClassification): number {
  if (classification.class !== "permanent") return 0;
  return classification.permanentReasonKey === "insufficient_text" ||
      classification.permanentReasonKey === "paywalled"
    ? 1
    : 0;
}

// Records one signal (if it counts — see autoblockSignalWeight) against the
// URL's host, and promotes it to a full autoblock entry once the
// accumulated score reaches `threshold`. Both keys share `ttlDays`'s TTL,
// refreshed on every write — an autostat counter for a domain that's gone
// quiet, or a firmly-autoblocked domain, both age out and rehabilitate
// automatically rather than needing manual cleanup.
export async function recordAutoBlockSignal(
  cache: KVNamespace,
  url: string,
  classification: FailureClassification,
  threshold: number,
  ttlDays: number,
  now: Date = new Date(),
): Promise<void> {
  const weight = autoblockSignalWeight(classification);
  if (weight <= 0) return;
  const host = hostname(url);
  if (!host) return;

  const ttlSeconds = ttlDays * 24 * 60 * 60;
  const statKey = autostatKey(host);
  const current = Number(await cache.get(statKey)) || 0;
  const next = current + weight;
  await cache.put(statKey, String(next), { expirationTtl: ttlSeconds });

  if (next < threshold) return;

  const blockKey = autoblockKey(host);
  const existingRaw = await cache.get(blockKey);
  let firstSeen = now.toISOString();
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as { firstSeen?: string };
      if (existing.firstSeen) firstSeen = existing.firstSeen;
    } catch {
      // Malformed existing entry — treat this signal as a fresh block.
    }
  }
  await cache.put(
    blockKey,
    JSON.stringify({ firstSeen, score: next, lastReason: classification.reason }),
    { expirationTtl: ttlSeconds },
  );
  if (!existingRaw) {
    console.log(JSON.stringify({
      event: "autoblock_learned",
      host,
      score: next,
      reason: classification.reason,
    }));
  }
}

export async function isAutoBlocked(cache: KVNamespace, host: string): Promise<boolean> {
  return (await cache.get(autoblockKey(host))) !== null;
}

export interface AutoBlockEntry {
  domain: string;
  score: number;
  reason: string;
  firstSeen: string;
  expiresAt: string | null;
}

// Enumerates every currently-active autoblock entry — used by the admin
// GET /api/admin/curation/blocked endpoint and the agent pool's blocklist
// filter (fetched once per run, then checked in-memory per candidate,
// rather than one KV get per candidate).
export async function listAutoBlocks(cache: KVNamespace): Promise<AutoBlockEntry[]> {
  const entries: AutoBlockEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await cache.list({ prefix: "autoblock:", cursor });
    for (const key of page.keys) {
      const raw = await cache.get(key.name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { firstSeen: string; score: number; lastReason: string };
        entries.push({
          domain: key.name.slice("autoblock:".length),
          score: parsed.score,
          reason: parsed.lastReason,
          firstSeen: parsed.firstSeen,
          expiresAt: key.expiration ? new Date(key.expiration * 1000).toISOString() : null,
        });
      } catch {
        continue;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  entries.sort((a, b) => b.score - a.score);
  return entries;
}

// DELETE /api/admin/curation/autoblock: immediate false-positive relief.
// Clears BOTH the autoblock entry and its underlying autostat counter — if
// only the block entry were cleared, the next single new signal (score
// already at/above threshold) would instantly re-autoblock the domain,
// defeating the point of a manual override.
export async function clearAutoBlock(cache: KVNamespace, host: string): Promise<void> {
  await cache.delete(autoblockKey(host));
  await cache.delete(autostatKey(host));
}
