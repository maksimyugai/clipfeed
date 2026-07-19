import "./env.d.ts";
import type { Context } from "hono";
import type { AppEnv } from "./access-middleware.ts";
import {
  editMessageText,
  readTelegramConfig,
  sendMessage,
  type TelegramConfig,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram-client.ts";
import { extractFirstUrl } from "./telegram-url.ts";
import { buildDigestMessages } from "./telegram-digest.ts";
import {
  AGENT_STARTED_TEXT,
  ALREADY_SAVED_TEXT,
  failedText,
  HELP_TEXT,
  NO_DIGEST_ARTICLES_TEXT,
  NON_OWNER_REPLY,
  readySuccessText,
  SAVING_TEXT,
} from "./telegram-strings.ts";
import { timingSafeEqualStrings } from "./telegram-secret.ts";
import {
  findArticleIdByUrl,
  getArticleById,
  insertPendingArticle,
  listRecentReadyArticles,
} from "./db.ts";
import { runArticlePipeline } from "./pipeline.ts";
import { sourceFromUrl } from "./validation.ts";
import { runAgentJob } from "./agent.ts";

const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

function sinceIso(now: Date): string {
  return new Date(now.getTime() - DIGEST_WINDOW_MS).toISOString();
}

async function buildAndSendDigest(
  env: Env,
  config: TelegramConfig,
  emptyReplyText: string | null,
): Promise<void> {
  const articles = await listRecentReadyArticles(env.DB, sinceIso(new Date()));
  const messages = buildDigestMessages(articles, env.PUBLIC_BASE_URL);

  if (!messages) {
    if (emptyReplyText) {
      await sendMessage(config.botToken, config.ownerChatId, emptyReplyText).catch(() => {});
    }
    return;
  }
  for (const text of messages) {
    await sendMessage(config.botToken, config.ownerChatId, text).catch(() => {});
  }
}

// Called by the cron trigger (see index.ts's `scheduled` export) — silent
// when there's nothing to report, unlike the interactive /digest command.
export async function sendMorningDigest(env: Env): Promise<void> {
  const config = readTelegramConfig(env);
  if (!config) return;
  await buildAndSendDigest(env, config, null);
}

async function runPipelineAndNotify(
  env: Env,
  config: TelegramConfig,
  articleId: string,
  url: string,
  messageId: number,
): Promise<void> {
  await runArticlePipeline(env, { id: articleId, url, requestTags: [] });

  const article = await getArticleById(env.DB, articleId);
  if (!article) return;

  const text = article.status === "ready" && article.summary_json
    ? readySuccessText(
      article.summary_json.title_ru,
      article.summary_json.tldr_ru,
      env.PUBLIC_BASE_URL.trim() || null,
    )
    : failedText((article.error ?? "unknown error").slice(0, 200));

  await editMessageText(config.botToken, config.ownerChatId, messageId, text).catch(() => {});
}

async function handleUrlMessage(
  c: Context<AppEnv>,
  config: TelegramConfig,
  url: string,
): Promise<Response> {
  const sent = await sendMessage(config.botToken, config.ownerChatId, SAVING_TEXT).catch(() =>
    null
  );

  const existingId = await findArticleIdByUrl(c.env.DB, url);
  if (existingId) {
    if (sent) {
      await editMessageText(
        config.botToken,
        config.ownerChatId,
        sent.message_id,
        ALREADY_SAVED_TEXT,
      )
        .catch(() => {});
    }
    return c.json({ ok: true });
  }

  const id = crypto.randomUUID();
  await insertPendingArticle(c.env.DB, {
    id,
    url,
    title: url,
    source: sourceFromUrl(url),
    tags: [],
    added_via: "telegram",
    added_at: new Date().toISOString(),
  });

  if (sent) {
    c.executionCtx.waitUntil(
      runPipelineAndNotify(c.env, config, id, url, sent.message_id),
    );
  } else {
    // Couldn't even send the "Сохраняю…" reply — still run the pipeline
    // (the article shouldn't silently vanish), just with no message left
    // to edit afterward.
    c.executionCtx.waitUntil(runArticlePipeline(c.env, { id, url, requestTags: [] }));
  }

  return c.json({ ok: true });
}

async function handleOwnerMessage(
  c: Context<AppEnv>,
  config: TelegramConfig,
  message: TelegramMessage,
): Promise<Response> {
  const text = (message.text ?? "").trim();

  if (text === "/start" || text === "/help") {
    await sendMessage(config.botToken, config.ownerChatId, HELP_TEXT).catch(() => {});
    return c.json({ ok: true });
  }

  if (text === "/digest") {
    await buildAndSendDigest(c.env, config, NO_DIGEST_ARTICLES_TEXT);
    return c.json({ ok: true });
  }

  if (text === "/scrape") {
    c.executionCtx.waitUntil(runAgentJob(c.env));
    await sendMessage(config.botToken, config.ownerChatId, AGENT_STARTED_TEXT).catch(() => {});
    return c.json({ ok: true });
  }

  const url = extractFirstUrl(message);
  if (!url) {
    await sendMessage(config.botToken, config.ownerChatId, HELP_TEXT).catch(() => {});
    return c.json({ ok: true });
  }

  return await handleUrlMessage(c, config, url);
}

// Telegram delivers updates via webhook and can't present a Cloudflare
// Access identity, so this path is intentionally public (not mounted under
// /api/admin/*) — its own auth is the secret header below, compared in
// constant time, plus the owner-chat gate on every message.
export async function handleTelegramWebhook(c: Context<AppEnv>): Promise<Response> {
  const config = readTelegramConfig(c.env);
  if (!config) {
    return c.json({ error: "not found" }, 404);
  }

  const providedSecret = c.req.header(SECRET_HEADER) ?? "";
  if (!timingSafeEqualStrings(providedSecret, config.webhookSecret)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = await c.req.json();
  } catch {
    // Never make Telegram retry-storm on a body it can't even have sent —
    // treat anything unparseable as a no-op, not an error.
    return c.json({ ok: true });
  }

  const message = update.message;
  if (!message) {
    // edited_message, channel_post, etc. — no-op.
    return c.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  if (message.chat.type !== "private" || chatId !== config.ownerChatId) {
    await sendMessage(config.botToken, chatId, NON_OWNER_REPLY).catch(() => {});
    return c.json({ ok: true });
  }

  return await handleOwnerMessage(c, config, message);
}
