import "./env.d.ts";
import type { Candidate, SourceConfig } from "./agent-types.ts";
import { fetchAllCandidates, SOURCES } from "./sources.ts";
import {
  buildCandidatePool,
  parseSemanticDedupMaxCandidates,
  parseSemanticDedupThreshold,
} from "./agent-pool.ts";
import { rankCandidates } from "./ranking.ts";
import { findArticleIdByUrl, insertPendingArticle } from "./db.ts";
import { enqueueArticleJob } from "./queue.ts";
import { sourceFromUrl } from "./validation.ts";
import { resolveEmbeddingModel } from "./embeddings.ts";
import { loadBlocklistConfig } from "./curation.ts";
import { listAutoBlocks } from "./autoblock.ts";
import { type AgentRunTrigger, recordAgentRun } from "./agent-run-tracker.ts";

// Structured, category-level stage log for the agent job — counts and ids
// only, never candidate titles/snippets or credentials.
function logAgentStage(stage: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: "agent_stage", stage, ...extra }));
}

// Task 36 Part B: records this run's completion for the day's idempotency
// marker (see agent-run-tracker.ts) — best-effort, wrapped so a KV failure
// here can't turn runAgentJob's documented "never throws" into a lie. A
// missed marker write just means the next scheduled/manual trigger won't
// see this run in its history, which degrades back to today's existing
// (imperfect) behavior rather than crashing anything.
async function recordRunCompletion(
  env: Env,
  startedAt: string,
  picks: number,
  trigger: AgentRunTrigger,
): Promise<void> {
  try {
    await recordAgentRun(env.CACHE, { startedAt, picks, trigger });
  } catch (err) {
    console.warn(JSON.stringify({ event: "agent_run_record_failed", error: String(err) }));
  }
}

// Runs the daily scraping agent end to end: fetch trusted sources -> build
// a deduped 24h candidate pool -> rank against the owner's interests ->
// save + summarize the top picks, one at a time. Called from
// ctx.executionCtx.waitUntil() (the scheduled hour-dispatch, the manual
// POST /api/admin/agent/run endpoint, or the Telegram /scrape command) —
// never throws; a failure at any stage before execution just means zero
// picks this run, not a crashed waitUntil task.
export async function runAgentJob(
  env: Env,
  sources: SourceConfig[] = SOURCES,
  trigger: AgentRunTrigger = "manual",
): Promise<void> {
  const runStart = performance.now();
  const startedAt = new Date().toISOString();

  const sourcesStart = performance.now();
  const { candidates, fetched, failed } = await fetchAllCandidates(sources);
  logAgentStage("sources", {
    duration_ms: Math.round(performance.now() - sourcesStart),
    fetched,
    failed: failed.map((f) => f.id),
  });

  // Task 33 §2/§5: absolute domain block (manual blocklist.json + KV
  // auto-learned blocks), applied inside buildCandidatePool before any
  // ranking happens. The autoblock list is fetched ONCE per run here
  // (rather than per-candidate) and passed down as a plain Set.
  const blocklistConfig = loadBlocklistConfig();
  const autoBlocks = await listAutoBlocks(env.CACHE);
  const autoBlockedDomains = new Set(autoBlocks.map((entry) => entry.domain));

  const poolStart = performance.now();
  const { pool, dedupDrops, blockedDropped } = await buildCandidatePool(
    env.DB,
    env.CACHE,
    candidates,
    new Date(),
    {
      ai: env.AI,
      vectors: env.VECTORS,
      model: resolveEmbeddingModel(env.EMBEDDING_MODEL),
      maxCandidates: parseSemanticDedupMaxCandidates(env.SEMANTIC_DEDUP_MAX_CANDIDATES),
      threshold: parseSemanticDedupThreshold(env.SEMANTIC_DEDUP_THRESHOLD),
    },
    { blockedDomains: blocklistConfig.blockedDomains, autoBlockedDomains },
  );
  const dedupDropCounts = { url: 0, title: 0, jaccard: 0, semantic: 0 };
  for (const drop of dedupDrops) dedupDropCounts[drop.reason] += 1;
  logAgentStage("pool", {
    duration_ms: Math.round(performance.now() - poolStart),
    pool_size: pool.length,
    dedup_dropped: dedupDrops.length,
    dedup_dropped_by_reason: dedupDropCounts,
    blocked_dropped: blockedDropped,
  });

  if (pool.length === 0) {
    logAgentStage("done", { duration_ms: Math.round(performance.now() - runStart), picks_run: 0 });
    await recordRunCompletion(env, startedAt, 0, trigger);
    return;
  }

  const rankStart = performance.now();
  const pickedIds = await rankCandidates(env, env.INTEREST_TOPICS, pool, sources);
  const poolById = new Map(pool.map((c) => [c.id, c]));
  const orderedPicks = pickedIds
    .map((id) => poolById.get(id))
    .filter((c): c is Candidate => c !== undefined);
  logAgentStage("rank", {
    duration_ms: Math.round(performance.now() - rankStart),
    picks: orderedPicks.map((c) => ({ id: c.id, source: c.sourceId })),
  });

  let picksRun = 0;
  for (const pick of orderedPicks) {
    // Idempotency backstop: buildCandidatePool already excludes URLs that
    // exist in D1 as of the pool query, but re-check right before insert in
    // case of same-run duplicates (two picks canonicalizing to one URL
    // slipping past dedupe) — cheap, and guarantees no double-insert.
    const existingId = await findArticleIdByUrl(env.DB, pick.url);
    if (existingId) continue;

    const id = crypto.randomUUID();
    await insertPendingArticle(env.DB, {
      id,
      url: pick.url,
      title: pick.title,
      source: sourceFromUrl(pick.url),
      tags: [pick.sourceId],
      added_via: "agent",
      added_at: new Date().toISOString(),
    });

    // Sequential, not parallel — stays well inside CPU limits. The
    // pipeline's own daily-budget check handles exhaustion mid-run: once
    // the budget runs out, remaining picks land as 'failed: daily-limit',
    // same as any other over-budget save (see pipeline.ts). No ExecutionContext
    // is threaded through here — this whole job already runs inside a
    // waitUntil()'d task at every call site (cron, manual trigger, /scrape),
    // so when JOBS isn't configured, enqueueArticleJob's fallback just awaits
    // the pipeline inline, same as it always has; when JOBS *is* configured
    // (the intended path), each pick is a fast enqueue and this loop finishes
    // quickly, matching the "fetch+rank only" goal for this job's own runtime.
    await enqueueArticleJob(env, undefined, { kind: "process", articleId: id });
    picksRun += 1;
  }

  logAgentStage("done", {
    duration_ms: Math.round(performance.now() - runStart),
    picks_run: picksRun,
  });
  await recordRunCompletion(env, startedAt, picksRun, trigger);
}
