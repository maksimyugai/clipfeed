import "../env.d.ts";
import type { Candidate, SourceConfig } from "./agent-types.ts";
import { callLlm, stripJsonFences } from "../pipeline/summarize.ts";
import { selectProviderMode } from "../pipeline/pipeline.ts";
import { findRecentTitles } from "../articles/db.ts";
import { titleSimilarity } from "../lib/title-similarity.ts";
import { loadCurationConfig } from "./curation.ts";
import { domainMatchesAny } from "./domain-block.ts";
import { hostname } from "../lib/url-host.ts";

export const DEFAULT_AGENT_DAILY_PICKS = 10;
const MIN_AGENT_DAILY_PICKS = 1;
const MAX_AGENT_DAILY_PICKS = 20;
const RANK_MAX_TOKENS = 400;

// Hard rules the model is asked for AND that post-parse enforcement below
// re-checks — never trust the model to count. MAX_PICKS_PER_SOURCE keeps one
// loud source from crowding out everything else in a 10-pick day;
// MIN_TOPIC_DIVERSITY is prompt-only (the model has to reason about topic
// coverage from the interest list — there's no per-candidate topic field to
// mechanically re-check against).
export const MAX_PICKS_PER_SOURCE = 2;
const MIN_TOPIC_DIVERSITY = 3;

// A live incident: two picks covered the exact same Kimi/Moonshot story from
// two different outlets, under different URLs (so the URL-based dedupe in
// agent-pool.ts never saw a collision). STORY_SIMILARITY_THRESHOLD is the
// token-set Jaccard cutoff dedupStories()/selectPicks() below use to catch
// this, via the shared titleSimilarity() util (see title-similarity.ts —
// also used by agent-pool.ts's pre-scrape pool dedup, Task 24) — tuned
// against real paraphrased ru/en title pairs (see ranking_test.ts), not just
// exact duplicates. RECENT_STORY_WINDOW_MS bounds how far back the
// against-DB check looks: yesterday's story from another outlet still
// shouldn't get re-picked today.
export const STORY_SIMILARITY_THRESHOLD = 0.5;
const RECENT_STORY_WINDOW_MS = 48 * 60 * 60 * 1000;

// Task 33 §4: the model is asked to rank (and label with a topic) more
// items than will actually be picked — 2x the daily pick count, capped at
// 24 — so the deterministic selection step below (priority sources, then
// topic quotas, then general fill) has real candidates to draw from beyond
// the model's own top-N, without a second LLM call.
const RANKED_LIST_MULTIPLIER = 2;
const MAX_RANKED_ITEMS = 24;

function maxRankedItems(pickCount: number): number {
  return Math.min(pickCount * RANKED_LIST_MULTIPLIER, MAX_RANKED_ITEMS);
}

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

function buildRankSystemPrompt(
  pickCount: number,
  maxItems: number,
  topicVocabulary: readonly string[],
): string {
  const vocab = topicVocabulary.length > 0 ? topicVocabulary : ["other"];
  return `You rank news for a personal feed. A downstream selection step will pick the final ` +
    `${pickCount} items, applying variety rules you can't see — so return a RANKED list of up ` +
    `to ${maxItems} good items, best first, not just your top ${pickCount}. HARD RULES: ` +
    `(a) at most ${MAX_PICKS_PER_SOURCE} items per source; ` +
    `(b) cover at least ${MIN_TOPIC_DIVERSITY} distinct topic areas from the interest list when the pool allows; ` +
    `(c) prefer substantive reporting over link-posts and speculation; ` +
    `(d) never rank two items covering the same story/event highly — pick the most substantive one and omit the rest. ` +
    `Respond ONLY with a JSON array of up to ${maxItems} objects, best-first, each shaped ` +
    `{"i": "<candidate id>", "topic": "<one of: ${vocab.join(", ")}>"}.`;
}

function buildRankUserMessage(interests: string, candidates: Candidate[]): string {
  const lines = candidates.map(
    (c) => `${c.id} | ${c.discoverySource} | ${c.title} | ${c.snippet}`,
  );
  return `Interests: ${interests}\n\nCandidates:\n${lines.join("\n")}`;
}

export interface RankedItem {
  id: string;
  topic: string;
}

