import "./env.d.ts";
import {
  archiveContentFailure,
  classifyAndMaybeArchive,
  incrementHealAttempts,
  listExhaustedContentFailures,
  listHealableFailedArticles,
  listUnclassifiedFailures,
  markArticlePending,
} from "./db.ts";
import { enqueueArticleJob } from "./queue.ts";
import { classifyFailure } from "../../shared/src/classify-failure.ts";
import {
  parseAutoblockThreshold,
  parseAutoblockTtlDays,
  recordAutoBlockSignal,
} from "./autoblock.ts";

// Retry budget per class — PERMANENT is excluded entirely (never retried;
// see listHealableFailedArticles, which only selects
// transient/unknown/content). UNKNOWN gets a single, lower-confidence
// attempt: no real signal either way about why it failed. CONTENT (a
// validateSummary() failure — see classify-failure.ts) gets a higher cap
// than UNKNOWN specifically because there IS a strong signal: the exact
// violations are known and get handed back to the model verbatim on the
// next attempt (see pipeline.ts's priorViolations plumbing), so each retry
// is an informed one, not a blind repeat — worth spending more budget on.
// See this task's report for the DAILY_SUMMARY_LIMIT arithmetic this cap
// was chosen against.
const HEAL_CAPS = { transient: 2, unknown: 1, content: 3 };

// Budget safety: bounds how much queue/LLM work one hourly tick can
// create, independent of how many failed articles are eligible — a burst
// of failures (e.g. a provider outage) heals gradually over several ticks
// instead of all at once.
const MAX_HEALS_PER_TICK = 5;

// Runs every hour, unconditionally, after the existing scheduled jobs (see
// scheduled.ts) — no dedicated on/off config, since a self-healing pass is
// cheap when there's nothing to heal (a couple of empty SELECTs) and the
// two safety limits above (per-class caps, MAX_HEALS_PER_TICK) already
// bound its cost when there is.
//
// Three independent passes:
//  1. Classify any 'failed' rows that predate the fail_class column
//     (migration 0003) — lazily backfilled here rather than a one-off
//     migration script, since migrations only alter schema, never run
//     application logic. A permanent+insufficient-text/paywalled backfill
//     also feeds Task 33's auto-block signal (see autoblock.ts), since
//     that signal was never recorded for these rows either.
//  2. Retry TRANSIENT/UNKNOWN failures up to their cap, oldest first,
//     capped at MAX_HEALS_PER_TICK total. The re-enqueued article goes
//     through the exact same queue path as any other 'process' job, so the
//     normal daily summary budget (cost-guard.ts) still applies —
//     healing doesn't bypass it, just adds another way to reach the
//     pipeline.
//  3. Task 34 Part A §3: auto-archive agent-picked 'content' failures that
//     have exhausted their heal cap (see listExhaustedContentFailures in
//     db.ts for the exact rule and why it's scoped to added_via='agent'
//     only). Runs after the retry pass so a row this same tick just
//     bumped to the cap value isn't caught prematurely — it's 'pending',
//     not 'failed', until its retry actually completes in a later
//     invocation.
export async function runHealingJob(env: Env, ctx?: ExecutionContext): Promise<void> {
  const autoblockThreshold = parseAutoblockThreshold(env.AUTOBLOCK_THRESHOLD);
  const autoblockTtlDays = parseAutoblockTtlDays(env.AUTOBLOCK_TTL_DAYS);
  const unclassified = await listUnclassifiedFailures(env.DB);
  for (const row of unclassified) {
    await classifyAndMaybeArchive(env.DB, row.id, row.error, row.added_via);
    await recordAutoBlockSignal(
      env.CACHE,
      row.url,
      classifyFailure(row.error ?? ""),
      autoblockThreshold,
      autoblockTtlDays,
    );
  }

  const candidates = await listHealableFailedArticles(env.DB, HEAL_CAPS, MAX_HEALS_PER_TICK);
  for (const article of candidates) {
    await incrementHealAttempts(env.DB, article.id);
    console.log(JSON.stringify({
      event: "heal_retry",
      articleId: article.id,
      class: article.fail_class,
      attempt: article.heal_attempts + 1,
    }));
    await markArticlePending(env.DB, article.id);
    await enqueueArticleJob(env, ctx, { kind: "process", articleId: article.id });
  }

  const exhausted = await listExhaustedContentFailures(env.DB, HEAL_CAPS.content);
  for (const row of exhausted) {
    await archiveContentFailure(env.DB, row.id);
  }
}
