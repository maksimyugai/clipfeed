import "./env.d.ts";
import type { SummaryJson } from "@clipfeed/shared/types";
import { safeFetchText } from "./ssrf.ts";
import { extractArticle } from "./extract.ts";
import {
  renderSummaryMarkdown,
  summarizeArticle,
  summarizeArticleWithWorkersAi,
} from "./summarize.ts";
import { tryConsumeSummaryBudget } from "./cost-guard.ts";
import { markArticleFailed, markArticleReady } from "./db.ts";

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

// Provider selection, in priority order: AI Gateway > direct Anthropic >
// Workers AI. Workers AI needs no configuration at all (the AI binding is
// always present), so it's the zero-config default when neither of the
// other two is set up.
export async function runSummarization(
  env: Env,
  title: string,
  text: string,
): Promise<SummaryJson> {
  if (env.AI_GATEWAY_URL) {
    return await summarizeArticle(
      {
        apiKey: env.ANTHROPIC_API_KEY,
        aiGatewayUrl: env.AI_GATEWAY_URL,
        aiGatewayToken: env.CF_AIG_TOKEN,
        model: env.SUMMARY_MODEL,
      },
      title,
      text,
    );
  }
  if (env.ANTHROPIC_API_KEY) {
    return await summarizeArticle(
      { apiKey: env.ANTHROPIC_API_KEY, model: env.SUMMARY_MODEL },
      title,
      text,
    );
  }
  return await summarizeArticleWithWorkersAi(env.AI, env.WORKERS_AI_MODEL, title, text);
}

// Runs the full extract -> summarize -> persist pipeline for one article.
// Called from ctx.executionCtx.waitUntil() — never throws, always leaves the
// row in 'ready' or 'failed'.
export async function runArticlePipeline(env: Env, input: PipelineInput): Promise<void> {
  try {
    const html = input.html ?? await safeFetchText(input.url);
    const extracted = extractArticle(html, input.requestTitle);
    const title = extracted.title ?? input.requestTitle ?? input.url;

    const withinBudget = await tryConsumeSummaryBudget(env.CACHE, env.DAILY_SUMMARY_LIMIT);
    if (!withinBudget) {
      await markArticleFailed(env.DB, input.id, "daily-limit");
      return;
    }

    const summary = await runSummarization(env, title, extracted.textContent);

    await markArticleReady(env.DB, input.id, {
      full_text: extracted.textContent,
      title,
      author: extracted.byline,
      lang_original: summary.lang_original,
      summary_ru: renderSummaryMarkdown(summary.tldr_ru, summary.bullets_ru),
      summary_en: renderSummaryMarkdown(summary.tldr_en, summary.bullets_en),
      summary_json: summary,
      tags: mergeTags(input.requestTags, summary.tags),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    await markArticleFailed(env.DB, input.id, reason.slice(0, 500));
  }
}
