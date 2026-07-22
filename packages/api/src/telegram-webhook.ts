import "./env.d.ts";
import type { Context } from "hono";
import type { AppEnv } from "./access-middleware.ts";
import {
  editMessageText,
  missingTelegramSecretNames,
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
  HELP_TEXT,
  NO_DIGEST_ARTICLES_TEXT,
  NON_OWNER_REPLY,
  PUBLISH_EMPTY_TEXT,
  PUBLISH_FAILED_TEXT,
  PUBLISH_SKIPPED_TEXT,
  PUBLISH_SUCCESS_TEXT,
  SAVING_TEXT,
} from "./telegram-strings.ts";
import { timingSafeEqualStrings } from "./telegram-secret.ts";
import { findArticleIdByUrl, insertPendingArticle, listRecentReadyArticles } from "./db.ts";
import { enqueueArticleJob } from "./queue.ts";
import { sourceFromUrl } from "./validation.ts";
import { runAgentJob } from "./agent.ts";
import { publishNextArticle } from "./telegram-publish.ts";

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

// Task 24 Part C's similar-title 409 (see index.ts's POST /api/admin/articles)
// is deliberately NOT applied here: a Telegram message carries only a raw
// URL, never a title — the real title is only known once the pipeline
// fetches and extracts the page, which happens asynchronously in the queue
// consumer (or its inline fallback), never synchronously inside this
// webhook handler (see README "Queue-based pipeline execution" for why that
// split exists — a 30s waitUntil cap). Running the check here would mean
// fetching the article twice (once just to get a title to compare, once
// again in the real pipeline), which isn't worth it for one save path when
// the exact-URL check below already catches a literal re-share. This is a
// stated limitation, not an oversight.
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

  // If "Сохраняю…" couldn't even be sent, the pipeline still runs (the
  // article shouldn't silently vanish) — just with no notify target, so
  // there's no message left to edit afterward. The edit-on-finish itself
  // happens in the queue consumer (or its no-JOBS fallback), not here — see
  // queue.ts's processQueueMessage/notifyTelegram.
  const notify = sent ? { chatId: config.ownerChatId, messageId: sent.message_id } : undefined;
  await enqueueArticleJob(c.env, c.executionCtx, { kind: "process", articleId: id, notify });

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

  // Owner-only, same auth as every other command here (the owner-chat gate
  // in handleTelegramWebhook below already ran before we got this far).
  // Bypasses the drip job's window/PUBLISH_ENABLED gating on purpose — this
  // is an explicit manual override, not the cron — but reuses the exact
  // same publishNextArticle core (candidate selection, faithfulness skip,
  // idempotency marker) so there's only one publish code path to reason
  // about.
  if (text === "/publish") {
    const outcome = await publishNextArticle(c.env, config).catch((err) => {
      console.error(
        JSON.stringify({ event: "telegram_publish_command_failed", error: String(err) }),
      );
      return null;
    });
    const reply = outcome === null
      ? PUBLISH_FAILED_TEXT
      : outcome.kind === "empty"
      ? PUBLISH_EMPTY_TEXT
      : outcome.kind === "skipped-unfaithful"
      ? PUBLISH_SKIPPED_TEXT
      : PUBLISH_SUCCESS_TEXT;
    await sendMessage(config.botToken, config.ownerChatId, reply).catch(() => {});
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
// Module-level: survives across requests within the same isolate, resets
// only on a fresh isolate spin-up ("once per isolate", not "once ever" or
// "once per request"). A webhook registered with Telegram but missing one
// of the three TELEGRAM_* secrets otherwise 404s on every single delivery
// with zero diagnostic trail — this warn (names only, never values) is the
// only signal an owner gets short of noticing pending_update_count climb
// in getWebhookInfo. Exported so tests can reset it between cases.
let warnedMissingTelegramSecrets = false;

export function resetMissingTelegramSecretsWarningForTest(): void {
  warnedMissingTelegramSecrets = false;
}

function warnMissingTelegramSecretsOnce(env: Env): void {
  if (warnedMissingTelegramSecrets) return;
  const missing = missingTelegramSecretNames(env);
  if (missing.length === 0) return;
  warnedMissingTelegramSecrets = true;
  console.warn(JSON.stringify({ event: "telegram_webhook_inactive_missing_secrets", missing }));
}

export async function handleTelegramWebhook(c: Context<AppEnv>): Promise<Response> {
  const config = readTelegramConfig(c.env);
  if (!config) {
    warnMissingTelegramSecretsOnce(c.env);
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
