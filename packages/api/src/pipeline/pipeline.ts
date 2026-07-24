import "../env.d.ts";
import type { FaithfulnessJson, FaithfulnessVerdict, SummaryJson } from "@clipfeed/shared/types";
import { safeFetchText } from "./ssrf.ts";
import { extractArticle } from "./extract.ts";
import {
  deriveSummarySpec,
  generateEnglishFields,
  parseSummaryBodyTargetChars,
  type PriorViolationsKind,
  renderSummaryMarkdown,
  summarizeArticle,
  summarizeArticleWithWorkersAi,
} from "./summarize.ts";
import { tryConsumeSummaryBudget } from "./cost-guard.ts";
import {
  markArticleFailed,
  markArticleReady,
  markEmbedded,
  markFaithfulnessEnforced,
  markImageStored,
  mergeEnglishFields,
} from "../articles/db.ts";
import { downloadAndStoreImage, extractOgImage } from "./images.ts";
import { classifyFailure } from "../../../shared/src/classify-failure.ts";
import {
  parseAutoblockThreshold,
  parseAutoblockTtlDays,
  recordAutoBlockSignal,
} from "../agent/autoblock.ts";
import {
  buildFaithfulnessRetryViolations,
  incrementFaithfulnessCallCounter,
  parseFaithfulnessCheckEnabled,
  parseFaithfulnessEnforceEnabled,
  resolveFaithfulnessJudgeModel,
  runFaithfulnessCheck,
  tryRepairUnfaithfulBullets,
} from "./faithfulness.ts";
import {
  buildEmbeddingText,
  embedText,
  resolveEmbeddingModel,
  upsertArticleEmbedding,
} from "../search/embeddings.ts";

export interface PipelineInput {
  id: string;
  url: string;
  html?: string;
  requestTitle?: string;
  requestTags: string[];
  // Set only when this run is retrying an article whose PREVIOUS attempt
  // failed with fail_class 'content' (see classify-failure.ts) — the prior
  // run's stored error text, naming the exact validation rule(s) it broke,
  // handed to the FIRST summarization attempt of this run so it's an
  // informed retry rather than a blind repeat (see queue.ts's
  // processQueueMessage, which reads the row and populates this).
  priorViolations?: string;
  // Carried straight from the already-fetched D1 row (see queue.ts) rather
  // than re-read here — used only by the post-persist embed stage's
  // Vectorize metadata (see runEmbedStage below).
  addedVia: string;
  source: string | null;
  addedAt: string;
  // articles.faithfulness_enforced_at !== null on the already-fetched row
  // (see queue.ts) — Task 42 Part C's single-attempt cap: true means a
  // PREVIOUS run already spent this article's one remediation attempt, so
  // runFaithfulnessStage records a fresh verdict but never repairs/
  // regenerates or re-evaluates the agent/owner archive decision again.
  alreadyEnforced: boolean;
}

export function mergeTags(requestTags: string[], modelTags: string[]): string[] {
  const merged = [...requestTags, ...modelTags]
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(merged));
}

