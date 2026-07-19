import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { app } from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import type { TelegramMessage, TelegramUpdate } from "./telegram-client.ts";

const OWNER_CHAT_ID = "999";
const OTHER_CHAT_ID = "555";
const WEBHOOK_SECRET = "test-webhook-secret";

const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Example Title",
  tldr_ru: "Кратко об этом. Ещё немного.",
  tldr_en: "Short summary.",
  bullets_ru: ["П1"],
  bullets_en: ["Point 1"],
  tags: ["technology"],
  lang_original: "en",
};

const ARTICLE_HTML = "<html><head><title>Example</title></head><body><article><h1>Example</h1>" +
  "<p>Hello world, this is the first paragraph of example content.</p></article></body></html>";

function makeEnv(overrides: Partial<Env> = {}): Env {
  const kv = new Map<string, string>();
  return {
    DB: new FakeD1(),
    CACHE: {
      get(key: string): Promise<string | null> {
        return Promise.resolve(kv.get(key) ?? null);
      },
      put(key: string, value: string): Promise<void> {
        kv.set(key, value);
        return Promise.resolve();
      },
    },
    ASSETS: { fetch: () => Promise.resolve(new Response("not used")) },
    AI: { run: () => Promise.reject(new Error("AI.run should not be called in these tests")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    PUBLIC_BASE_URL: "",
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    DIGEST_HOUR_UTC: "6",
    ANTHROPIC_API_KEY: "test-key",
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_OWNER_CHAT_ID: OWNER_CHAT_ID,
    ...overrides,
  };
}

function makeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      props: {},
      waitUntil(promise: Promise<unknown>): void {
        pending.push(promise);
      },
      passThroughOnException(): void {},
    },
    settle: () => Promise.all(pending),
  };
}

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

// Stubs every fetch() the webhook path can make: the Telegram Bot API
// (every call recorded, never hitting the real API), Anthropic
// summarization, and the article's own HTML fetch — so a full save round
// trip can run end to end without any network access.
function stubFetch(opts: { anthropicStatus?: number } = {}): {
  restore: () => void;
  telegramCalls: TelegramCall[];
} {
  const originalFetch = globalThis.fetch;
  const telegramCalls: TelegramCall[] = [];
  let nextMessageId = 1000;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();

    const tgMatch = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
    if (tgMatch) {
      const method = tgMatch[1];
      const body = init?.body ? JSON.parse(init.body as string) : {};
      telegramCalls.push({ method, body });
      if (method === "sendMessage") {
        return Promise.resolve(
          Response.json({ ok: true, result: { message_id: nextMessageId++ } }),
        );
      }
      return Promise.resolve(Response.json({ ok: true, result: true }));
    }

    if (url.startsWith("https://api.anthropic.com")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
          { status: opts.anthropicStatus ?? 200 },
        ),
      );
    }

    return Promise.resolve(
      new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    );
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    telegramCalls,
  };
}

function messageUpdate(message: Partial<TelegramMessage>): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: Number(OWNER_CHAT_ID), type: "private" },
      ...message,
    },
  };
}

// null means "omit the header" — NOT the same as leaving the parameter
// unpassed, since a JS default parameter also kicks in for an explicit
// `undefined` argument, which would silently defeat a "missing header" test.
function webhookRequest(
  env: Env,
  ctx: ReturnType<typeof makeExecutionContext>["ctx"],
  body: unknown,
  secretHeader: string | null = WEBHOOK_SECRET,
) {
  return app.request(
    "/api/telegram/webhook",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secretHeader !== null ? { "X-Telegram-Bot-Api-Secret-Token": secretHeader } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
    ctx,
  );
}

