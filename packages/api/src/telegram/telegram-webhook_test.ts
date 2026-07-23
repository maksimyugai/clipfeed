import "../env.d.ts";
import { assertEquals } from "@std/assert";
import { app } from "../index.ts";
import { FakeD1 } from "../testing/fake_d1.ts";
import { FakeQueue } from "../testing/fake_queue.ts";
import type { TelegramMessage, TelegramUpdate } from "./telegram-client.ts";
import { resetMissingTelegramSecretsWarningForTest } from "./telegram-webhook.ts";
import { recordAgentRun } from "../agent/agent-run-tracker.ts";

const OWNER_CHAT_ID = "999";
const OTHER_CHAT_ID = "555";
const WEBHOOK_SECRET = "test-webhook-secret";

// Meets validateSummary's content bar (>=120 char tldrs, 3-6 bullets each
// 20-220 chars and not duplicating the tldr, 1-6 tags) — see summarize.ts.
// Keeps the "Кратко об этом." lead-in the assertion below checks for.
const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Example Title",
  tldr_ru:
    "Кратко об этом. Компания повышает стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы и трафик. Изменение затронет около 2 миллионов подписчиков сервиса, а годовые подписчики получат отсрочку до продления плана.",
  tldr_en:
    "Short summary. The company is raising its subscription price from $5 to $8 a month starting September 1, citing rising server and bandwidth costs. The change affects roughly 2 million subscribers, though annual-plan subscribers get a grace period until renewal.",
  body_ru: [
    "Компания объявила об изменении во вторник, уточнив, что новый тариф вступит в силу с 1 сентября. Рост стоимости составляет почти 60% по сравнению с текущей ценой. Затронутыми окажутся примерно 2 миллиона подписчиков сервиса, при этом клиенты, уже оформившие годовой план, не почувствуют изменения сразу.",
    "В компании ссылаются на растущие расходы на серверную инфраструктуру и сетевой трафик как на основную причину решения. Руководство отмечало, что откладывало повышение более года, опасаясь навредить клиентам из малого бизнеса, но в итоге пришло к выводу, что дальнейшая отсрочка невозможна из-за продолжающегося роста издержек.",
  ],
  body_en: [
    "The company announced the change on Tuesday, confirming the new rate takes effect September 1. The increase amounts to nearly 60% over the current price. Roughly 2 million subscribers are affected, though customers already on an annual plan won't see the new rate right away, since their existing terms carry over until renewal.",
    "Executives point to climbing server infrastructure and network costs as the primary driver behind the decision. Leadership has said it held off on the increase for over a year out of concern for small-business customers, but ultimately concluded further delay wasn't sustainable given the pace of rising expenses.",
  ],
  bullets_ru: [
    "Цена вырастет с $5 до $8 в месяц — рост почти на 60% для новых платежей.",
    "Годовые подписчики сохранят текущую цену до момента продления плана.",
    "Компания откладывала повышение полтора года, опасаясь навредить малому бизнесу.",
    "Рост издержек на серверы стал основной причиной, которую назвала компания.",
  ],
  bullets_en: [
    "Point 1 covers pricing: the new rate is nearly 60% higher than before.",
    "Point 2 covers rollout timing: annual subscribers get a grace period.",
    "Point 3 covers scope: the change applies to subscribers everywhere.",
    "Point 4 covers the stated reason: rising server and bandwidth costs.",
  ],
  tags: ["technology"],
  lang_original: "en",
};

// Long enough that extraction clears pipeline.ts's MIN_EXTRACTED_TEXT_CHARS
// (300) guard.
const ARTICLE_HTML = "<html><head><title>Example</title></head><body><article><h1>Example</h1>" +
  "<p>Hello world, this is the first paragraph of example content, with enough extra words to " +
  "comfortably clear the minimum extraction length used by the pipeline's insufficient-text " +
  "guard in tests.</p>" +
  "<p>Here is a second paragraph with more detail to summarize, padded a little further so the " +
  "combined extracted text safely stays well above that threshold even after Readability trims " +
  "whitespace.</p></article></body></html>";

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
      delete(key: string): Promise<void> {
        kv.delete(key);
        return Promise.resolve();
      },
      list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
        return Promise.resolve({ keys: [], list_complete: true });
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
    AGENT_DAILY_PICKS: "10",
    SUMMARY_BODY_TARGET_CHARS: "1200",
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

// --- missing-secrets warning: the silent-404 debugging trap this task fixes ---

function withCapturedWarnings<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; warnings: unknown[][] }> {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  return Promise.resolve(fn()).then((result) => {
    console.warn = original;
    return { result, warnings };
  }, (err) => {
    console.warn = original;
    throw err;
  });
}

