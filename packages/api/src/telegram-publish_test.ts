import "./env.d.ts";
import { assertEquals } from "@std/assert";
import {
  isPublishEnabled,
  isWithinPublishWindow,
  publishNextArticle,
  runPublishJob,
} from "./telegram-publish.ts";
import type { TelegramConfig } from "./telegram-client.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

// --- isWithinPublishWindow ---

Deno.test("isWithinPublishWindow: inside the default 4-18 window", () => {
  assertEquals(isWithinPublishWindow(4, undefined, undefined), true);
  assertEquals(isWithinPublishWindow(10, undefined, undefined), true);
  assertEquals(isWithinPublishWindow(17, undefined, undefined), true);
});

Deno.test("isWithinPublishWindow: outside the default window (end is exclusive)", () => {
  assertEquals(isWithinPublishWindow(3, undefined, undefined), false);
  assertEquals(isWithinPublishWindow(18, undefined, undefined), false);
  assertEquals(isWithinPublishWindow(23, undefined, undefined), false);
});

Deno.test("isWithinPublishWindow: a custom window is respected", () => {
  assertEquals(isWithinPublishWindow(1, "0", "6"), true);
  assertEquals(isWithinPublishWindow(6, "0", "6"), false);
  assertEquals(isWithinPublishWindow(23, "0", "6"), false);
});

Deno.test("isWithinPublishWindow: invalid/out-of-range hour values fall back to the documented default", () => {
  assertEquals(isWithinPublishWindow(4, "not-a-number", "18"), true);
  assertEquals(isWithinPublishWindow(3, "not-a-number", "18"), false);
  assertEquals(isWithinPublishWindow(17, "4", "25"), true); // end falls back to default 18
  assertEquals(isWithinPublishWindow(18, "4", "25"), false); // 18 excluded, same as the default
});

// --- isPublishEnabled ---

Deno.test("isPublishEnabled: defaults to true when unset/empty", () => {
  assertEquals(isPublishEnabled(undefined), true);
  assertEquals(isPublishEnabled(""), true);
});

Deno.test("isPublishEnabled: only the literal 'false' disables it", () => {
  assertEquals(isPublishEnabled("false"), false);
  assertEquals(isPublishEnabled("FALSE"), false);
  assertEquals(isPublishEnabled(" false "), false);
  assertEquals(isPublishEnabled("true"), true);
  assertEquals(isPublishEnabled("nope"), true);
});

// --- publishNextArticle / runPublishJob ---

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: "test-secret",
  ownerChatId: "999",
};

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

function stubTelegramFetch(): { restore: () => void; calls: TelegramCall[] } {
  const original = globalThis.fetch;
  const calls: TelegramCall[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const match = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
    if (match) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push({ method: match[1], body });
      return Promise.resolve(Response.json({ ok: true, result: { message_id: 1 } }));
    }
    return Promise.resolve(new Response("not used", { status: 404 }));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1() as unknown as D1Database,
    CACHE: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: { run: () => Promise.reject(new Error("AI.run should not be called")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    PUBLIC_BASE_URL: "https://clipfeed.example.com",
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "",
    AGENT_DAILY_PICKS: "10",
    SUMMARY_BODY_TARGET_CHARS: "1200",
    ...overrides,
  };
}

const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Title",
  tldr_ru: "Краткое содержание.",
  tldr_en: "Short summary.",
  body_ru: ["Абзац."],
  body_en: ["Paragraph."],
  bullets_ru: ["Пункт один.", "Пункт два."],
  bullets_en: ["Point one.", "Point two."],
  tags: ["tech"],
  lang_original: "en",
};

