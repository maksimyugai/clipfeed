import "./env.d.ts";
import type { QueueMessage, QueueNotify } from "@clipfeed/shared/types";
import { getArticleById } from "./db.ts";
import { runArticlePipeline, runResummarization } from "./pipeline.ts";
import { editMessageText, readTelegramConfig } from "./telegram-client.ts";
import { failedText, readySuccessText } from "./telegram-strings.ts";

const PENDING_HTML_TTL_SECONDS = 30 * 60;

function pendingHtmlKey(id: string): string {
  return `pending-html:${id}`;
}

// Queue message bodies are capped at 128KB (Cloudflare Queues limit), far
// below the 2MB of extension-submitted HTML this app accepts (see
// validation.ts's MAX_HTML_BYTES) — a producer with HTML to hand off
// stashes it here first, keyed by article id, and the consumer reads (and
// best-effort deletes) it. The TTL is a backstop for a message that never
// reaches a consumer.
export async function stashPendingHtml(
  cache: KVNamespace,
  id: string,
  html: string,
): Promise<void> {
  await cache.put(pendingHtmlKey(id), html, { expirationTtl: PENDING_HTML_TTL_SECONDS });
}

async function takePendingHtml(cache: KVNamespace, id: string): Promise<string | undefined> {
  const html = await cache.get(pendingHtmlKey(id));
  if (html === null) return undefined;
  await cache.delete(pendingHtmlKey(id)).catch(() => {});
  return html;
}

async function notifyTelegram(env: Env, notify: QueueNotify, articleId: string): Promise<void> {
  const config = readTelegramConfig(env);
  if (!config) return;
  const article = await getArticleById(env.DB, articleId);
  if (!article) return;

  const text = article.status === "ready" && article.summary_json
    ? readySuccessText(
      article.summary_json.title_ru,
      article.summary_json.tldr_ru,
      env.PUBLIC_BASE_URL.trim() || null,
    )
    : failedText((article.error ?? "unknown error").slice(0, 200));

  await editMessageText(config.botToken, notify.chatId, notify.messageId, text).catch(() => {});
}

// Shared by the real queue consumer (see index.ts's `queue` export) and the
// no-JOBS-binding fallback (enqueueArticleJob below) — same terminal-state
// guarantee either way, since that's owned by runArticlePipeline /
// runResummarization themselves. Re-reads the article row rather than
// carrying its fields in the message: the row already has everything
// (title/url/tags set at insert time), so the message body stays tiny.
export async function processQueueMessage(env: Env, message: QueueMessage): Promise<void> {
  const article = await getArticleById(env.DB, message.articleId);
  if (!article) {
    console.warn(JSON.stringify({
      event: "queue_message_skipped",
      reason: "article not found",
      id: message.articleId,
    }));
    return;
  }

  if (message.kind === "process") {
    const html = await takePendingHtml(env.CACHE, message.articleId);
    await runArticlePipeline(env, {
      id: article.id,
      url: article.url,
      html,
      requestTitle: article.title,
      requestTags: article.tags,
    });
  } else {
    const hasFullText = article.full_text !== null && article.full_text.trim().length > 0;
    if (hasFullText) {
      await runResummarization(env, {
        id: article.id,
        title: article.title,
        author: article.author,
        fullText: article.full_text as string,
        requestTags: article.tags,
      });
    } else {
      await runArticlePipeline(env, {
        id: article.id,
        url: article.url,
        requestTitle: article.title,
        requestTags: article.tags,
      });
    }
  }

  if (message.notify) {
    await notifyTelegram(env, message.notify, message.articleId);
  }
}

// Producer-side dispatch. The intended production path is JOBS.send(): a
// consumer invocation gets minutes of wall time, unlike ctx.waitUntil()'s
// hard 30-second cap (the actual cause of "timeout: processing did not
// complete" on large articles — see this task's PR description). Falls
// back to the pre-Queues ctx.waitUntil() behavior when the binding is
// missing — a fresh fork before `deno task setup` has provisioned the
// queue, or any environment that hasn't wired [[queues.producers]] —
// never crashes on a missing binding. `ctx` is optional: callers that are
// already themselves running inside a waitUntil()'d task (the scraping
// agent) can omit it and just await the fallback inline instead of
// nesting another waitUntil.
export async function enqueueArticleJob(
  env: Env,
  ctx: ExecutionContext | undefined,
  message: QueueMessage,
): Promise<void> {
  if (env.JOBS) {
    await env.JOBS.send(message);
    return;
  }
  console.warn("queue not configured — large articles may time out");
  if (ctx) {
    ctx.waitUntil(processQueueMessage(env, message));
  } else {
    await processQueueMessage(env, message);
  }
}
