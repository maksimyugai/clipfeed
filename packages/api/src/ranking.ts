import "./env.d.ts";
import type { Candidate } from "./agent-types.ts";
import { callLlm, stripJsonFences } from "./summarize.ts";
import { selectProviderMode } from "./pipeline.ts";

export const DEFAULT_AGENT_DAILY_PICKS = 10;
const MIN_AGENT_DAILY_PICKS = 1;
const MAX_AGENT_DAILY_PICKS = 20;
const RANK_MAX_TOKENS = 300;

// Hard rules the model is asked for AND that post-parse enforcement below
// re-checks — never trust the model to count. MAX_PICKS_PER_SOURCE keeps one
// loud source from crowding out everything else in a 10-pick day;
// MIN_TOPIC_DIVERSITY is prompt-only (the model has to reason about topic
// coverage from the interest list — there's no per-candidate topic field to
// mechanically re-check against).
const MAX_PICKS_PER_SOURCE = 2;
const MIN_TOPIC_DIVERSITY = 3;

// [vars] AGENT_DAILY_PICKS is a string (like SUMMARY_BODY_TARGET_CHARS
// elsewhere) so a bad override (missing, non-numeric, outside [1, 20])
// degrades to the default instead of asking the model for a nonsensical
// pick count. Only warns when a value was actually set but rejected.
export function parseAgentDailyPicks(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_AGENT_DAILY_PICKS;
  const n = Number(trimmed);
  if (
    !Number.isFinite(n) || n < MIN_AGENT_DAILY_PICKS || n > MAX_AGENT_DAILY_PICKS
  ) {
    console.warn(JSON.stringify({
      event: "agent_daily_picks_invalid",
      raw: trimmed,
      fallback: DEFAULT_AGENT_DAILY_PICKS,
    }));
    return DEFAULT_AGENT_DAILY_PICKS;
  }
  return Math.round(n);
}

function buildRankSystemPrompt(pickCount: number): string {
  return `You rank news for a personal feed. Pick the ${pickCount} best items. HARD RULES: ` +
    `(a) at most ${MAX_PICKS_PER_SOURCE} items per source; ` +
    `(b) cover at least ${MIN_TOPIC_DIVERSITY} distinct topic areas from the interest list when the pool allows; ` +
    `(c) prefer substantive reporting over link-posts and speculation. ` +
    `Respond ONLY with a JSON array of the ${pickCount} best item ids.`;
}

function buildRankUserMessage(interests: string, candidates: Candidate[]): string {
  const lines = candidates.map(
    (c) => `${c.id} | ${c.discoverySource} | ${c.title} | ${c.snippet}`,
  );
  return `Interests: ${interests}\n\nCandidates:\n${lines.join("\n")}`;
}

// Filters the model's raw output down to ids that actually exist in the
// pool, preserving the model's own order — does NOT slice to pickCount or
// enforce the per-source cap; that's enforceRankingDiversity's job below,
// which needs the full ordered list (not a pre-truncated one) to backfill
// correctly. `null` (not an empty array) signals "treat this like a parse
// failure" — an all-invalid-ids response is exactly as useless as unparseable
// JSON, and both should trigger the same retry-then-fallback path.
function parseRankedIds(raw: string, validIds: ReadonlySet<string>): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === "string")) {
    return null;
  }
  const filtered = parsed.filter((id) => validIds.has(id));
  return filtered.length > 0 ? filtered : null;
}

