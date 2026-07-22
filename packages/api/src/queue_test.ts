import "./env.d.ts";
import { assertEquals } from "@std/assert";
import type { QueueMessage } from "@clipfeed/shared/types";
import {
  DEAD_LETTER_QUEUE_NAME,
  enqueueArticleJob,
  processDeadLetterMessage,
  processQueueMessage,
  stashPendingHtml,
} from "./queue.ts";
import {
  insertPendingArticle,
  markArticleFailed,
  markArticlePending,
  markArticleReady,
} from "./db.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { FakeMessage, FakeQueue, makeBatch } from "./testing/fake_queue.ts";
import worker from "./index.ts";

// Meets validateSummary's content bar (>=120 char tldrs, 3-6 bullets each
// 20-220 chars and not duplicating the tldr, 1-6 tags) — see summarize.ts.
const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Example Title",
  tldr_ru:
    "Кратко. Компания повышает стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы и трафик. Изменение затронет около 2 миллионов подписчиков сервиса, а годовые подписчики получат отсрочку до продления плана.",
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

class MapKv implements KVNamespace {
  store = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
  list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    return Promise.resolve({ keys: [], list_complete: true });
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1(),
    CACHE: new MapKv(),
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
    ...overrides,
  };
}

interface FetchCall {
  url: string;
}

function stubFetch(opts: { anthropicText?: string } = {}): {
  restore: () => void;
  calls: FetchCall[];
  telegramCalls: { method: string; body: Record<string, unknown> }[];
} {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const telegramCalls: { method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url });

    const tgMatch = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
    if (tgMatch) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      telegramCalls.push({ method: tgMatch[1], body });
      return Promise.resolve(Response.json({ ok: true, result: { message_id: 1 } }));
    }

    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === "https:" && parsedUrl.hostname === "api.anthropic.com") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: opts.anthropicText ?? JSON.stringify(VALID_SUMMARY) }],
          }),
          { status: 200 },
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
    calls,
    telegramCalls,
  };
}

async function insertPending(env: Env, id: string, url: string): Promise<void> {
  await insertPendingArticle(env.DB, {
    id,
    url,
    title: url,
    source: "example.com",
    tags: ["seed"],
    added_via: "manual",
    added_at: new Date().toISOString(),
  });
}

// --- processQueueMessage ---

Deno.test("processQueueMessage: 'process' kind fetches the URL when no html was stashed", async () => {
  const env = makeEnv();
  const stub = stubFetch();
  try {
    await insertPending(env, "a1", "https://example.com/no-html");
    await processQueueMessage(env, { kind: "process", articleId: "a1" });

    const db = env.DB as unknown as FakeD1;
    const row = db.rows.find((r) => r.id === "a1")!;
    assertEquals(row.status, "ready");
    assertEquals(stub.calls.some((c) => c.url === "https://example.com/no-html"), true);
  } finally {
    stub.restore();
  }
});

Deno.test("processQueueMessage: 'process' kind uses stashed html and never fetches the URL", async () => {
  const env = makeEnv();
  const stub = stubFetch();
  try {
    await insertPending(env, "a2", "https://example.com/has-html");
    await stashPendingHtml(env.CACHE, "a2", ARTICLE_HTML);
    await processQueueMessage(env, { kind: "process", articleId: "a2" });

    const db = env.DB as unknown as FakeD1;
    const row = db.rows.find((r) => r.id === "a2")!;
    assertEquals(row.status, "ready");
    assertEquals(stub.calls.some((c) => c.url === "https://example.com/has-html"), false);
    // Consumed — a retry wouldn't find stale html for a different run.
    assertEquals(await env.CACHE.get("pending-html:a2"), null);
  } finally {
    stub.restore();
  }
});

Deno.test("processQueueMessage: 'resummarize' kind with stored full_text skips fetch/extract", async () => {
  const env = makeEnv();
  await insertPending(env, "a3", "https://example.com/resum");
  await markArticleReady(env.DB, "a3", {
    full_text: "Some already-extracted article text.",
    title: "Existing Title",
    author: null,
    lang_original: "en",
    summary_ru: "old ru",
    summary_en: "old en",
    summary_json: VALID_SUMMARY,
    tags: ["seed"],
  });

  const stub = stubFetch();
  try {
    await processQueueMessage(env, { kind: "resummarize", articleId: "a3" });
    const db = env.DB as unknown as FakeD1;
    const row = db.rows.find((r) => r.id === "a3")!;
    assertEquals(row.status, "ready");
    assertEquals(stub.calls.some((c) => c.url === "https://example.com/resum"), false);
  } finally {
    stub.restore();
  }
});