function insertReadyArticle(
  db: FakeD1,
  overrides: {
    id: string;
    added_at: string;
    faithfulness_verdict?: string | null;
    telegram_published_at?: string | null;
    archived?: number;
  },
) {
  db.rows.push({
    id: overrides.id,
    url: `https://example.com/${overrides.id}`,
    canonical_url: null,
    title: "Some title",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: overrides.added_at,
    added_via: "agent",
    lang_original: "en",
    full_text: "full text",
    summary_ru: "summary",
    summary_en: "summary",
    summary_json: JSON.stringify(VALID_SUMMARY),
    tags: "[]",
    status: "ready",
    archived: overrides.archived ?? 0,
    error: null,
    fail_class: null,
    heal_attempts: 0,
    faithfulness_verdict: overrides.faithfulness_verdict ?? null,
    faithfulness_json: null,
    faithfulness_checked_at: null,
    embedded_at: null,
    telegram_published_at: overrides.telegram_published_at ?? null,
  });
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

Deno.test("publishNextArticle: empty queue -> 'empty', no Telegram call", async () => {
  const stub = stubTelegramFetch();
  try {
    const env = makeEnv();
    const outcome = await publishNextArticle(env, CONFIG);
    assertEquals(outcome, { kind: "empty" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: publishes the oldest ready/unpublished/non-archived article, sends HTML to the owner chat when no channel is set", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "older", added_at: hoursAgo(10) });
    insertReadyArticle(db, { id: "newer", added_at: hoursAgo(1) });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG);
    assertEquals(outcome, { kind: "published", articleId: "older" });

    assertEquals(stub.calls.length, 1);
    assertEquals(stub.calls[0].method, "sendMessage");
    assertEquals(stub.calls[0].body.chat_id, "999");
    assertEquals(stub.calls[0].body.parse_mode, "HTML");
    assertEquals((stub.calls[0].body.text as string).includes("Заголовок"), true);

    const row = db.rows.find((r) => r.id === "older")!;
    assertEquals(typeof row.telegram_published_at, "string");
    const untouched = db.rows.find((r) => r.id === "newer")!;
    assertEquals(untouched.telegram_published_at, null);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: sends to TELEGRAM_CHANNEL_ID when set, not the owner chat", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: hoursAgo(1) });
    const env = makeEnv({ DB: db as unknown as D1Database, TELEGRAM_CHANNEL_ID: "@my_channel" });

    await publishNextArticle(env, CONFIG);
    assertEquals(stub.calls[0].body.chat_id, "@my_channel");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: a faithfulness 'fail' verdict is skipped — no Telegram call, but still marked published so the queue advances", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, {
      id: "bad",
      added_at: hoursAgo(1),
      faithfulness_verdict: "fail",
    });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG);
    assertEquals(outcome, { kind: "skipped-unfaithful", articleId: "bad" });
    assertEquals(stub.calls.length, 0);

    const row = db.rows.find((r) => r.id === "bad")!;
    assertEquals(typeof row.telegram_published_at, "string");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an already-published article is never picked again", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, {
      id: "done",
      added_at: hoursAgo(2),
      telegram_published_at: hoursAgo(1),
    });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG);
    assertEquals(outcome, { kind: "empty" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an archived article is never picked", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "archived", added_at: hoursAgo(1), archived: 1 });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG);
    assertEquals(outcome, { kind: "empty" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an article older than the 48h lookback is not picked (no ancient backlog dripping out)", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    const ancient = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    insertReadyArticle(db, { id: "ancient", added_at: ancient });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG);
    assertEquals(outcome, { kind: "empty" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

// --- runPublishJob ---

Deno.test("runPublishJob: no-op when Telegram isn't configured", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: "2026-01-01T00:00:00.000Z" });
    const env = makeEnv({ DB: db as unknown as D1Database });
    await runPublishJob(env);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: no-op when PUBLISH_ENABLED is 'false'", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: "2026-01-01T00:00:00.000Z" });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "false",
    });
    await runPublishJob(env);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: publishes when Telegram is configured, enabled, and the current hour is inside the window", async () => {
  const stub = stubTelegramFetch();
  try {
    const nowMs = new Date("2026-01-02T10:00:00.000Z").getTime();
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: "2026-01-01T00:00:00.000Z" });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "true",
    });
    await runPublishJob(env, nowMs);
    assertEquals(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: does nothing outside the publish window, even with a ready article waiting", async () => {
  const stub = stubTelegramFetch();
  try {
    const nowMs = new Date("2026-01-02T02:00:00.000Z").getTime(); // before default 4am start
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: "2026-01-01T00:00:00.000Z" });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "true",
    });
    await runPublishJob(env, nowMs);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: a Telegram send failure is swallowed (never throws), and does not mark the article published", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const nowMs = new Date("2026-01-02T10:00:00.000Z").getTime();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 500 }),
      )) as typeof fetch;

    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: "2026-01-01T00:00:00.000Z" });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "true",
    });

    await runPublishJob(env, nowMs); // must not throw

    const row = db.rows.find((r) => r.id === "a1")!;
    assertEquals(row.telegram_published_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
