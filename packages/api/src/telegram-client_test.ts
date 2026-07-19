import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { readTelegramConfig } from "./telegram-client.ts";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: {} as Ai,
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    DIGEST_HOUR_UTC: "6",
    PUBLIC_BASE_URL: "",
    ...overrides,
  };
}

Deno.test("readTelegramConfig: null when none of the three are set", () => {
  assertEquals(readTelegramConfig(makeEnv()), null);
});

Deno.test("readTelegramConfig: null when only some are set (partial config falls back to inactive)", () => {
  assertEquals(
    readTelegramConfig(makeEnv({ TELEGRAM_BOT_TOKEN: "123:abc" })),
    null,
  );
  assertEquals(
    readTelegramConfig(
      makeEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "secret" }),
    ),
    null,
  );
});

Deno.test("readTelegramConfig: null when values are whitespace-only", () => {
  assertEquals(
    readTelegramConfig(makeEnv({
      TELEGRAM_BOT_TOKEN: "  ",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      TELEGRAM_OWNER_CHAT_ID: "42",
    })),
    null,
  );
});

Deno.test("readTelegramConfig: returns trimmed config when all three are set", () => {
  const config = readTelegramConfig(makeEnv({
    TELEGRAM_BOT_TOKEN: " 123:abc ",
    TELEGRAM_WEBHOOK_SECRET: " secret ",
    TELEGRAM_OWNER_CHAT_ID: " 42 ",
  }));
  assertEquals(config, { botToken: "123:abc", webhookSecret: "secret", ownerChatId: "42" });
});