// Pure, directly testable: only a 'content'-classified failure (see
// classify-failure.ts) carries real signal worth handing back to the model
// — see PipelineInput.priorViolations. Called by queue.ts's
// processQueueMessage against the freshly re-read article row, whose
// `error` still holds the previous attempt's message even while the row is
// 'pending' (markArticlePending no longer clears it — see db.ts).
export function resolvePriorViolations(
  failClass: string | null,
  error: string | null,
): string | undefined {
  if (failClass !== "content" || !error) return undefined;
  const trimmed = error.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type ProviderMode = "gateway" | "direct" | "workers-ai";

export interface ProviderModeConfig {
  aiGatewayUrl?: string;
  cfAigToken?: string;
  anthropicApiKey?: string;
}

function isSet(value: string | undefined): boolean {
  return (value ?? "").trim().length > 0;
}

// A mode is only eligible when its configuration is COMPLETE — a partial
// config (e.g. AI_GATEWAY_URL with no credential, or a bare CF_AIG_TOKEN
// with no URL) must never be treated as "configured", since that produces a
// silent 401 instead of a working fallback. Priority: gateway > direct >
// Workers AI (which needs no configuration at all, so it's always eligible
// as the final fallback).
export function selectProviderMode(config: ProviderModeConfig): ProviderMode {
  const gatewayUrl = isSet(config.aiGatewayUrl);
  const gatewayToken = isSet(config.cfAigToken);
  const apiKey = isSet(config.anthropicApiKey);

  if (gatewayUrl && (gatewayToken || apiKey)) {
    return "gateway";
  }
  if (apiKey) {
    return "direct";
  }
  return "workers-ai";
}

async function runSummarizationForMode(
  mode: ProviderMode,
  env: Env,
  title: string,
  text: string,
  priorViolations?: string,
  priorViolationsKind: PriorViolationsKind = "content",
): Promise<SummaryJson> {
  const targetTotalChars = parseSummaryBodyTargetChars(env.SUMMARY_BODY_TARGET_CHARS);
  if (mode === "gateway") {
    return await summarizeArticle(
      {
        apiKey: env.ANTHROPIC_API_KEY,
        aiGatewayUrl: env.AI_GATEWAY_URL,
        aiGatewayToken: env.CF_AIG_TOKEN,
        model: env.SUMMARY_MODEL,
      },
      title,
      text,
      targetTotalChars,
      priorViolations,
      priorViolationsKind,
    );
  }
  if (mode === "direct") {
    return await summarizeArticle(
      { apiKey: env.ANTHROPIC_API_KEY, model: env.SUMMARY_MODEL },
      title,
      text,
      targetTotalChars,
      priorViolations,
      priorViolationsKind,
    );
  }
  return await summarizeArticleWithWorkersAi(
    env.AI,
    env.WORKERS_AI_MODEL,
    title,
    text,
    targetTotalChars,
    priorViolations,
    priorViolationsKind,
  );
}

export async function runSummarization(
  env: Env,
  title: string,
  text: string,
): Promise<SummaryJson> {
  const mode = selectProviderMode({
    aiGatewayUrl: env.AI_GATEWAY_URL,
    cfAigToken: env.CF_AIG_TOKEN,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  });
  return await runSummarizationForMode(mode, env, title, text);
}

// Llama's context window is meaningfully smaller than what gateway/direct
// Claude models accept — cap Workers AI's input text further than extract.ts's
// general MAX_TEXT_CHARS (30k, unchanged) to avoid an oversized-input
// failure on that path. Raised from 16k to 24k alongside the richer
// body-paragraph summary schema (see summarize.ts) — more source text gives
// the model more to draw the extra detail from; the queue consumer (not
// ctx.waitUntil()) absorbs the resulting latency, see this task's latency
// measurement note.
const MAX_TEXT_CHARS_WORKERS_AI = 24_000;

// Below this, there's nothing substantive to summarize — seen in practice on
// link-post pages (a Twitter/X mirror like xcancel.com/nitter, a bare
// redirect page, a JS-only SPA shell) where Readability's fallback to raw
// body text still yields only nav/footer boilerplate. Sending that to the
// LLM anyway produces either a fabricated summary (faithfulness violation)
// or an opaque downstream failure; failing fast here instead gives a human
// a clear, actionable reason (as opposed to a validation error whose real
// cause — "there was nothing here" — is buried a level down).
const MIN_EXTRACTED_TEXT_CHARS = 300;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Structured, category-level stage log — duration and byte/char counts only,
// never article content or credentials. One line per pipeline stage so a
// stuck/slow run can be diagnosed from logs alone.
function logStage(
  id: string,
  stage: string,
  startedAt: number,
  extra: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({
    event: "pipeline_stage",
    id,
    stage,
    duration_ms: Math.round(performance.now() - startedAt),
    ...extra,
  }));
}

