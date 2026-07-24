import "../env.d.ts";
import { assertEquals } from "@std/assert";
import {
  missingTelegramSecretNames,
  readTelegramConfig,
  sendMessage,
  sendPhoto,
} from "./telegram-client.ts";

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
    QUEUE_WAIT_TIMEOUT_MIN: 30,
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    AGENT_DAILY_PICKS: "10",
    SUMMARY_BODY_TARGET_CHARS: "1200",
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

// --- missingTelegramSecretNames: names only, used to warn on a silently-404ing webhook ---

Deno.test("missingTelegramSecretNames: all three missing when none are set", () => {
  assertEquals(
    missingTelegramSecretNames(makeEnv()),
    ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_OWNER_CHAT_ID"],
  );
});

Deno.test("missingTelegramSecretNames: lists exactly the ones that are unset, in a fixed order", () => {
  assertEquals(
    missingTelegramSecretNames(makeEnv({ TELEGRAM_WEBHOOK_SECRET: "secret" })),
    ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID"],
  );
});

Deno.test("missingTelegramSecretNames: whitespace-only counts as missing", () => {
  assertEquals(
    missingTelegramSecretNames(makeEnv({
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_WEBHOOK_SECRET: "   ",
      TELEGRAM_OWNER_CHAT_ID: "42",
    })),
    ["TELEGRAM_WEBHOOK_SECRET"],
  );
});

Deno.test("missingTelegramSecretNames: empty array when all three are set", () => {
  assertEquals(
    missingTelegramSecretNames(makeEnv({
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      TELEGRAM_OWNER_CHAT_ID: "42",
    })),
    [],
  );
});

// --- sendMessage: link_preview_options (Task 46 Part B) ---

function stubFetchCapturingBody(): { restore: () => void; body: () => Record<string, unknown> } {
  const original = globalThis.fetch;
  let captured: Record<string, unknown> = {};
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    captured = init?.body ? JSON.parse(init.body as string) : {};
    return Promise.resolve(Response.json({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), body: () => captured };
}

Deno.test("sendMessage: with no options, the request body has no parse_mode and no link_preview_options keys at all", async () => {
  const stub = stubFetchCapturingBody();
  try {
    await sendMessage("token", "42", "hello");
    const body = stub.body();
    assertEquals("parse_mode" in body, false);
    assertEquals("link_preview_options" in body, false);
  } finally {
    stub.restore();
  }
});

Deno.test("sendMessage: linkPreviewOptions is sent as a nested JSON object, not a string, with snake_case keys", async () => {
  const stub = stubFetchCapturingBody();
  try {
    await sendMessage("token", "42", "hello", {
      parseMode: "HTML",
      linkPreviewOptions: {
        url: "https://clipfeed.example.com/a/id-1",
        preferLargeMedia: true,
        showAboveText: true,
      },
    });
    const body = stub.body();
    assertEquals(body.parse_mode, "HTML");
    assertEquals(typeof body.link_preview_options, "object");
    assertEquals(body.link_preview_options, {
      url: "https://clipfeed.example.com/a/id-1",
      prefer_large_media: true,
      show_above_text: true,
    });
  } finally {
    stub.restore();
  }
});

Deno.test("sendMessage: linkPreviewOptions with only some fields set omits the rest", async () => {
  const stub = stubFetchCapturingBody();
  try {
    await sendMessage("token", "42", "hello", { linkPreviewOptions: { url: "https://x.test" } });
    assertEquals(stub.body().link_preview_options, { url: "https://x.test" });
  } finally {
    stub.restore();
  }
});

Deno.test("sendMessage: never sends disable_web_page_preview — that field doesn't exist on our options type", async () => {
  const stub = stubFetchCapturingBody();
  try {
    await sendMessage("token", "42", "hello", {
      linkPreviewOptions: { url: "https://x.test", preferLargeMedia: true, showAboveText: true },
    });
    assertEquals("disable_web_page_preview" in stub.body(), false);
  } finally {
    stub.restore();
  }
});

// --- sendPhoto (Task 47 Part B §1): multipart upload, never a URL ---

interface CapturedMultipart {
  fields: Record<string, string>;
  photo: { name: string; type: string; size: number } | null;
}

function stubFetchCapturingForm(): { restore: () => void; captured: () => CapturedMultipart } {
  const original = globalThis.fetch;
  let captured: CapturedMultipart = { fields: {}, photo: null };
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    const fields: Record<string, string> = {};
    let photo: CapturedMultipart["photo"] = null;
    for (const [key, value] of form.entries()) {
      if (value instanceof File) {
        photo = { name: value.name, type: value.type, size: value.size };
      } else {
        fields[key] = value as string;
      }
    }
    captured = { fields, photo };
    return Promise.resolve(Response.json({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), captured: () => captured };
}

Deno.test("sendPhoto: uploads the photo as a multipart file field, never as a URL string", async () => {
  const stub = stubFetchCapturingForm();
  try {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await sendPhoto("token", "42", bytes, "article.jpg", "image/jpeg", {
      caption: "hello",
      parseMode: "HTML",
    });
    const { fields, photo } = stub.captured();
    assertEquals(fields.chat_id, "42");
    assertEquals(fields.caption, "hello");
    assertEquals(fields.parse_mode, "HTML");
    assertEquals(photo, { name: "article.jpg", type: "image/jpeg", size: 5 });
  } finally {
    stub.restore();
  }
});

Deno.test("sendPhoto: omits caption/parse_mode fields entirely when not provided", async () => {
  const stub = stubFetchCapturingForm();
  try {
    await sendPhoto("token", "42", new Uint8Array([1]), "a.png", "image/png");
    const { fields } = stub.captured();
    assertEquals("caption" in fields, false);
    assertEquals("parse_mode" in fields, false);
  } finally {
    stub.restore();
  }
});

Deno.test("sendPhoto: a failed Bot API response logs ok/error_code/description and throws, never the token", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (msg: string) => logs.push(msg);
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    )) as typeof fetch;
  try {
    let threw = false;
    try {
      await sendPhoto("super-secret-token", "42", new Uint8Array([1]), "a.png", "image/png");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.event, "telegram_api_error");
    assertEquals(parsed.method, "sendPhoto");
    assertEquals(parsed.ok, false);
    assertEquals(parsed.error_code, 400);
    assertEquals(parsed.description, "Bad Request: chat not found");
    assertEquals(logs[0].includes("super-secret-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