// Parses the labeled, over-length ranked list (Task 33 §4). Defensive like
// the old parseRankedIds: fence-stripped, shape-validated, invalid/duplicate
// ids dropped, an unrecognized topic falls back to "other" rather than
// rejecting the whole item. `null` (not an empty array) signals "treat this
// like a parse failure" — same retry-then-fallback contract as before.
function parseRankedItems(
  raw: string,
  validIds: ReadonlySet<string>,
  topicVocabulary: readonly string[],
  maxItems: number,
): RankedItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const vocab = new Set(topicVocabulary.length > 0 ? topicVocabulary : ["other"]);
  const seen = new Set<string>();
  const items: RankedItem[] = [];
  for (const entry of parsed) {
    if (items.length >= maxItems) break;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const id = rec.i;
    if (typeof id !== "string" || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const rawTopic = typeof rec.topic === "string" ? rec.topic : "other";
    items.push({ id, topic: vocab.has(rawTopic) ? rawTopic : "other" });
  }
  return items.length > 0 ? items : null;
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
//
// Only used on the FALLBACK path now (see rankCandidates) — a successful
// labeled parse goes through selectPicks() below instead, which applies the
// same cap inline while also handling priority sources and topic quotas.
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

// Post-parse enforcement of hard rule (d) — never trust the model to have
// actually caught a same-story duplicate. Walks the (already
// diversity-enforced) pick order; a candidate whose title is similar
// (>= STORY_SIMILARITY_THRESHOLD) to anything already kept — including a
// title from `recentTitles` (articles saved in the last 48h, see
// findRecentTitles) — is dropped as the lower-ranked duplicate, since
// whatever's already kept was ranked/considered first. Each drop reopens one
// slot, backfilled from the rest of the pool (newest-first), respecting both
// MAX_PICKS_PER_SOURCE and the same similarity check against everything kept
// so far (including backfilled picks) — mirrors enforceRankingDiversity's
// backfill shape above, just checking story similarity instead of a
// per-source count.
//
// Only used on the FALLBACK path now — see the comment on
// enforceRankingDiversity above.
export function dedupStories(
  pickedIds: string[],
  pool: Candidate[],
  pickCount: number,
  recentTitles: string[] = [],
): string[] {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const kept: string[] = [];
  const keptTitles: string[] = [...recentTitles];
  const perSourceCount = new Map<string, number>();
  const consideredIds = new Set<string>();
  let droppedForStory = 0;

  const isDuplicateOfKept = (title: string): boolean =>
    keptTitles.some((t) => titleSimilarity(t, title) >= STORY_SIMILARITY_THRESHOLD);

  for (const id of pickedIds) {
    consideredIds.add(id);
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (isDuplicateOfKept(candidate.title)) {
      droppedForStory += 1;
      continue;
    }
    kept.push(id);
    keptTitles.push(candidate.title);
    perSourceCount.set(candidate.sourceId, (perSourceCount.get(candidate.sourceId) ?? 0) + 1);
  }

  if (droppedForStory > 0) {
    const backfillTarget = Math.min(pickCount, kept.length + droppedForStory);
    for (const candidate of pool) {
      if (kept.length >= backfillTarget) break;
      if (consideredIds.has(candidate.id)) continue;
      const count = perSourceCount.get(candidate.sourceId) ?? 0;
      if (count >= MAX_PICKS_PER_SOURCE) continue;
      if (isDuplicateOfKept(candidate.title)) continue;
      kept.push(candidate.id);
      keptTitles.push(candidate.title);
      perSourceCount.set(candidate.sourceId, count + 1);
      consideredIds.add(candidate.id);
    }
    console.log(JSON.stringify({
      event: "rank_story_dedup",
      kept: kept.length,
      dropped: droppedForStory,
    }));
  }

  return kept;
}

// Used when the LLM call fails outright, or never returns a parseable,
// valid labeled list: newest-first, one per source, up to pickCount — then
// backfills from the remaining newest candidates if there weren't enough
// distinct sources to fill every slot. This naturally covers at least
// min(3, distinct source count) sources whenever pickCount >= 3, since the
// first pass visits every distinct source before any backfill happens.
// `candidates` is assumed already sorted newest-first (see agent-pool.ts).
//
// Task 33: the fallback path deliberately SKIPS topic quotas/priority
// sources entirely (see rankCandidates) — with no labeled data to work
// from, forcing quotas here would mean guessing topics, which is worse than
// just falling back to the pre-Task-33 behavior for this one run.
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

export interface CurationSelectionConfig {
  topicQuotas: Record<string, number>;
  prioritySources: string[];
  preferredDomains: string[];
}

export interface SelectionComposition {
  picks: string[];
  byTopic: Record<string, number>;
  bySource: Record<string, number>;
  quotaFilled: Record<string, number>;
  priorityFilled: Record<string, boolean>;
}

// Task 33 §6: deterministic selection from the labeled ranked list — never
// trust the model to have actually applied variety rules, same philosophy
// as enforceRankingDiversity/dedupStories above, just restructured around
// three ordered passes instead of two:
//
//   1. PRIORITY SOURCES — each configured source id gets AT MOST one
//      guaranteed slot, taken from its highest-ranked (= first-listed)
//      candidate, but ONLY if that source appears in the ranked list at all
//      (the model already deemed it good enough to include) — this never
//      forces in a source the model rejected outright.
//   2. TOPIC QUOTAS — for each configured quota, fill best-first from
//      candidates labeled with that topic, skipping anything already
//      selected. Fewer matching candidates than the quota wants is fine
//      (unfillable quotas degrade silently, per curation.json's own docs);
//      the topic's own ranked order naturally backfills from more of the
//      same topic before falling through to general fill for any remainder.
//   3. GENERAL FILL — whatever's left of the ranked list, in order, with a
//      bounded preferred-domain tie-break (see below).
//
// MAX_PICKS_PER_SOURCE and STORY_SIMILARITY_THRESHOLD (recentTitles seeded
// the same way as dedupStories) are enforced THROUGHOUT via one shared
// `tryAdd` check, not as a separate backfill pass — safe because the ranked
// list here is already over-provisioned (up to 2x pickCount), so simply
// continuing past a rejected candidate reaches enough real alternatives
// without needing dedupStories'/enforceRankingDiversity's explicit
// two-pass backfill shape.
export function selectPicks(
  rankedItems: RankedItem[],
  pool: Candidate[],
  config: CurationSelectionConfig,
  pickCount: number,
  recentTitles: string[] = [],
): SelectionComposition {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const topicById = new Map(rankedItems.map((item) => [item.id, item.topic]));

  const perSourceCount = new Map<string, number>();
  const keptTitles: string[] = [...recentTitles];
  const picked = new Set<string>();
  const picks: string[] = [];

  const isDuplicateOfKept = (title: string): boolean =>
    keptTitles.some((t) => titleSimilarity(t, title) >= STORY_SIMILARITY_THRESHOLD);

  function tryAdd(id: string): boolean {
    if (picks.length >= pickCount || picked.has(id)) return false;
    const candidate = byId.get(id);
    if (!candidate) return false;
    const count = perSourceCount.get(candidate.sourceId) ?? 0;
    if (count >= MAX_PICKS_PER_SOURCE) return false;
    if (isDuplicateOfKept(candidate.title)) return false;

    perSourceCount.set(candidate.sourceId, count + 1);
    keptTitles.push(candidate.title);
    picked.add(id);
    picks.push(id);
    return true;
  }

  // 1. PRIORITY SOURCES — absent from the ranked list, or rejected by a
  // throughout-constraint (cap/dedup), both count as "unfilled, no
  // forcing" per Task 33 §6.1; the log line doesn't distinguish why, since
  // from the caller's perspective the outcome is the same either way.
  const priorityFilled: Record<string, boolean> = {};
  for (const sourceId of config.prioritySources) {
    const candidateItem = rankedItems.find((item) => byId.get(item.id)?.sourceId === sourceId);
    const ok = candidateItem ? tryAdd(candidateItem.id) : false;
    priorityFilled[sourceId] = ok;
    if (!ok) {
      console.log(JSON.stringify({ event: "rank_priority_unfilled", sourceId }));
    }
  }

  // 2. TOPIC QUOTAS
  const quotaFilled: Record<string, number> = {};
  for (const [topic, wanted] of Object.entries(config.topicQuotas)) {
    let got = 0;
    for (const item of rankedItems) {
      if (got >= wanted) break;
      if (item.topic !== topic) continue;
      if (tryAdd(item.id)) got += 1;
    }
    quotaFilled[topic] = got;
    if (got < wanted) {
      console.log(JSON.stringify({ event: "rank_quota_unfilled", topic, wanted, got }));
    }
  }

  // 3. GENERAL FILL — a bounded preferred-domain tie-break: a single
  // forward pass that lets a preferred candidate move up at most ONE rank
  // position past an immediately-preceding non-preferred one. This is a
  // genuine tie-break (never reorders across more than an adjacent pair),
  // not a full re-sort by preference — per Task 33 §5, the whitelist is
  // advisory and must never let a preferred domain jump a large rank gap.
  const remaining = rankedItems.filter((item) => !picked.has(item.id));
  const isPreferred = (item: RankedItem): boolean => {
    const candidate = byId.get(item.id);
    if (!candidate) return false;
    const host = hostname(candidate.url);
    return host !== null && domainMatchesAny(host, config.preferredDomains);
  };
  for (let i = 0; i < remaining.length - 1; i++) {
    if (!isPreferred(remaining[i]) && isPreferred(remaining[i + 1])) {
      const tmp = remaining[i];
      remaining[i] = remaining[i + 1];
      remaining[i + 1] = tmp;
    }
  }
  for (const item of remaining) {
    if (picks.length >= pickCount) break;
    tryAdd(item.id);
  }

  const finalPicks = picks.slice(0, pickCount);
  const byTopic: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const id of finalPicks) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    const topic = topicById.get(id) ?? "other";
    byTopic[topic] = (byTopic[topic] ?? 0) + 1;
    bySource[candidate.sourceId] = (bySource[candidate.sourceId] ?? 0) + 1;
  }

  const composition: SelectionComposition = {
    picks: finalPicks,
    byTopic,
    bySource,
    quotaFilled,
    priorityFilled,
  };
  console.log(JSON.stringify({ event: "rank_selection", ...composition }));
  return composition;
}