interface FaithfulnessStageOutcome {
  // false means the article was already terminally marked 'failed'
  // (agent-picked article, still 'fail' after its one remediation attempt,
  // auto-archived) — the caller must stop, never fall through to persist.
  proceed: boolean;
  summary: SummaryJson;
  // true only when the judge actually ran (check enabled) — distinguishes
  // "disabled, nothing to write" from "ran, but the judge's own output was
  // unparseable" (verdict null either way, but the latter still has a
  // checkedAt and a {error} json payload — see faithfulness.ts).
  ran: boolean;
  verdict: FaithfulnessVerdict | null;
  json: FaithfulnessJson | null;
  checkedAt: string | null;
  // true when THIS invocation actually spent the article's one lifetime
  // remediation attempt (surgical repair or informed regeneration) — the
  // caller persists this as articles.faithfulness_enforced_at so a later
  // resummarize/heal cycle never restarts the cycle (see
  // db.ts's markFaithfulnessEnforced / PipelineSuccessUpdate).
  enforcementSpent: boolean;
}

// Runs AFTER a summary validates and BEFORE the article is marked 'ready' —
// a SEPARATE, independent judge (always Workers AI Llama, regardless of
// which model wrote the summary — see faithfulness.ts) checks whether the
// summary is actually supported by the source text.
//
// Task 42 Part C: the badge is no longer reader-facing (owner mode only —
// see ArticleCard.tsx), so a 'fail' verdict now drives ONE automatic
// remediation attempt (FAITHFULNESS_ENFORCE defaults to "true"; "false"
// reverts to the original signal-only behavior below):
//   1. Surgical repair first, no LLM: if every unsupported/contradicted
//      claim maps to a bullet (see tryRepairUnfaithfulBullets), drop just
//      those bullets — no re-judge needed, the offending claims are known
//      and removed by construction, so this counts as resolved (verdict
//      recorded as 'pass').
//   2. Otherwise, one informed regeneration: re-summarize with the flagged
//      claim text fed back into the prompt (see
//      buildFaithfulnessRetryViolations, summarize.ts's "faithfulness"
//      priorViolationsKind), then re-judge once.
// After that single attempt, whatever the verdict: an agent-picked article
// still 'fail' auto-archives (the reader never sees it, consistent with
// Task 34's policy for exhausted agent failures); an owner-added article
// (manual/extension/telegram) always stays visible — the owner decides.
// `alreadyEnforced` (read from articles.faithfulness_enforced_at by the
// caller BEFORE this row's own current attempt) makes this a true
// once-per-article cap: a later resummarize or heal cycle that reaches a
// 'fail' verdict again just records it, exactly like the signal-only path,
// never re-attempts repair/regeneration or re-evaluates the agent/owner
// archive decision.
async function runFaithfulnessStage(
  env: Env,
  id: string,
  mode: ProviderMode,
  title: string,
  text: string,
  summary: SummaryJson,
  addedVia: string,
  alreadyEnforced: boolean,
): Promise<FaithfulnessStageOutcome> {
  if (!parseFaithfulnessCheckEnabled(env.FAITHFULNESS_CHECK)) {
    return {
      proceed: true,
      summary,
      ran: false,
      verdict: null,
      json: null,
      checkedAt: null,
      enforcementSpent: false,
    };
  }

  const judgeModel = resolveFaithfulnessJudgeModel(env.FAITHFULNESS_JUDGE_MODEL);

  const firstStart = performance.now();
  const first = await runFaithfulnessCheck(env.AI, judgeModel, text, summary);
  await incrementFaithfulnessCallCounter(env.CACHE);
  logStage(id, "faithfulness", firstStart, { verdict: first.verdict, ...first.counts });

  const enforce = parseFaithfulnessEnforceEnabled(env.FAITHFULNESS_ENFORCE);
  if (!enforce || alreadyEnforced || first.verdict !== "fail") {
    return {
      proceed: true,
      summary,
      ran: true,
      verdict: first.verdict,
      json: first.json,
      checkedAt: first.checkedAt,
      enforcementSpent: false,
    };
  }

  // --- Single remediation attempt ---

  const targetTotalChars = parseSummaryBodyTargetChars(env.SUMMARY_BODY_TARGET_CHARS);
  const spec = deriveSummarySpec(targetTotalChars, mode === "workers-ai" ? "relaxed" : "strict");
  const repaired = tryRepairUnfaithfulBullets(summary, first.json, spec.minBullets);
  if (repaired) {
    console.log(JSON.stringify({
      event: "faithfulness_repaired",
      id,
      droppedBullets: repaired.droppedBullets,
    }));
    return {
      proceed: true,
      summary: repaired.summary,
      ran: true,
      verdict: "pass",
      json: first.json,
      checkedAt: first.checkedAt,
      enforcementSpent: true,
    };
  }

  const violations = buildFaithfulnessRetryViolations(summary, first.json);
  const retriedSummary = await runSummarizationForMode(
    mode,
    env,
    title,
    text,
    violations,
    "faithfulness",
  );
  const secondStart = performance.now();
  const second = await runFaithfulnessCheck(env.AI, judgeModel, text, retriedSummary);
  await incrementFaithfulnessCallCounter(env.CACHE);
  logStage(id, "faithfulness", secondStart, {
    verdict: second.verdict,
    retry: true,
    ...second.counts,
  });

  if (second.verdict === "fail" && addedVia === "agent") {
    await markArticleFailed(env.DB, id, "faithfulness: summary not supported by source");
    await markFaithfulnessEnforced(env.DB, id, new Date().toISOString());
    console.log(JSON.stringify({ event: "faithfulness_archived", id }));
    return {
      proceed: false,
      summary: retriedSummary,
      ran: true,
      verdict: second.verdict,
      json: second.json,
      checkedAt: second.checkedAt,
      enforcementSpent: true,
    };
  }

  return {
    proceed: true,
    summary: retriedSummary,
    ran: true,
    verdict: second.verdict,
    json: second.json,
    checkedAt: second.checkedAt,
    enforcementSpent: true,
  };
}

