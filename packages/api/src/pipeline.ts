import "./env.d.ts";
import type { SummaryJson } from "@clipfeed/shared/types";
import { safeFetchText } from "./ssrf.ts";
import { extractArticle } from "./extract.ts";
import {
  parseSummaryBodyTargetChars,
  renderSummaryMarkdown,
  summarizeArticle,
  summarizeArticleWithWorkersAi,
} from "./summarize.ts";
import { tryConsumeSummaryBudget } from "./cost-guard.ts";
import { markArticleFailed, markArticleReady } from "./db.ts";
import { recordThinHostFailure } from "./thin-host-learning.ts";

export interface PipelineInput {
  id: string;
  url: string;
  html?: string;
  requestTitle?: string;
  requestTags: string[];
}

export function mergeTags(requestTags: string[], modelTags: string[]): string[] {
  const merged = [...requestTags, ...modelTags]
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(merged));
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
    );
  }
  if (mode === "direct") {
    return await summarizeArticle(
      { apiKey: env.ANTHROPIC_API_KEY, model: env.SUMMARY_MODEL },
      title,
      text,
      targetTotalChars,
    );
  }
  return await summarizeArticleWithWorkersAi(
    env.AI,
    env.WORKERS_AI_MODEL,
    title,
    text,
    targetTotalChars,
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
      await markArticleFailed(
        env.DB,
        input.id,
        `extraction: insufficient text (${extracted.textContent.length} chars)`,
      );
      // Teaches the agent's candidate-pool filter to avoid this host next
      // time (see thin-host-learning.ts) — recorded regardless of
      // added_via, but only ever consulted for agent candidates, so a
      // manual/extension/telegram save of the same thin host is never
      // blocked by this.
      await recordThinHostFailure(env.CACHE, input.url);
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
    const summary = await runSummarizationForMode(mode, env, title, text);
    logStage(input.id, stage, summarizeStart, { mode, text_chars: text.length });

    stage = "persist";
    const persistStart = performance.now();
    await markArticleReady(env.DB, input.id, {
      full_text: text,
      title,
      author: extracted.byline,
      lang_original: summary.lang_original,
      summary_ru: renderSummaryMarkdown(summary.tldr_ru, summary.bullets_ru),
      summary_en: renderSummaryMarkdown(summary.tldr_en, summary.bullets_en),
      summary_json: summary,
      tags: mergeTags(input.requestTags, summary.tags),
    });
    logStage(input.id, stage, persistStart);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `internal: ${stage}: ${message}`.slice(0, 200);
    await markArticleFailed(env.DB, input.id, reason);
  }
}

export interface ResummarizeInput {
  id: string;
  title: string;
  author: string | null;
  fullText: string;
  requestTags: string[];
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
    const summary = await runSummarizationForMode(mode, env, input.title, text);
    logStage(input.id, stage, summarizeStart, { mode, text_chars: text.length });

    stage = "persist";
    const persistStart = performance.now();
    await markArticleReady(env.DB, input.id, {
      full_text: text,
      title: input.title,
      author: input.author,
      lang_original: summary.lang_original,
      summary_ru: renderSummaryMarkdown(summary.tldr_ru, summary.bullets_ru),
      summary_en: renderSummaryMarkdown(summary.tldr_en, summary.bullets_en),
      summary_json: summary,
      tags: mergeTags(input.requestTags, summary.tags),
    });
    logStage(input.id, stage, persistStart);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `internal: ${stage}: ${message}`.slice(0, 200);
    await markArticleFailed(env.DB, input.id, reason);
  }
}
