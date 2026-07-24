import "../env.d.ts";

export interface TelegramConfig {
  botToken: string;
  webhookSecret: string;
  ownerChatId: string;
}

// The Telegram feature is active only when all three are set (trimmed
// non-empty) — same "complete config or nothing" pattern as the other
// optional integrations (Access, Turnstile) in this codebase.
export function readTelegramConfig(env: Env): TelegramConfig | null {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const webhookSecret = (env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  const ownerChatId = (env.TELEGRAM_OWNER_CHAT_ID ?? "").trim();
  if (!botToken || !webhookSecret || !ownerChatId) return null;
  return { botToken, webhookSecret, ownerChatId };
}

// Names only, never values — used by the webhook handler to log which
// secret(s) are missing when the feature is inactive (see
// telegram-webhook.ts's warnMissingTelegramSecretsOnce). A webhook
// registered with Telegram but missing one of these three secrets
// otherwise 404s on every delivery with zero diagnostic trail.
export function missingTelegramSecretNames(env: Env): string[] {
  const missing: string[] = [];
  if (!(env.TELEGRAM_BOT_TOKEN ?? "").trim()) missing.push("TELEGRAM_BOT_TOKEN");
  if (!(env.TELEGRAM_WEBHOOK_SECRET ?? "").trim()) missing.push("TELEGRAM_WEBHOOK_SECRET");
  if (!(env.TELEGRAM_OWNER_CHAT_ID ?? "").trim()) missing.push("TELEGRAM_OWNER_CHAT_ID");
  return missing;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string; // present for "text_link" entities
}

export interface TelegramChat {
  id: number;
  type: string; // "private" | "group" | "supergroup" | "channel"
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  entities?: TelegramMessageEntity[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface SentMessage {
  message_id: number;
}

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

const API_BASE = "https://api.telegram.org";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

// Task 47 Part B §5: every failed Bot API call gets logged here, at the one
// choke point both the JSON and multipart transports funnel through — the
// method name, the `ok`/`error_code`/`description` fields Telegram actually
// returned, and the HTTP status. Never the token (never in the URL either —
// only logged as "telegram <method>") and never the full request/response
// body, which for sendPhoto could echo back arbitrary image bytes.
async function parseTelegramResponse<T>(method: string, res: Response): Promise<T> {
  const data = await res.json().catch(() => null) as TelegramApiResponse<T> | null;
  if (!res.ok || !data?.ok) {
    console.error(JSON.stringify({
      event: "telegram_api_error",
      method,
      status: res.status,
      ok: data?.ok ?? false,
      error_code: data?.error_code,
      description: data?.description,
    }));
    throw new Error(`telegram ${method}: request failed (status ${res.status})`);
  }
  return data.result as T;
}

// The bot token lives inline in every request URL, so this — and every
// caller — never logs the URL itself, only the method name (see
// parseTelegramResponse above for where failures actually get logged).
async function callTelegram<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`telegram ${method}: network error`);
  }
  return await parseTelegramResponse<T>(method, res);
}

// Task 47 Part B §1: sendPhoto's multipart transport — a photo passed as a
// `file` field is UPLOADED, never a URL Telegram would have to fetch back
// from us (fetching is exactly the step that's been silently failing). No
// `content-type` header is set here on purpose: fetch computes the
// multipart boundary itself from the FormData body, and setting one by hand
// risks a mismatched boundary that Telegram would reject outright.
async function callTelegramForm<T>(
  botToken: string,
  method: string,
  form: FormData,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${botToken}/${method}`, { method: "POST", body: form });
  } catch {
    throw new Error(`telegram ${method}: network error`);
  }
  return await parseTelegramResponse<T>(method, res);
}

// Task 46 Part B: mirrors Bot API 7.0+'s link_preview_options object
// (api.telegram.org has run 7.0+ since Jan 2024 — nothing in this plain-fetch
// client pins an older API version, so no compatibility shim is needed).
// `url` pins the preview to a SPECIFIC link in the message, removing any
// ambiguity about which of several links (or an auto-linkified bare domain)
// Telegram's crawler would otherwise guess at.
export interface LinkPreviewOptions {
  url?: string;
  preferLargeMedia?: boolean;
  showAboveText?: boolean;
}

export interface SendMessageOptions {
  parseMode?: "HTML";
  linkPreviewOptions?: LinkPreviewOptions;
}

function toTelegramLinkPreviewOptions(
  options: LinkPreviewOptions,
): Record<string, unknown> {
  return {
    ...(options.url ? { url: options.url } : {}),
    ...(options.preferLargeMedia !== undefined
      ? { prefer_large_media: options.preferLargeMedia }
      : {}),
    ...(options.showAboveText !== undefined ? { show_above_text: options.showAboveText } : {}),
  };
}

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
  options?: SendMessageOptions,
): Promise<SentMessage> {
  return await callTelegram<SentMessage>(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options?.linkPreviewOptions
      ? { link_preview_options: toTelegramLinkPreviewOptions(options.linkPreviewOptions) }
      : {}),
  });
}

export interface SendPhotoOptions {
  caption?: string;
  parseMode?: "HTML";
}

// Task 47 Part B §1: uploads the photo BYTES directly — Telegram never
// fetches anything from us for this call, unlike a URL-based photo or the
// og:image-driven link preview this replaces. `filename` only affects the
// multipart field's own metadata (Telegram infers the actual image format
// from the bytes), so any name is fine as long as its extension is
// consistent with `contentType` for well-behaved intermediaries.
export async function sendPhoto(
  botToken: string,
  chatId: string,
  photoBytes: Uint8Array,
  filename: string,
  contentType: string,
  options?: SendPhotoOptions,
): Promise<SentMessage> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([photoBytes.slice()], { type: contentType }), filename);
  if (options?.caption) form.append("caption", options.caption);
  if (options?.parseMode) form.append("parse_mode", options.parseMode);
  return await callTelegramForm<SentMessage>(botToken, "sendPhoto", form);
}

export async function editMessageText(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  await callTelegram(botToken, "editMessageText", { chat_id: chatId, message_id: messageId, text });
}

// Used by scripts/telegram-setup.ts (Deno-side), not by the Worker.
export async function setWebhook(
  botToken: string,
  url: string,
  secretToken: string,
): Promise<boolean> {
  return await callTelegram<boolean>(botToken, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
  });
}

export async function getWebhookInfo(botToken: string): Promise<WebhookInfo> {
  return await callTelegram<WebhookInfo>(botToken, "getWebhookInfo", {});
}

// Used by scripts/telegram-setup.ts's --delete-webhook flag: Telegram
// forbids getUpdates (long-polling) while a webhook is registered, so
// discovering a chat id via --get-chat-id needs the webhook temporarily
// gone. Re-running setup afterward re-registers it.
export async function deleteWebhook(botToken: string): Promise<boolean> {
  return await callTelegram<boolean>(botToken, "deleteWebhook", {});
}

export async function getUpdates(botToken: string): Promise<TelegramUpdate[]> {
  return await callTelegram<TelegramUpdate[]>(botToken, "getUpdates", {});
}