// One cheap LLM call to rank candidates for the owner's interests (pickCount
// from env.AGENT_DAILY_PICKS, see parseAgentDailyPicks). Never fails the
// run: a request error or two unparseable responses in a row both fall back
// to fallbackPicks(). A successful parse returns a labeled, over-length
// list (Task 33 §4) which selectPicks() turns into exactly pickCount final
// picks via priority sources -> topic quotas -> general fill (Task 33 §6);
// the fallback path skips quotas entirely and goes through the older
// enforceRankingDiversity/dedupStories pair instead (see their doc comments
// above). Does NOT consume the daily summarization budget — that's spent
// per-article in the pipeline, not here.
export async function rankCandidates(
  env: Env,
  interests: string,
  candidates: Candidate[],
  sources: readonly SourceConfig[] = [],
  now: Date = new Date(),
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const pickCount = parseAgentDailyPicks(env.AGENT_DAILY_PICKS);
  const recentTitles = await findRecentTitles(
    env.DB,
    new Date(now.getTime() - RECENT_STORY_WINDOW_MS).toISOString(),
  );
  const mode = selectProviderMode({
    aiGatewayUrl: env.AI_GATEWAY_URL,
    cfAigToken: env.CF_AIG_TOKEN,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  });
  const validIds = new Set(candidates.map((c) => c.id));
  const curationConfig = loadCurationConfig(sources, pickCount);
  const maxItems = maxRankedItems(pickCount);
  const systemPrompt = buildRankSystemPrompt(pickCount, maxItems, curationConfig.topicVocabulary);
  const userMessage = buildRankUserMessage(interests, candidates);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callLlm(mode, env, systemPrompt, userMessage, RANK_MAX_TOKENS);
      const items = parseRankedItems(raw, validIds, curationConfig.topicVocabulary, maxItems);
      if (items) {
        const composition = selectPicks(items, candidates, curationConfig, pickCount, recentTitles);
        return composition.picks;
      }
    } catch {
      // Provider/network error — retry once, then fall back below.
    }
  }

  return dedupStories(fallbackPicks(candidates, pickCount), candidates, pickCount, recentTitles);
}