interface PipelineArticleMeta {
  addedVia: string;
  source: string | null;
  addedAt: string;
}

// Runs AFTER the article is already 'ready' (markArticleReady has already
// committed) — semantic dedup/search's raw material, computed from the
// just-persisted summary (see embeddings.ts's buildEmbeddingText: RU
// fields only, since a fresh summary is RU-only by default — see Task 35
// Part A). Deliberately its own try/catch that NEVER rethrows: embed
// is auxiliary (Task 27's own requirement), so any failure here — a
// Workers AI error, a Vectorize error, a dimension mismatch — must never
// turn an already-successful article back into a failure. embedded_at
// simply stays null on failure, and the backfill endpoint
// (POST /api/admin/embeddings/backfill) picks it up later automatically
// (see db.ts's listUnembeddedArticles). Also a clean no-op — no Workers AI
// call spent for nothing — when env.VECTORS isn't bound at all (a fork
// that hasn't run `deno task setup`, or local dev, where Vectorize has no
// local emulation): there would be nowhere to store the vector anyway, and
// writing embedded_at without an actual stored vector would make a real
// future backfill (once Vectorize IS configured) permanently skip this row.
async function runEmbedStage(
  env: Env,
  id: string,
  summary: SummaryJson,
  meta: PipelineArticleMeta,
): Promise<void> {
  const embedStart = performance.now();
  try {
    if (!env.VECTORS) {
      logStage(id, "embed", embedStart, { outcome: "skipped_no_vectors_binding" });
      return;
    }
    const text = buildEmbeddingText({
      title_ru: summary.title_ru,
      tldr_ru: summary.tldr_ru,
      bullets_ru: summary.bullets_ru,
    });
    if (text.length === 0) {
      logStage(id, "embed", embedStart, { outcome: "skipped_empty_text" });
      return;
    }
    const model = resolveEmbeddingModel(env.EMBEDDING_MODEL);
    const values = await embedText(env.AI, model, text);
    await upsertArticleEmbedding(env.VECTORS, id, values, {
      added_at: meta.addedAt,
      source: meta.source,
      added_via: meta.addedVia,
      lang_original: summary.lang_original,
    });
    await markEmbedded(env.DB, id, new Date().toISOString());
    logStage(id, "embed", embedStart, { dims: values.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "embed_stage_failed", id, error: message }));
  }
}