Deno.test("processQueueMessage: 'resummarize' kind with no stored full_text falls back to the full pipeline", async () => {
  const env = makeEnv();
  await insertPending(env, "a4", "https://example.com/resum-fallback");

  const stub = stubFetch();
  try {
    await processQueueMessage(env, { kind: "resummarize", articleId: "a4" });
    const db = env.DB as unknown as FakeD1;
    const row = db.rows.find((r) => r.id === "a4")!;
    assertEquals(row.status, "ready");
    assertEquals(stub.calls.some((c) => c.url === "https://example.com/resum-fallback"), true);
  } finally {
    stub.restore();
  }
});

Deno.test("processQueueMessage: unknown article id is a no-op, never throws", async () => {
  const env = makeEnv();
  await processQueueMessage(env, { kind: "process", articleId: "does-not-exist" });
});

// --- priorViolations: a 'content'-classified retry is informed, others aren't (Task 26.5) ---

Deno.test("processQueueMessage: 'process' kind retrying a previous 'content' failure carries priorViolations into the summarize call", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  let capturedAnthropicBody: { messages: { content: string }[] } | undefined;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    if (new URL(url).hostname === "api.anthropic.com") {
      capturedAnthropicBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    );
  }) as typeof fetch;

  try {
    await insertPending(env, "a-content-retry", "https://example.com/content-retry");
    // Simulate a previous run that failed content validation, then the
    // healing sweep (or a manual retry) re-queuing it — markArticlePending
    // deliberately leaves error/fail_class in place (see db.ts) so this is
    // exactly what processQueueMessage would see on the real retry path.
    await markArticleFailed(
      env.DB,
      "a-content-retry",
      "internal: summarize: summary validation: bullets_ru[0] duplicates the tldr instead of adding new detail",
    );
    await markArticlePending(env.DB, "a-content-retry");

    await processQueueMessage(env, { kind: "process", articleId: "a-content-retry" });

    const db = env.DB as unknown as FakeD1;
    const row = db.rows.find((r) => r.id === "a-content-retry")!;
    assertEquals(row.status, "ready");
    const firstMessage = capturedAnthropicBody?.messages[0]?.content ?? "";
    assertEquals(firstMessage.includes("A previous attempt failed validation with:"), true);
    assertEquals(
      firstMessage.includes("bullets_ru[0] duplicates the tldr instead of adding new detail"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("processQueueMessage: 'process' kind retrying a 'transient' failure does NOT pass priorViolations", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  let capturedAnthropicBody: { messages: { content: string }[] } | undefined;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    if (new URL(url).hostname === "api.anthropic.com") {
      capturedAnthropicBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    );
  }) as typeof fetch;

  try {
    await insertPending(env, "a-transient-retry", "https://example.com/transient-retry");
    await markArticleFailed(
      env.DB,
      "a-transient-retry",
      "internal: summarize: anthropic api error (503): overloaded",
    );
    await markArticlePending(env.DB, "a-transient-retry");

    await processQueueMessage(env, { kind: "process", articleId: "a-transient-retry" });

    const firstMessage = capturedAnthropicBody?.messages[0]?.content ?? "";
    assertEquals(firstMessage.includes("A previous attempt failed validation"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("processQueueMessage: notify present -> sends a Telegram edit reflecting the ready result", async () => {
  const env = makeEnv({
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_OWNER_CHAT_ID: "999",
  });
  const stub = stubFetch();
  try {
    await insertPending(env, "a5", "https://example.com/notify-me");
    await processQueueMessage(env, {
      kind: "process",
      articleId: "a5",
      notify: { chatId: "999", messageId: 42 },
    });

    const editCall = stub.telegramCalls.find((c) => c.method === "editMessageText");
    assertEquals(editCall !== undefined, true);
    assertEquals(editCall!.body.chat_id, "999");
    assertEquals(editCall!.body.message_id, 42);
    assertEquals((editCall!.body.text as string).includes("Кратко."), true);
  } finally {
    stub.restore();
  }
});

Deno.test("processQueueMessage: notify present but Telegram unconfigured -> no throw, no edit", async () => {
  const env = makeEnv();
  const stub = stubFetch();
  try {
    await insertPending(env, "a6", "https://example.com/no-telegram-config");
    await processQueueMessage(env, {
      kind: "process",
      articleId: "a6",
      notify: { chatId: "999", messageId: 1 },
    });
    assertEquals(stub.telegramCalls.length, 0);
  } finally {
    stub.restore();
  }
});

// --- processDeadLetterMessage ---

function spyConsole(): { logs: string[]; warns: string[]; restore: () => void } {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs: string[] = [];
  const warns: string[] = [];
  console.log = (msg: unknown) => logs.push(String(msg));
  console.warn = (msg: unknown) => warns.push(String(msg));
  return {
    logs,
    warns,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
    },
  };
}

Deno.test("processDeadLetterMessage: marks a non-terminal article failed with the dead-letter reason", async () => {
  const env = makeEnv();
  const spy = spyConsole();
  try {
    await insertPending(env, "dlq-1", "https://example.com/dlq-1");
    await processDeadLetterMessage(env, { kind: "process", articleId: "dlq-1" });

    const db = env.DB as unknown as FakeD1;
    const row = db.rows.find((r) => r.id === "dlq-1")!;
    assertEquals(row.status, "failed");
    assertEquals(row.error, "queue: processing failed after retries");
    assertEquals(
      spy.warns.some((w) => w.includes("queue_dead_letter") && w.includes("dlq-1")),
      true,
    );
  } finally {
    spy.restore();
  }
});

Deno.test("processDeadLetterMessage: idempotent — does not clobber an already-'ready' article", async () => {
  const env = makeEnv();
  await insertPending(env, "dlq-2", "https://example.com/dlq-2");
  await markArticleReady(env.DB, "dlq-2", {
    full_text: "Already summarized.",
    title: "Existing",
    author: null,
    lang_original: "en",
    summary_ru: "ru",
    summary_en: "en",
    summary_json: VALID_SUMMARY,
    tags: [],
  });

  await processDeadLetterMessage(env, { kind: "process", articleId: "dlq-2" });

  const db = env.DB as unknown as FakeD1;
  const row = db.rows.find((r) => r.id === "dlq-2")!;
  assertEquals(row.status, "ready");
});

Deno.test("processDeadLetterMessage: idempotent — does not overwrite an already-'failed' article's error", async () => {
  const env = makeEnv();
  await insertPending(env, "dlq-3", "https://example.com/dlq-3");
  await markArticleFailed(env.DB, "dlq-3", "extraction: insufficient text (5 chars)");

  await processDeadLetterMessage(env, { kind: "process", articleId: "dlq-3" });

  const db = env.DB as unknown as FakeD1;
  const row = db.rows.find((r) => r.id === "dlq-3")!;
  assertEquals(row.status, "failed");
  assertEquals(row.error, "extraction: insufficient text (5 chars)");
});

Deno.test("processDeadLetterMessage: unknown article id is a no-op, never throws", async () => {
  const env = makeEnv();
  await processDeadLetterMessage(env, { kind: "process", articleId: "does-not-exist" });
});

// --- enqueueArticleJob ---

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

Deno.test("enqueueArticleJob: JOBS configured -> sends the exact message, never touches ctx.waitUntil", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  const { ctx, settle } = makeExecutionContext();
  const message: QueueMessage = { kind: "process", articleId: "queued-1" };

  await enqueueArticleJob(env, ctx, message);
  await settle();

  assertEquals(jobs.sent, [message]);
  const db = env.DB as unknown as FakeD1;
  assertEquals(db.rows.length, 0); // nothing ran locally — genuinely enqueued
});

Deno.test("enqueueArticleJob: JOBS configured -> logs queue_enqueued with articleId and kind", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  const { ctx } = makeExecutionContext();
  const spy = spyConsole();
  try {
    await enqueueArticleJob(env, ctx, { kind: "process", articleId: "queued-log-1" });
    assertEquals(
      spy.logs.some((l) => l.includes("queue_enqueued") && l.includes("queued-log-1")),
      true,
    );
  } finally {
    spy.restore();
  }
});

Deno.test("enqueueArticleJob: JOBS undefined + ctx provided -> falls back via ctx.waitUntil", async () => {
  const env = makeEnv();
  const stub = stubFetch();
  try {
    await insertPending(env, "fallback-ctx", "https://example.com/fallback-ctx");
    const { ctx, settle } = makeExecutionContext();

    await enqueueArticleJob(env, ctx, { kind: "process", articleId: "fallback-ctx" });
    // Not resolved yet — proves it went through waitUntil(), not an inline await.
    const db = env.DB as unknown as FakeD1;
    assertEquals(db.rows.find((r) => r.id === "fallback-ctx")!.status, "pending");

    await settle();
    assertEquals(db.rows.find((r) => r.id === "fallback-ctx")!.status, "ready");
  } finally {
    stub.restore();
  }
});

Deno.test("enqueueArticleJob: JOBS undefined + ctx omitted -> awaits the fallback inline", async () => {
  const env = makeEnv();
  const stub = stubFetch();
  try {
    await insertPending(env, "fallback-inline", "https://example.com/fallback-inline");
    await enqueueArticleJob(env, undefined, { kind: "process", articleId: "fallback-inline" });

    // Already resolved by the time enqueueArticleJob returns — no waitUntil involved.
    const db = env.DB as unknown as FakeD1;
    assertEquals(db.rows.find((r) => r.id === "fallback-inline")!.status, "ready");
  } finally {
    stub.restore();
  }
});

// --- index.ts's `queue` export (the real consumer entrypoint) ---

Deno.test("queue(): acks each message after processQueueMessage completes, even a 'failed' terminal row", async () => {
  const env = makeEnv({ DAILY_SUMMARY_LIMIT: 0 });
  const stub = stubFetch();
  try {
    await insertPending(env, "consumer-1", "https://example.com/consumer-1");
    const message = new FakeMessage({ kind: "process", articleId: "consumer-1" });
    const batch = makeBatch([message]);

    await worker.queue(batch, env, makeExecutionContext().ctx);

    assertEquals(message.acked, true);
    assertEquals(message.retried, false);
    const db = env.DB as unknown as FakeD1;
    const row = db.rows.find((r) => r.id === "consumer-1")!;
    assertEquals(row.status, "failed");
    assertEquals(row.error, "daily-limit");
  } finally {
    stub.restore();
  }
});

Deno.test("queue(): retries only when processQueueMessage itself throws unexpectedly", async () => {
  const throwingDb: D1Database = {
    prepare(): D1PreparedStatement {
      throw new Error("D1 is unavailable");
    },
  };
  const env = makeEnv({ DB: throwingDb });
  const message = new FakeMessage({ kind: "process", articleId: "whatever" });
  const batch = makeBatch([message]);

  await worker.queue(batch, env, makeExecutionContext().ctx);

  assertEquals(message.acked, false);
  assertEquals(message.retried, true);
});

Deno.test("queue(): logs queue_received then queue_done bracketing a successful message", async () => {
  const env = makeEnv({ DAILY_SUMMARY_LIMIT: 0 });
  const stub = stubFetch();
  const spy = spyConsole();
  try {
    await insertPending(env, "log-1", "https://example.com/log-1");
    const message = new FakeMessage({ kind: "process", articleId: "log-1" });
    const batch = makeBatch([message]);

    await worker.queue(batch, env, makeExecutionContext().ctx);

    const receivedIdx = spy.logs.findIndex((l) => l.includes("queue_received"));
    const doneIdx = spy.logs.findIndex((l) => l.includes("queue_done"));
    assertEquals(receivedIdx >= 0 && doneIdx > receivedIdx, true);
    assertEquals(spy.logs[receivedIdx].includes("log-1"), true);
    assertEquals(spy.logs[doneIdx].includes("log-1"), true);
  } finally {
    spy.restore();
    stub.restore();
  }
});

Deno.test("queue(): a DLQ batch routes to processDeadLetterMessage and always acks, never retries", async () => {
  const env = makeEnv();
  await insertPending(env, "dlq-consumer-1", "https://example.com/dlq-consumer-1");
  const message = new FakeMessage({ kind: "process", articleId: "dlq-consumer-1" });
  const batch = makeBatch([message], DEAD_LETTER_QUEUE_NAME);

  await worker.queue(batch, env, makeExecutionContext().ctx);

  assertEquals(message.acked, true);
  assertEquals(message.retried, false);
  const db = env.DB as unknown as FakeD1;
  const row = db.rows.find((r) => r.id === "dlq-consumer-1")!;
  assertEquals(row.status, "failed");
  assertEquals(row.error, "queue: processing failed after retries");
});

Deno.test("queue(): a DLQ batch still acks even if processing itself throws unexpectedly", async () => {
  const throwingDb: D1Database = {
    prepare(): D1PreparedStatement {
      throw new Error("D1 is unavailable");
    },
  };
  const env = makeEnv({ DB: throwingDb });
  const message = new FakeMessage({ kind: "process", articleId: "dlq-consumer-2" });
  const batch = makeBatch([message], DEAD_LETTER_QUEUE_NAME);

  await worker.queue(batch, env, makeExecutionContext().ctx);

  assertEquals(message.acked, true);
  assertEquals(message.retried, false);
});