// Post-parse enforcement of the "at most MAX_PICKS_PER_SOURCE per source"
// hard rule — never trust the model to have actually counted. Walks the
// model's own ranked order, dropping any pick that would push its source
// over the cap; each drop reopens exactly one slot, backfilled from the rest
// of the pool in its existing order (newest-first — see agent-pool.ts),
// skipping ids the model already picked and still respecting the same cap.
// Only backfills to cover slots lost to cap violations — a model response
// that's simply shorter than pickCount (no violation, just fewer good items
// that day) is trusted as-is, same as before this rule existed. If the pool
// doesn't have enough other-source candidates to fill every reopened slot
// (an exhausted pool), returns fewer than pickCount rather than violating
// the cap to force a full count.
export function enforceRankingDiversity(
  rankedIds: string[],
  pool: Candidate[],
  pickCount: number,
): string[] {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const perSourceCount = new Map<string, number>();
  const picks: string[] = [];
  const pickedIds = new Set<string>();
  let droppedForCap = 0;

  for (const id of rankedIds) {
    if (picks.length >= pickCount) break;
    const candidate = byId.get(id);
    if (!candidate) continue;
    const count = perSourceCount.get(candidate.sourceId) ?? 0;
    if (count >= MAX_PICKS_PER_SOURCE) {
      droppedForCap += 1;
      continue;
    }
    perSourceCount.set(candidate.sourceId, count + 1);
    picks.push(id);
    pickedIds.add(id);
  }

  if (droppedForCap > 0) {
    const backfillTarget = Math.min(pickCount, picks.length + droppedForCap);
    for (const candidate of pool) {
      if (picks.length >= backfillTarget) break;
      if (pickedIds.has(candidate.id)) continue;
      const count = perSourceCount.get(candidate.sourceId) ?? 0;
      if (count >= MAX_PICKS_PER_SOURCE) continue;
      perSourceCount.set(candidate.sourceId, count + 1);
      picks.push(candidate.id);
      pickedIds.add(candidate.id);
    }
    console.log(JSON.stringify({
      event: "rank_diversity_fixup",
      dropped: droppedForCap,
      picks: picks.length,
      pick_count: pickCount,
    }));
  }

  return picks;
}

// Used when the LLM call fails outright, or never returns a parseable,
// valid pick list: newest-first, one per source, up to pickCount — then
// backfills from the remaining newest candidates if there weren't enough
// distinct sources to fill every slot. This naturally covers at least
// min(3, distinct source count) sources whenever pickCount >= 3, since the
// first pass visits every distinct source before any backfill happens.
// `candidates` is assumed already sorted newest-first (see agent-pool.ts).
export function fallbackPicks(
  candidates: Candidate[],
  pickCount: number = DEFAULT_AGENT_DAILY_PICKS,
): string[] {
  const seenSources = new Set<string>();
  const picks: string[] = [];

  for (const c of candidates) {
    if (picks.length >= pickCount) break;
    if (seenSources.has(c.sourceId)) continue;
    seenSources.add(c.sourceId);
    picks.push(c.id);
  }
  if (picks.length < pickCount) {
    const pickedIds = new Set(picks);
    for (const c of candidates) {
      if (picks.length >= pickCount) break;
      if (pickedIds.has(c.id)) continue;
      picks.push(c.id);
    }
  }
  return picks;
}

// One cheap LLM call to pick the best pickCount candidates for the owner's
// interests (pickCount from env.AGENT_DAILY_PICKS, see
// parseAgentDailyPicks). Never fails the run: a request error or two
// unparseable responses in a row both fall back to fallbackPicks(). A
// successful parse still goes through enforceRankingDiversity — the model is
// asked to respect the per-source cap and topic spread, but that's enforced
// again here rather than trusted. Does NOT consume the daily summarization
// budget — that's spent per-article in the pipeline, not here.
export async function rankCandidates(
  env: Env,
  interests: string,
  candidates: Candidate[],
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const pickCount = parseAgentDailyPicks(env.AGENT_DAILY_PICKS);
  const mode = selectProviderMode({
    aiGatewayUrl: env.AI_GATEWAY_URL,
    cfAigToken: env.CF_AIG_TOKEN,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  });
  const validIds = new Set(candidates.map((c) => c.id));
  const systemPrompt = buildRankSystemPrompt(pickCount);
  const userMessage = buildRankUserMessage(interests, candidates);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callLlm(mode, env, systemPrompt, userMessage, RANK_MAX_TOKENS);
      const ids = parseRankedIds(raw, validIds);
      if (ids) return enforceRankingDiversity(ids, candidates, pickCount);
    } catch {
      // Provider/network error — retry once, then fall back below.
    }
  }

  return fallbackPicks(candidates, pickCount);
}