// Task 35 Part C: reads the source page's own og:image/twitter:image tag
// from the ALREADY-FETCHED html (no extra fetch to get the tag) and, if
// present, downloads + stores it — auxiliary and strictly best-effort, same
// "own try/catch, never rethrows" contract as runEmbedStage above: an image
// is never required for an article to be considered successfully
// processed. Only meaningful for a full pipeline run (runArticlePipeline) —
// a resummarize has no freshly-fetched html to read a tag from, so it never
// calls this.
async function runImageStage(
  env: Env,
  id: string,
  html: string,
  articleUrl: string,
): Promise<void> {
  const imageStart = performance.now();
  try {
    const imageUrl = extractOgImage(html, articleUrl);
    if (!imageUrl) {
      logStage(id, "image", imageStart, { outcome: "skipped_no_image_tag" });
      return;
    }
    const stored = await downloadAndStoreImage(env, id, imageUrl);
    if (!stored) {
      logStage(id, "image", imageStart, { outcome: "skipped_download_failed" });
      return;
    }
    await markImageStored(env.DB, id, stored.key, stored.sourceUrl, stored.width, stored.height);
    logStage(id, "image", imageStart, { outcome: "stored" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "image_stage_failed", id, error: message }));
  }
}

// Runs the full fetch -> extract -> summarize -> persist pipeline for one
// article. Called from ctx.executionCtx.waitUntil() — the top-level
// try/catch below guarantees a terminal 'ready'/'failed' status for any
// error that reaches JS as an exception. It cannot guarantee this against a
// Workers CPU-time kill, which terminates the isolate without ever raising a
// catchable exception — see sweepStalePending() in db.ts for that backstop.
export async function runArticlePipeline(env: Env, input: PipelineInput): Promise<void> {
  let stage = "fetch";
  try {
    const fetchStart = performance.now();
    const html = input.html ?? await safeFetchText(input.url);
    const htmlBytes = byteLength(html);
    logStage(input.id, stage, fetchStart, { html_bytes: htmlBytes });

    stage = "extract";
    const extractStart = performance.now();
    const extracted = extractArticle(html, input.requestTitle);
    const title = extracted.title ?? input.requestTitle ?? input.url;
    logStage(input.id, stage, extractStart, {
      html_bytes: htmlBytes,
      text_chars: extracted.textContent.length,
    });

    if (extracted.textContent.length < MIN_EXTRACTED_TEXT_CHARS) {
      const insufficientTextReason =
        `extraction: insufficient text (${extracted.textContent.length} chars)`;
      await markArticleFailed(env.DB, input.id, insufficientTextReason);
      // Teaches Task 33's auto-block layer to avoid this host next time
      // (see autoblock.ts) — recorded regardless of added_via, but the
      // block itself is only ever consulted by the agent's candidate-pool
      // filter, so a manual/extension/telegram save of the same host is
      // never blocked by this.
      await recordAutoBlockAgentSignal(env, input.url, insufficientTextReason);
      return;
    }

    const mode = selectProviderMode({
      aiGatewayUrl: env.AI_GATEWAY_URL,
      cfAigToken: env.CF_AIG_TOKEN,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
    });
    const text = mode === "workers-ai"
      ? extracted.textContent.slice(0, MAX_TEXT_CHARS_WORKERS_AI)
      : extracted.textContent;

    stage = "budget";
    const budgetStart = performance.now();
    const budget = await tryConsumeSummaryBudget(env.CACHE, env.DAILY_SUMMARY_LIMIT);
    if (!budget.ok) {
      // The owner's own report on this: three consecutive retries each
      // completed in ~1-1.3s with stages fetch->extract->done and no
      // summarize stage at all — silently indistinguishable from any other
      // fast-failing run without this line, costing a debugging session.
      logStage(input.id, stage, budgetStart, {
        outcome: "exhausted",
        used: budget.used,
        limit: budget.limit,
      });
      await markArticleFailed(env.DB, input.id, "daily-limit");
      return;
    }

    stage = "summarize";
    const summarizeStart = performance.now();
    const summary = await runSummarizationForMode(mode, env, title, text, input.priorViolations);
    logStage(input.id, stage, summarizeStart, {
      mode,
      text_chars: text.length,
      informed_retry: Boolean(input.priorViolations),
    });

    stage = "faithfulness";
    const faithfulness = await runFaithfulnessStage(
      env,
      input.id,
      mode,
      title,
      text,
      summary,
      input.addedVia,
      input.alreadyEnforced,
    );
    if (!faithfulness.proceed) return;

    stage = "persist";
    const persistStart = performance.now();
    await markArticleReady(env.DB, input.id, {
      full_text: text,
      title,
      author: extracted.byline,
      lang_original: faithfulness.summary.lang_original,
      summary_ru: renderSummaryMarkdown(
        faithfulness.summary.tldr_ru,
        faithfulness.summary.bullets_ru,
      ),
      summary_json: faithfulness.summary,
      tags: mergeTags(input.requestTags, faithfulness.summary.tags),
      faithfulness: faithfulness.ran
        ? {
          verdict: faithfulness.verdict,
          json: faithfulness.json,
          checkedAt: faithfulness.checkedAt as string,
        }
        : undefined,
      faithfulnessEnforcedAt: faithfulness.enforcementSpent ? new Date().toISOString() : undefined,
    });
    logStage(input.id, stage, persistStart);

    await runEmbedStage(env, input.id, faithfulness.summary, {
      addedVia: input.addedVia,
      source: input.source,
      addedAt: input.addedAt,
    });
    await runImageStage(env, input.id, html, input.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `internal: ${stage}: ${message}`.slice(0, 200);
    await markArticleFailed(env.DB, input.id, reason);
    // Covers the fetch: upstream responded 403/402 (paywall) case — the
    // insufficient-text case above already returns before reaching here.
    // A safe no-op for every other failure shape: autoblockSignalWeight
    // only scores 'insufficient_text'/'paywalled', so calling this
    // unconditionally for any other classification just writes nothing.
    await recordAutoBlockAgentSignal(env, input.url, reason);
  }
}

// Task 33 §7.1: scores one classified failure against the URL's host (see
// autoblock.ts). Reused by both the insufficient-text branch and the
// top-level catch above — the only two places a pipeline run's error
// string is ever available.
async function recordAutoBlockAgentSignal(env: Env, url: string, reason: string): Promise<void> {
  const classification = classifyFailure(reason);
  await recordAutoBlockSignal(
    env.CACHE,
    url,
    classification,
    parseAutoblockThreshold(env.AUTOBLOCK_THRESHOLD),
    parseAutoblockTtlDays(env.AUTOBLOCK_TTL_DAYS),
  );
}

export interface ResummarizeInput {
  id: string;
  title: string;
  author: string | null;
  fullText: string;
  requestTags: string[];
  // See PipelineInput.priorViolations — same informed-retry plumbing,
  // applies here too since a 'content'-classified failure can be healed via
  // either the 'process' or 'resummarize' queue message kind depending on
  // whether full_text was already stored (see queue.ts).
  priorViolations?: string;
  // See PipelineInput.addedVia/source/addedAt — a resummarize re-embeds
  // too, since the summary content (and therefore the embedding text)
  // just changed.
  addedVia: string;
  source: string | null;
  addedAt: string;
  // See PipelineInput.alreadyEnforced.
  alreadyEnforced: boolean;
}

// Re-runs ONLY the summarize -> persist stages against already-stored
// full_text — no fetch/extract, so it's cheaper and deterministic relative
// to a full re-run (see POST /api/admin/articles/:id/resummarize, which
// falls back to runArticlePipeline() instead when there's no stored text
// to summarize). Same terminal-state guarantee as runArticlePipeline: any
// caught exception ends the row 'failed' with an 'internal: <stage>:
// <message>' reason instead of leaving it 'pending'.
export async function runResummarization(env: Env, input: ResummarizeInput): Promise<void> {
  let stage = "budget";
  try {
    const mode = selectProviderMode({
      aiGatewayUrl: env.AI_GATEWAY_URL,
      cfAigToken: env.CF_AIG_TOKEN,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
    });
    const text = mode === "workers-ai"
      ? input.fullText.slice(0, MAX_TEXT_CHARS_WORKERS_AI)
      : input.fullText;

    const budgetStart = performance.now();
    const budget = await tryConsumeSummaryBudget(env.CACHE, env.DAILY_SUMMARY_LIMIT);
    if (!budget.ok) {
      logStage(input.id, stage, budgetStart, {
        outcome: "exhausted",
        used: budget.used,
        limit: budget.limit,
      });
      await markArticleFailed(env.DB, input.id, "daily-limit");
      return;
    }

    stage = "summarize";
    const summarizeStart = performance.now();
    const summary = await runSummarizationForMode(
      mode,
      env,
      input.title,
      text,
      input.priorViolations,
    );
    logStage(input.id, stage, summarizeStart, {
      mode,
      text_chars: text.length,
      informed_retry: Boolean(input.priorViolations),
    });

    stage = "faithfulness";
    const faithfulness = await runFaithfulnessStage(
      env,
      input.id,
      mode,
      input.title,
      text,
      summary,
      input.addedVia,
      input.alreadyEnforced,
    );
    if (!faithfulness.proceed) return;

    stage = "persist";
    const persistStart = performance.now();
    await markArticleReady(env.DB, input.id, {
      full_text: text,
      title: input.title,
      author: input.author,
      lang_original: faithfulness.summary.lang_original,
      summary_ru: renderSummaryMarkdown(
        faithfulness.summary.tldr_ru,
        faithfulness.summary.bullets_ru,
      ),
      summary_json: faithfulness.summary,
      tags: mergeTags(input.requestTags, faithfulness.summary.tags),
      faithfulness: faithfulness.ran
        ? {
          verdict: faithfulness.verdict,
          json: faithfulness.json,
          checkedAt: faithfulness.checkedAt as string,
        }
        : undefined,
      faithfulnessEnforcedAt: faithfulness.enforcementSpent ? new Date().toISOString() : undefined,
    });
    logStage(input.id, stage, persistStart);

    await runEmbedStage(env, input.id, faithfulness.summary, {
      addedVia: input.addedVia,
      source: input.source,
      addedAt: input.addedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `internal: ${stage}: ${message}`.slice(0, 200);
    await markArticleFailed(env.DB, input.id, reason);
  }
}

export interface EnglishTranslationInput {
  id: string;
  title: string;
  fullText: string;
}

// Task 35 Part A §3: generates and merges ONLY the EN summary fields for
// an already-'ready' article, from its stored full_text (never a
// translation of the RU summary — see summarize.ts's generateEnglishFields)
// — the queue-consumer side of POST /api/admin/articles/:id/translate (see
// index.ts, queue.ts). Never changes `status` and never throws: a failure
// here just leaves en_generated_at null exactly as it was before the
// attempt (same "auxiliary, log-and-continue" contract as runEmbedStage/
// runImageStage above), so the owner can simply call the same endpoint
// again — no separate retry/healing machinery needed for this job kind.
export async function runEnglishTranslation(
  env: Env,
  input: EnglishTranslationInput,
): Promise<void> {
  const startedAt = performance.now();
  try {
    const mode = selectProviderMode({
      aiGatewayUrl: env.AI_GATEWAY_URL,
      cfAigToken: env.CF_AIG_TOKEN,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
    });
    const targetTotalChars = parseSummaryBodyTargetChars(env.SUMMARY_BODY_TARGET_CHARS);
    const text = mode === "workers-ai"
      ? input.fullText.slice(0, MAX_TEXT_CHARS_WORKERS_AI)
      : input.fullText;

    const fields = await generateEnglishFields(mode, env, input.title, text, targetTotalChars);
    await mergeEnglishFields(
      env.DB,
      input.id,
      fields,
      renderSummaryMarkdown(fields.tldr_en, fields.bullets_en),
      new Date().toISOString(),
    );
    logStage(input.id, "translate", startedAt, { mode });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "translate_failed", id: input.id, error: message }));
  }
}
