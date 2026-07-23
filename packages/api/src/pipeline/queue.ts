import "../env.d.ts";
import type { QueueMessage, QueueNotify } from "@clipfeed/shared/types";
import { getArticleById, markArticleFailed } from "../articles/db.ts";
import {
  resolvePriorViolations,
  runArticlePipeline,
  runEnglishTranslation,
  runResummarization,
} from "./pipeline.ts";
import { editMessageText, readTelegramConfig } from "../telegram/telegram-client.ts";
import { failedText, readySuccessText } from "../telegram/telegram-strings.ts";

// Literal queue names from wrangler.toml — batch.queue (see index.ts's
// `queue` export) always carries the real configured name, and there's no
// binding that exposes a queue's own name back to code, so matching a
// hardcoded constant against it is the only option.
export const MAIN_QUEUE_NAME = "clipfeed-jobs";
export const DEAD_LETTER_QUEUE_NAME = "clipfeed-dlq";

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

  // Only meaningful when this row is being retried after a previous
  // 'content'-classified failure (see resolvePriorViolations) — undefined
  // otherwise, so a brand-new article's summarization call is unaffected.
  const priorViolations = resolvePriorViolations(article.fail_class, article.error);

  if (message.kind === "process") {
    const html = await takePendingHtml(env.CACHE, message.articleId);
    await runArticlePipeline(env, {
      id: article.id,
      url: article.url,
      html,
      requestTitle: article.title,
      requestTags: article.tags,
      priorViolations,
      addedVia: article.added_via,
      source: article.source,
      addedAt: article.added_at,
    });
  } else if (message.kind === "translate") {
    // Task 35 Part A §3: requires stored full_text to generate the EN
    // fields from — always present for the endpoint's real call sites
    // (only a 'ready' article, which always has full_text, can be
    // translated — see index.ts), but checked defensively here too.
    if (!article.full_text) {
      console.warn(JSON.stringify({
        event: "queue_message_skipped",
        reason: "no full_text to translate from",
        id: message.articleId,
      }));
    } else {
      await runEnglishTranslation(env, {
        id: article.id,
        title: article.title,
        fullText: article.full_text,
      });
    }
  } else {
    const hasFullText = article.full_text !== null && article.full_text.trim().length > 0;
    if (hasFullText) {
      await runResummarization(env, {
        id: article.id,
        title: article.title,
        author: article.author,
        fullText: article.full_text as string,
        requestTags: article.tags,
        priorViolations,
        addedVia: article.added_via,
        source: article.source,
        addedAt: article.added_at,
      });
    } else {
      await runArticlePipeline(env, {
        id: article.id,
        url: article.url,
        requestTitle: article.title,
        requestTags: article.tags,
        priorViolations,
        addedVia: article.added_via,
        source: article.source,
        addedAt: article.added_at,
      });
    }
  }

  if (message.notify) {
    await notifyTelegram(env, message.notify, message.articleId);
  }
}

// Consumer for the "clipfeed-dlq" queue (see wrangler.toml
// [[queues.consumers]], index.ts's `queue` export) — Cloudflare routes a
// message here automatically once it exhausts max_retries on the main
// queue, so this is the backstop closing the "message never reaches a
// terminal write" gap. Idempotent: an article can already be terminal here
// (e.g. the pipeline itself wrote 'failed' on the final retry attempt, and
// only the ack afterward was lost) — re-marking it would clobber a
// perfectly good 'ready' row or overwrite a real error with this generic
// one, so both terminal states are left untouched.
export async function processDeadLetterMessage(env: Env, message: QueueMessage): Promise<void> {
  const article = await getArticleById(env.DB, message.articleId);
  if (!article) {
    console.warn(JSON.stringify({
      event: "queue_dead_letter_skipped",
      reason: "article not found",
      id: message.articleId,
    }));
    return;
  }

  if (article.status === "ready" || article.status === "failed") {
    console.warn(JSON.stringify({
      event: "queue_dead_letter_skipped",
      reason: "already terminal",
      id: message.articleId,
      status: article.status,
    }));
    return;
  }

  await markArticleFailed(env.DB, message.articleId, "queue: processing failed after retries");
  console.warn(JSON.stringify({ event: "queue_dead_letter", articleId: message.articleId }));
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
    console.log(JSON.stringify({
      event: "queue_enqueued",
      articleId: message.articleId,
      kind: message.kind,
    }));
    return;
  }
  console.warn("queue not configured — large articles may time out");
  if (ctx) {
    ctx.waitUntil(processQueueMessage(env, message));
  } else {
    await processQueueMessage(env, message);
  }
}
