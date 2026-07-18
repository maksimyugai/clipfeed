import "./env.d.ts";
import { safeFetchText } from "./ssrf.ts";
import { extractArticle } from "./extract.ts";
import { renderSummaryMarkdown, summarizeArticle } from "./summarize.ts";
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

    const summary = await summarizeArticle(
      env.ANTHROPIC_API_KEY,
      env.SUMMARY_MODEL,
      title,
      extracted.textContent,
    );

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