Deno.test("webhook: missing secrets log a warning listing exactly which secret names are absent (never values)", async () => {
  resetMissingTelegramSecretsWarningForTest();
  const stub = stubFetch();
  try {
    const env = makeEnv({
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_WEBHOOK_SECRET: "configured-secret",
      TELEGRAM_OWNER_CHAT_ID: undefined,
    });
    const { ctx } = makeExecutionContext();
    const { result: res, warnings } = await withCapturedWarnings(() =>
      webhookRequest(env, ctx, messageUpdate({ text: "/help" }))
    );
    assertEquals(res.status, 404);
    assertEquals(warnings.length, 1);
    const logged = JSON.parse(String(warnings[0][0]));
    assertEquals(logged.event, "telegram_webhook_inactive_missing_secrets");
    assertEquals(logged.missing, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID"]);
    assertEquals(JSON.stringify(logged).includes("configured-secret"), false);
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: the missing-secrets warning fires only once per isolate, not on every request", async () => {
  resetMissingTelegramSecretsWarningForTest();
  const stub = stubFetch();
  try {
    const env = makeEnv({
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_WEBHOOK_SECRET: undefined,
      TELEGRAM_OWNER_CHAT_ID: undefined,
    });
    const { ctx } = makeExecutionContext();
    const { warnings: firstWarnings } = await withCapturedWarnings(() =>
      webhookRequest(env, ctx, messageUpdate({ text: "/help" }))
    );
    assertEquals(firstWarnings.length, 1);

    const { warnings: secondWarnings } = await withCapturedWarnings(() =>
      webhookRequest(env, ctx, messageUpdate({ text: "/help" }))
    );
    assertEquals(secondWarnings.length, 0);
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

Deno.test("webhook: with JOBS configured, enqueues a 'process' message carrying the notify target instead of running inline", async () => {
  const stub = stubFetch();
  try {
    const jobs = new FakeQueue();
    const env = makeEnv({ JOBS: jobs });
    const { ctx, settle } = makeExecutionContext();

    const res = await webhookRequest(
      env,
      ctx,
      messageUpdate({ text: "https://example.com/tg-queued" }),
    );
    assertEquals(res.status, 200);
    await settle();

    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(stub.telegramCalls[0].body.text, "Сохраняю…");

    const db = env.DB as FakeD1;
    const row = db.rows[0];
    assertEquals(row.status, "pending"); // no consumer ran — only enqueued

    assertEquals(jobs.sent.length, 1);
    assertEquals(jobs.sent[0].kind, "process");
    assertEquals(jobs.sent[0].articleId, row.id);
    assertEquals(jobs.sent[0].notify, { chatId: OWNER_CHAT_ID, messageId: 1000 });
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

Deno.test("webhook: /scrape when the agent already ran today replies with a warning naming the prior run, and still runs the job (Task 36 Part B)", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    // Seeded against the real current time (readAgentRunHistory inside the
    // handler always reads "today" off the real clock, not an injectable
    // one) — an hour ago, at a fixed HH:00 so the expected warning text is
    // deterministic regardless of exactly when this test runs.
    const startedAt = new Date();
    startedAt.setUTCMinutes(0, 0, 0);
    startedAt.setUTCHours(startedAt.getUTCHours() - 1);
    const expectedTime = `${String(startedAt.getUTCHours()).padStart(2, "0")}:00`;
    await recordAgentRun(env.CACHE, {
      startedAt: startedAt.toISOString(),
      picks: 10,
      trigger: "scheduled",
    });
    const { ctx, settle } = makeExecutionContext();

    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/scrape" }));
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(
      stub.telegramCalls[0].body.text,
      `Сегодня агент уже отработал: 10 статей в ${expectedTime} UTC. Запускаю ещё раз.`,
    );

    await settle();
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: '/scrape force' suppresses the warning even when the agent already ran today", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    await recordAgentRun(env.CACHE, {
      startedAt: new Date().toISOString(),
      picks: 10,
      trigger: "scheduled",
    });
    const { ctx, settle } = makeExecutionContext();

    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/scrape force" }));
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 1);
    assertEquals(stub.telegramCalls[0].body.text, "Запустил агента");

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

// --- /publish (Task 29's drip publish, forced immediately) — Task 37's
// daily cap must be respected here exactly like the cron job, since both
// paths share publishNextArticle. Uses the real Date.now() for added_at
// (rather than an injected time — the webhook handler itself always calls
// publishNextArticle with the default, real-clock nowMs), same convention
// as the /scrape-already-ran tests above.

function insertReadyArticleForPublish(db: FakeD1, id: string) {
  db.rows.push({
    id,
    url: `https://example.com/${id}`,
    canonical_url: null,
    title: "Some title",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: new Date().toISOString(),
    added_via: "agent",
    lang_original: "en",
    full_text: "full text",
    summary_ru: "summary",
    summary_en: "summary",
    summary_json: JSON.stringify(VALID_SUMMARY),
    tags: "[]",
    status: "ready",
    archived: 0,
    error: null,
    fail_class: null,
    heal_attempts: 0,
    faithfulness_verdict: null,
    faithfulness_json: null,
    faithfulness_checked_at: null,
    embedded_at: null,
    telegram_published_at: null,
  });
}

Deno.test("webhook: /publish posts the oldest queued article and replies 'Опубликовано.'", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    insertReadyArticleForPublish(env.DB as unknown as FakeD1, "p1");
    const { ctx } = makeExecutionContext();

    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/publish" }));
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 2); // the post itself, then the owner reply
    assertEquals(stub.telegramCalls[1].body.text, "Опубликовано.");
  } finally {
    stub.restore();
  }
});

Deno.test("webhook: /publish at the daily cap replies with the cap-reached message and does not post, no force bypass", async () => {
  const stub = stubFetch();
  try {
    const env = makeEnv();
    insertReadyArticleForPublish(env.DB as unknown as FakeD1, "p1");
    const today = new Date().toISOString().slice(0, 10);
    await env.CACHE.put(`published:${today}`, "10");
    const { ctx } = makeExecutionContext();

    const res = await webhookRequest(env, ctx, messageUpdate({ text: "/publish" }));
    assertEquals(res.status, 200);
    assertEquals(stub.telegramCalls.length, 1); // only the reply, no post
    assertEquals(stub.telegramCalls[0].body.text, "Дневной лимит публикаций достигнут (10).");

    const row = (env.DB as unknown as FakeD1).rows.find((r) => r.id === "p1")!;
    assertEquals(row.telegram_published_at, null);
  } finally {
    stub.restore();
  }
});
