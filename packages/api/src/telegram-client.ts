import "./env.d.ts";

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
  description?: string;
}

// The bot token lives inline in every request URL, so this — and every
// caller — logs the method name only, never the URL or the response body
// (which could echo the token back in an error description).
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

  const data = await res.json().catch(() => null) as TelegramApiResponse<T> | null;
  if (!res.ok || !data?.ok) {
    throw new Error(`telegram ${method}: request failed (status ${res.status})`);
  }
  return data.result as T;
}

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<SentMessage> {
  return await callTelegram<SentMessage>(botToken, "sendMessage", { chat_id: chatId, text });
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

export async function getUpdates(botToken: string): Promise<TelegramUpdate[]> {
  return await callTelegram<TelegramUpdate[]>(botToken, "getUpdates", {});
}
