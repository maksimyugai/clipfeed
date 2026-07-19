// Local Deno CLI: registers (or inspects) the Telegram webhook for this
// ClipFeed instance, and helps discover a chat id. Deno.* APIs are fine
// here — this is dev tooling, not code that ships to the Worker.
//
// Reads the bot token, webhook secret, and public base URL via interactive
// prompts by default. Deno's prompt() needs a real TTY (it returns null for
// piped/non-interactive stdin), so --token=/--secret=/--base-url= flags are
// also accepted for scripting — note those DO land in shell history, unlike
// a prompt answer, so prefer prompts for a one-off interactive run. Either
// way, this script never prints the bot token back once entered; the one
// exception is a webhook secret it generates on the user's behalf, which
// has to be shown at least once so it can be copied into `wrangler secret
// put`.

import { getUpdates, getWebhookInfo, setWebhook } from "../packages/api/src/telegram-client.ts";

const WEBHOOK_PATH = "/api/telegram/webhook";

function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function readRequired(flagName: string, label: string): string {
  const fromFlag = flagValue(flagName);
  const value = (fromFlag ?? prompt(label) ?? "").trim();
  if (!value) {
    console.error(`${label} is required (pass --${flagName}=... or answer the prompt).`);
    Deno.exit(1);
  }
  return value;
}

function readOptional(flagName: string, label: string): string {
  const fromFlag = flagValue(flagName);
  if (fromFlag !== null) return fromFlag.trim();
  return (prompt(label) ?? "").trim();
}

function randomSecret(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

async function runGetChatId(): Promise<void> {
  console.log("ClipFeed Telegram — find your chat id\n");
  console.log("Send at least one message to your bot on Telegram first, then continue here.\n");
  const botToken = readRequired("token", "Bot token (from @BotFather):");

  let updates: Awaited<ReturnType<typeof getUpdates>>;
  try {
    updates = await getUpdates(botToken);
  } catch (err) {
    console.error(`\n✗ getUpdates failed: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
  if (updates.length === 0) {
    console.log("\nNo updates found yet. Send a message to the bot, then run this again.");
    return;
  }

  console.log("\nChat IDs seen in recent updates:");
  const seen = new Set<string>();
  for (const update of updates) {
    const chat = update.message?.chat;
    if (!chat) continue;
    const key = `${chat.id}  (type: ${chat.type})`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${key}`);
  }
  if (seen.size === 0) {
    console.log("  (none of the recent updates were messages)");
  }
  console.log("\nUse the numeric id for your own private chat as TELEGRAM_OWNER_CHAT_ID.");
}

async function runSetup(): Promise<void> {
  console.log("ClipFeed Telegram bot setup\n");

  const botToken = readRequired("token", "Bot token (from @BotFather):");

  const webhookSecretInput = readOptional(
    "secret",
    "Webhook secret [press Enter to generate one]:",
  );
  const generated = webhookSecretInput === "";
  const webhookSecret = generated ? randomSecret() : webhookSecretInput;

  const publicBaseUrl = readRequired(
    "base-url",
    "Public base URL of your deployed Worker (e.g. https://example.com):",
  ).replace(/\/+$/, "");

  const webhookUrl = `${publicBaseUrl}${WEBHOOK_PATH}`;

  console.log(`\nCalling setWebhook -> ${webhookUrl} ...`);
  let ok: boolean;
  try {
    ok = await setWebhook(botToken, webhookUrl, webhookSecret);
  } catch (err) {
    console.error(`\n✗ setWebhook failed: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
  console.log(ok ? "✓ setWebhook succeeded" : "✗ setWebhook returned false");

  console.log("\nFetching getWebhookInfo...");
  let info: Awaited<ReturnType<typeof getWebhookInfo>>;
  try {
    info = await getWebhookInfo(botToken);
  } catch (err) {
    console.error(`\n✗ getWebhookInfo failed: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
  console.log(JSON.stringify(info, null, 2));
  if (info.last_error_message) {
    console.log(`\n⚠ Telegram reports a delivery error: ${info.last_error_message}`);
  }

  console.log("\n──────────────────────────────────────────");
  console.log("Next steps");
  console.log("──────────────────────────────────────────");
  console.log("Set these three secrets on the Worker (values are never printed by this script,");
  console.log("except the webhook secret below if you had this script generate one for you):");
  console.log("  deno run -A npm:wrangler secret put TELEGRAM_BOT_TOKEN");
  console.log("  deno run -A npm:wrangler secret put TELEGRAM_WEBHOOK_SECRET");
  console.log("  deno run -A npm:wrangler secret put TELEGRAM_OWNER_CHAT_ID");
  if (generated) {
    console.log(`\nGenerated webhook secret (for TELEGRAM_WEBHOOK_SECRET):\n  ${webhookSecret}`);
  }
  console.log("\nDon't know your chat id yet? Run:");
  console.log("  deno task telegram:setup --get-chat-id");
  console.log("──────────────────────────────────────────");
}

async function main(): Promise<void> {
  if (Deno.args.includes("--get-chat-id")) {
    await runGetChatId();
    return;
  }
  await runSetup();
}

if (import.meta.main) {
  await main();
}
