import "./env.d.ts";

// Task 36 Part B: run-level idempotency for the daily scraping agent.
// URL/title/semantic dedup (agent-pool.ts) already prevents duplicate
// ARTICLES within and across runs, but nothing previously prevented a
// second full BATCH from running on the same UTC day — a scheduled run at
// AGENT_HOUR_UTC plus a later manual /scrape (or POST /api/admin/agent/run)
// both fire the ranker and both save up to AGENT_DAILY_PICKS articles,
// doubling the day's total. This module tracks every completed run for the
// current UTC day in one KV key so the scheduled dispatch can skip a
// redundant run and manual triggers can warn the owner before running
// again anyway.

export type AgentRunTrigger = "scheduled" | "manual";

export interface AgentRunRecord {
  startedAt: string; // ISO instant
  picks: number; // articles actually inserted this run (see agent.ts's picksRun)
  trigger: AgentRunTrigger;
}

// Keeps only the most recent runs — a day with more than this many
// invocations is already a signal something's being triggered in a loop,
// and there's no need to keep every single one for the health-report to
// stay useful.
const MAX_HISTORY = 5;
const RUN_MARKER_TTL_SECONDS = 48 * 60 * 60;

function agentRunKey(utcDate: string): string {
  return `agentrun:${utcDate}`;
}

// UTC calendar date, not the local/instance clock — matches the marker's
// stated "UTC date" contract and AGENT_HOUR_UTC's own UTC-only semantics.
export function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// Formats an ISO instant as "HH:MM" UTC — used in the owner-facing warning
// (e.g. "10 статей в 05:00 UTC") so it names a clock time, not a raw
// timestamp.
export function formatUtcHourMinute(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Reads today's run history — empty array when nothing has run yet today,
// or when the stored value is missing/malformed (treated as "no runs",
// never a throw: a corrupted marker must not block a legitimate run).
export async function readAgentRunHistory(
  cache: KVNamespace,
  now: Date = new Date(),
): Promise<AgentRunRecord[]> {
  const raw = await cache.get(agentRunKey(utcDateString(now)));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as AgentRunRecord[] : [];
  } catch {
    return [];
  }
}

export async function hasRunToday(cache: KVNamespace, now: Date = new Date()): Promise<boolean> {
  return (await readAgentRunHistory(cache, now)).length > 0;
}

// Appends one completed run to today's history (capped at MAX_HISTORY,
// oldest dropped first) and writes it back with a fresh 48h TTL — called
// once, at the end of a successful runAgentJob (see agent.ts), never before
// a run starts, so a run that throws partway through never gets recorded
// as having completed.
export async function recordAgentRun(
  cache: KVNamespace,
  record: AgentRunRecord,
  now: Date = new Date(),
): Promise<void> {
  const existing = await readAgentRunHistory(cache, now);
  const next = [...existing, record].slice(-MAX_HISTORY);
  await cache.put(agentRunKey(utcDateString(now)), JSON.stringify(next), {
    expirationTtl: RUN_MARKER_TTL_SECONDS,
  });
}