Deno.test("webhook: 404 when the Telegram feature isn't configured", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv({
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_WEBHOOK_SECRET: undefined,
      TELEGRAM_OWNER_CHAT_ID: undefined,
    });
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/help" }));
    assertEquals(res.status, 404);
    assertEquals(stub.telegramCalls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: 401 with a missing secret header", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/help" }), null);
    assertEquals(res.status, 401);
    assertEquals(stub.telegramCalls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: 401 with a wrong secret header", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/help" }), "wrong-secret");
    assertEquals(res.status, 401);
    assertEquals(stub.telegramCalls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: garbage (non-JSON) body -> 200 no-op, no Telegram calls, nothing persisted", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(env, ctx, "this is not json");
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 0);
    assertEquals((env.DB as FakeD1).rows.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: edited_message/other update types are a no-op", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(env, ctx, {
      update_id: 1,
      edited_message: { message_id: 1, chat: { id: Number(OWNER_CHAT_ID), type: "private" } },
    });
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: non-owner chat gets a polite refusal, no pipeline call", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(
      env,
      ctx,
      messageUpdate({ chat: { id: Number(OTHER_CHAT_ID), type: "private" }, text: "hello" }),
    );
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(stub.telegramCalls[0].method, "sendMessage");
    assertEquals(stub.telegramCalls[0].body.chat_id, OTHER_CHAT_ID);
    assertEquals(stub.telegramCalls[0].body.text, "Это персональный бот.");
    assertEquals((env.DB as FakeD1).rows.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: /start and /help reply with the help text", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    for (const command of ["/start", "/help"]) {
      stub.telegramCalls.length = 0;
      const res = await webhookRequest(env, ctx, messageUpdate({ text: command }));
      assertEquals(res.status, 200);
      assertEquals(stub.telegramCalls.length, 1);
      assertEquals(stub.telegramCalls[0].method, "sendMessage");
      assertEquals(
        (stub.telegramCalls[0].body.text as string).includes("Отправь ссылку"),
        true,
      );
    }
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: a message with no URL and no command replies with the help text", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(env, ctx, messageUpdate({ text: "just saying hi" }));
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(
      (stub.telegramCalls[0].body.text as string).includes("Отправь ссылку"),
      true,
    );
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: owner URL message -> immediate 'saving' reply, pipeline runs with added_via 'telegram', edits to success", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx, settle } = makeExecutionContext();

    const res = await webhookRequest(
      env,
      ctx,
      messageUpdate({ text: "check this out: https://example.com/tg-article" }),
    );
    assertEquals(res.status, 200);
    await settle();

    const db = env.DB as FakeD1;
    assertEquals(db.rows.length, 1);
    assertEquals(db.rows[0].added_via, "telegram");
    assertEquals(db.rows[0].url, "https://example.com/tg-article");
    assertEquals(db.rows[0].status, "ready");

    assertEquals(stub.telegramCalls[0].method, "sendMessage");
    assertEquals(stub.telegramCalls[0].body.text, "Сохраняю…");

    const editCall = stub.telegramCalls.find((c) => c.method === "editMessageText");
    assertEquals(editCall !== undefined, true);
    assertEquals((editCall!.body.text as string).startsWith("✓ Заголовок"), true);
    assertEquals((editCall!.body.text as string).includes("Кратко об этом."), true);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: owner URL message -> edits to a failure message when the pipeline fails", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv({ DAILY_SUMMARY_LIMIT: 0 });
    const { ctx, settle } = makeExecutionContext();

    await webhookRequest(env, ctx, messageUpdate({ text: "https://example.com/tg-fail" }));
    await settle();

    const db = env.DB as FakeD1;
    assertEquals(db.rows[0].status, "failed");

    const editCall = stub.telegramCalls.find((c) => c.method === "editMessageText");
    assertEquals(editCall !== undefined, true);
    assertEquals((editCall!.body.text as string).startsWith("✗ Не получилось: daily-limit"), true);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: duplicate URL -> immediate 'already saved' edit, no second pipeline run", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx, settle } = makeExecutionContext();

    await webhookRequest(env, ctx, messageUpdate({ text: "https://example.com/tg-dup" }));
    await settle();
    const db = env.DB as FakeD1;
    assertEquals(db.rows.length, 1);

    stub.telegramCalls.length = 0;
    await webhookRequest(env, ctx, messageUpdate({ text: "https://example.com/tg-dup" }));
    await settle();

    assertEquals(db.rows.length, 1); // no second row inserted
    const editCall = stub.telegramCalls.find((c) => c.method === "editMessageText");
    assertEquals(editCall!.body.text, "Уже сохранено");
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: /digest with no ready articles in the last 24h replies with a 'nothing new' message", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/digest" }));
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(stub.telegramCalls[0].body.text, "За последние сутки новых статей нет.");
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: /digest sends a digest message once an article is ready", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx, settle } = makeExecutionContext();

    await webhookRequest(env, ctx, messageUpdate({ text: "https://example.com/tg-digest" }));
    await settle();

    stub.telegramCalls.length = 0;
    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/digest" }));
    assertEquals(res.status, 200);

    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(stub.telegramCalls[0].method, "sendMessage");
    assertEquals(
      (stub.telegramCalls[0].body.text as string).startsWith("ClipFeed — за сутки: 1 статей"),
      true,
    );
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: /scrape replies 'Запустил агента' immediately and runs the agent job via waitUntil", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx, settle } = makeExecutionContext();

    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/scrape" }));
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(stub.telegramCalls[0].method, "sendMessage");
    assertEquals(stub.telegramCalls[0].body.text, "Запустил агента");

    // The reply is sent before the agent job settles — waitUntil is what
    // actually runs it. Awaiting settle() here just proves it completes
    // without throwing (all six real sources.json sources see the generic
    // ARTICLE_HTML fallback from stubFetch, so the job legitimately finds
    // zero real candidates and still finishes cleanly).
    await settle();
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: a non-owner chat never triggers /scrape", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();
    const res = await webhookRequest(
      env,
      ctx,
      messageUpdate({ text: "/scrape", chat: { id: Number(OTHER_CHAT_ID), type: "private" } }),
    );
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(stub.telegramCalls[0].body.text, "Это персональный бот.");
  } finally {
    stub.restore();
  }
});
