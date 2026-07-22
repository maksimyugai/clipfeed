import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { runHealingJob } from "./healing.ts";
import { insertPendingArticle, markArticleFailed } from "./db.ts";
import { processQueueMessage } from "./queue.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { FakeKv } from "./testing/fake_kv.ts";
import { FakeQueue } from "./testing/fake_queue.ts";

// Long enough that extraction clears pipeline.ts's MIN_EXTRACTED_TEXT_CHARS
// (300) guard.
const ARTICLE_HTML = "<html><head><title>Example</title></head><body><article><h1>Example</h1>" +
  "<p>Hello world, this is the first paragraph of example content, with enough extra words to " +
  "comfortably clear the minimum extraction length used by the pipeline's insufficient-text " +
  "guard in tests.</p>" +
  "<p>Here is a second paragraph with more detail to summarize, padded a little further so the " +
  "combined extracted text safely stays well above that threshold even after Readability trims " +
  "whitespace.</p></article></body></html>";

// Meets validateSummary's default STRICT bar (>=180 char tldrs, 4-7 bullets
// each 40-220 chars, 2-3 body paragraphs each 288-672 chars, 1-6 tags).
const VALID_SUMMARY = {
  title_ru: "Компания подняла цену подписки на 60% с 1 сентября",
  title_en: "Company Raises Subscription Price 60% Starting September 1",
  tldr_ru:
    "Компания повышает стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы и трафик. Изменение затронет около 2 миллионов подписчиков сервиса, а годовые подписчики получат отсрочку до продления плана.",
  tldr_en:
    "The company is raising its subscription price from $5 to $8 a month starting September 1, citing rising server and bandwidth costs. The change affects roughly 2 million subscribers, though annual-plan subscribers get a grace period until renewal.",
  body_ru: [
    "Компания объявила об изменении во вторник, уточнив, что новый тариф вступит в силу с 1 сентября. Рост стоимости составляет почти 60% по сравнению с текущей ценой. Затронутыми окажутся примерно 2 миллиона подписчиков сервиса, при этом клиенты, уже оформившие годовой план, не почувствуют изменения сразу.",
    "В компании ссылаются на растущие расходы на серверную инфраструктуру и сетевой трафик как на основную причину решения. Руководство отмечало, что откладывало повышение более года, опасаясь навредить клиентам из малого бизнеса, но в итоге пришло к выводу, что дальнейшая отсрочка невозможна из-за продолжающегося роста издержек.",
  ],
  body_en: [
    "The company announced the change on Tuesday, confirming the new rate takes effect September 1. The increase amounts to nearly 60% over the current price. Roughly 2 million subscribers are affected, though customers already on an annual plan won't see the new rate right away, since their existing terms carry over until renewal.",
    "Executives point to climbing server infrastructure and network costs as the primary driver behind the decision. Leadership has said it held off on the increase for over a year out of concern for small-business customers, but ultimately concluded further delay wasn't sustainable given the pace of rising expenses.",
  ],
  bullets_ru: [
    "Те, кто уже на годовом плане, сохранят старую цену до момента продления плана.",
    "Компания откладывала повышение цены более года из опасений навредить малому бизнесу.",
    "Решение было принято только после того, как расходы на инфраструктуру продолжили расти.",
    "Ни один из конкурентов пока не объявлял о похожем шаге.",
  ],
  bullets_en: [
    "Existing annual-plan subscribers keep their price until their plan comes up for renewal.",
    "The company delayed the increase for over a year out of concern for small businesses.",
    "Leadership only moved forward once infrastructure costs kept climbing regardless.",
    "No competitor has announced a comparable price change so far.",
  ],
  tags: ["business"],
  lang_original: "en",
};

function stubFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    let isAnthropicApi = false;
    try {
      const parsed = new URL(input.toString());
      isAnthropicApi = parsed.protocol === "https:" && parsed.hostname === "api.anthropic.com";
    } catch {
      isAnthropicApi = false;
    }

    if (isAnthropicApi) {
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
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1(),
    CACHE: new FakeKv(),
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

async function insertFailed(
  env: Env,
  id: string,
  opts: { url?: string; addedVia?: "agent" | "manual"; error: string; addedAt?: string },
): Promise<void> {
  await insertPendingArticle(env.DB, {
    id,
    url: opts.url ?? `https://example.com/${id}`,
    title: id,
    source: "example.com",
    tags: [],
    added_via: opts.addedVia ?? "manual",
    added_at: opts.addedAt ?? "2026-01-01T00:00:00.000Z",
  });
  await markArticleFailed(env.DB, id, opts.error);
}

function rowsOf(env: Env) {
  return (env.DB as unknown as FakeD1).rows;
}

// --- transient retried up to its cap ---

Deno.test("runHealingJob: a transient failure is retried (re-enqueued, heal_attempts incremented)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "t1", { error: "daily-limit" }); // transient

  await runHealingJob(env);

  assertEquals(jobs.sent, [{ kind: "process", articleId: "t1" }]);
  const row = rowsOf(env).find((r) => r.id === "t1")!;
  assertEquals(row.heal_attempts, 1);
  assertEquals(row.status, "pending"); // markArticlePending before re-enqueue
});

Deno.test("runHealingJob: a transient failure stops being retried once it hits its cap (2)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "t1", { error: "daily-limit" });

  await runHealingJob(env); // attempt 1 -> heal_attempts=1, re-enqueued as pending
  // Simulate the retry failing again.
  await markArticleFailed(env.DB, "t1", "daily-limit");
  await runHealingJob(env); // attempt 2 -> heal_attempts=2, re-enqueued
  await markArticleFailed(env.DB, "t1", "daily-limit");
  await runHealingJob(env); // heal_attempts already at cap (2) -> not retried again

  const row = rowsOf(env).find((r) => r.id === "t1")!;
  assertEquals(row.heal_attempts, 2);
  assertEquals(jobs.sent.length, 2);
});

Deno.test("runHealingJob: a genuinely 'unknown' failure gets only 1 attempt (lower cap than transient/content)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "u1", { error: "something completely unrecognized happened" });

  await runHealingJob(env); // attempt 1
  await markArticleFailed(env.DB, "u1", "something completely unrecognized happened");
  await runHealingJob(env); // cap (1) already reached -> no second attempt

  const row = rowsOf(env).find((r) => r.id === "u1")!;
  assertEquals(row.fail_class, "unknown");
  assertEquals(row.heal_attempts, 1);
  assertEquals(jobs.sent.length, 1);
});

// --- 'content' (summary validation failures) retried up to its own, higher cap (Task 26.5) ---

Deno.test("runHealingJob: a summary-validation failure is classified 'content', not 'unknown'", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "c1", {
    error: "internal: summarize: summary validation: bullets_ru[0] duplicates the tldr",
  });

  const row = rowsOf(env).find((r) => r.id === "c1")!;
  assertEquals(row.fail_class, "content");
});

Deno.test("runHealingJob: a 'content' failure gets 3 attempts (higher cap than 'unknown' — the retry is informed, not blind)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  const error = "internal: summarize: summary validation: bullets_ru[0] duplicates the tldr";
  await insertFailed(env, "c2", { error });

  await runHealingJob(env); // attempt 1 -> heal_attempts=1
  await markArticleFailed(env.DB, "c2", error);
  await runHealingJob(env); // attempt 2 -> heal_attempts=2
  await markArticleFailed(env.DB, "c2", error);
  await runHealingJob(env); // attempt 3 -> heal_attempts=3
  await markArticleFailed(env.DB, "c2", error);
  await runHealingJob(env); // cap (3) already reached -> no 4th attempt

  const row = rowsOf(env).find((r) => r.id === "c2")!;
  assertEquals(row.heal_attempts, 3);
  assertEquals(jobs.sent.length, 3);
});

Deno.test("runHealingJob: a 'content' failure that exhausts its cap stays 'failed', not archived (owner may want to resummarize manually)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs, DAILY_SUMMARY_LIMIT: 50 });
  const error = "internal: summarize: summary validation: bullets_ru[0] duplicates the tldr";
  await insertFailed(env, "c3", { addedVia: "agent", error });
  const row = rowsOf(env).find((r) => r.id === "c3")!;
  row.heal_attempts = 3; // already at cap

  await runHealingJob(env);

  const after = rowsOf(env).find((r) => r.id === "c3")!;
  assertEquals(jobs.sent, []); // not retried again
  assertEquals(after.status, "failed"); // stays failed, visible to the owner
  assertEquals(after.archived, 0); // 'content' never auto-archives, unlike 'permanent'
});

Deno.test("runHealingJob: a permanent failure is never retried (cap is 0)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "p1", {
    addedVia: "manual",
    error: "extraction: insufficient text (3 chars)",
  });

  await runHealingJob(env);

  assertEquals(jobs.sent, []);
  const row = rowsOf(env).find((r) => r.id === "p1")!;
  assertEquals(row.heal_attempts, 0);
  assertEquals(row.status, "failed");
});

// --- permanent + added_via classification/archiving ---

Deno.test("runHealingJob: classifies pre-existing (fail_class IS NULL) failed rows and auto-archives a permanent agent pick", async () => {
  const env = makeEnv();
  // Bypass markArticleFailed's immediate classification, simulating a row
  // that predates migration 0003 (fail_class was never set).
  await insertPendingArticle(env.DB, {
    id: "legacy-agent",
    url: "https://xcancel.com/x/status/1",
    title: "legacy-agent",
    source: "xcancel.com",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const row = rowsOf(env).find((r) => r.id === "legacy-agent")!;
  row.status = "failed";
  row.error = "extraction: insufficient text (0 chars)";
  row.fail_class = null;

  await runHealingJob(env);

  const updated = rowsOf(env).find((r) => r.id === "legacy-agent")!;
  assertEquals(updated.fail_class, "permanent");
  assertEquals(updated.archived, 1);
});

Deno.test("runHealingJob: classifies a pre-existing permanent failure on an owner-added row WITHOUT auto-archiving it", async () => {
  const env = makeEnv();
  await insertPendingArticle(env.DB, {
    id: "legacy-manual",
    url: "https://example.com/gone",
    title: "legacy-manual",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const row = rowsOf(env).find((r) => r.id === "legacy-manual")!;
  row.status = "failed";
  row.error = "internal: fetch: upstream responded 404";
  row.fail_class = null;

  await runHealingJob(env);

  const updated = rowsOf(env).find((r) => r.id === "legacy-manual")!;
  assertEquals(updated.fail_class, "permanent");
  assertEquals(updated.archived, 0); // owner's article — surfaced honestly, not buried
});

Deno.test("runHealingJob: classifying a pre-existing insufficient-text failure also teaches the thin-host learned list", async () => {
  const env = makeEnv();
  await insertPendingArticle(env.DB, {
    id: "legacy-thin",
    url: "https://mirror.example/post/1",
    title: "legacy-thin",
    source: "mirror.example",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const row = rowsOf(env).find((r) => r.id === "legacy-thin")!;
  row.status = "failed";
  row.error = "extraction: insufficient text (1 chars)";
  row.fail_class = null;
  // Already had one prior (fresh, already-classified) failure on this host.
  await env.CACHE.put("thinhost:mirror.example", "1");

  await runHealingJob(env);

  assertEquals(await env.CACHE.get("thinhost:mirror.example"), "2");
});

// --- budget / safety limits ---

Deno.test("runHealingJob: never touches an archived row, even if otherwise eligible", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "archived-1", { error: "daily-limit" });
  const row = rowsOf(env).find((r) => r.id === "archived-1")!;
  row.archived = 1;

  await runHealingJob(env);

  assertEquals(jobs.sent, []);
  assertEquals(row.heal_attempts, 0);
});

Deno.test("runHealingJob: re-enqueues through the normal queue path (JOBS), not a direct pipeline bypass", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "t1", { error: "daily-limit" });

  await runHealingJob(env);

  // The message went through env.JOBS exactly like any other enqueue —
  // the daily summary budget (cost-guard.ts) is enforced later, inside the
  // normal pipeline run this message eventually triggers, not bypassed here.
  assertEquals(jobs.sent.length, 1);
  assertEquals(jobs.sent[0], { kind: "process", articleId: "t1" });
});

Deno.test("runHealingJob: caps at 5 retries per tick even with more eligible articles", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  for (let i = 0; i < 7; i++) {
    await insertFailed(env, `many-${i}`, {
      error: "daily-limit",
      addedAt: `2026-01-01T00:0${i}:00.000Z`,
    });
  }

  await runHealingJob(env);

  assertEquals(jobs.sent.length, 5);
});

Deno.test("runHealingJob: with nothing to heal, does nothing (cheap no-op)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });

  await runHealingJob(env);

  assertEquals(jobs.sent, []);
});

// --- end-to-end: a daily-limit failure actually recovers once the sweep
// re-enqueues it and the next day's budget is available (see pipeline.ts's
// budget stage log for the incident that motivated documenting this path
// explicitly) ---

Deno.test("runHealingJob end-to-end: a 'daily-limit' failure heals to 'ready' once re-enqueued with budget available", async () => {
  const restoreFetch = stubFetch();
  try {
    const jobs = new FakeQueue();
    // DAILY_SUMMARY_LIMIT: 0 at insert time is what produced the original
    // failure; the healing run below uses a fresh env with real budget,
    // simulating "the next day" after the UTC counter reset.
    const env = makeEnv({ JOBS: jobs, DAILY_SUMMARY_LIMIT: 50 });
    await insertFailed(env, "d1", { error: "daily-limit" });

    const before = rowsOf(env).find((r) => r.id === "d1")!;
    assertEquals(before.fail_class, "transient");
    assertEquals(before.heal_attempts, 0);

    await runHealingJob(env);

    const afterSweep = rowsOf(env).find((r) => r.id === "d1")!;
    assertEquals(afterSweep.heal_attempts, 1);
    assertEquals(afterSweep.status, "pending");
    assertEquals(jobs.sent, [{ kind: "process", articleId: "d1" }]);

    // Simulate the queue consumer actually running the re-enqueued message.
    for (const message of jobs.sent) {
      await processQueueMessage(env, message);
    }

    const afterProcess = rowsOf(env).find((r) => r.id === "d1")!;
    assertEquals(afterProcess.status, "ready");
    assertEquals(afterProcess.error, null);
    assertEquals(afterProcess.fail_class, null);
    assertEquals(afterProcess.heal_attempts, 0);
  } finally {
    restoreFetch();
  }
});

Deno.test("runHealingJob end-to-end: a 'content' failure heals to 'ready', and the retry's prompt names the exact prior violation", async () => {
  const originalFetch = globalThis.fetch;
  let capturedFirstBody: { messages: { content: string }[] } | undefined;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    let isAnthropicApi = false;
    try {
      isAnthropicApi = new URL(url).hostname === "api.anthropic.com";
    } catch {
      isAnthropicApi = false;
    }
    if (isAnthropicApi) {
      capturedFirstBody ??= JSON.parse(String(init?.body));
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
    const jobs = new FakeQueue();
    const env = makeEnv({ JOBS: jobs });
    const priorError =
      "internal: summarize: summary validation: bullets_ru[0] duplicates the tldr instead of adding new detail";
    await insertFailed(env, "c-e2e", { addedVia: "agent", error: priorError });

    const before = rowsOf(env).find((r) => r.id === "c-e2e")!;
    assertEquals(before.fail_class, "content");

    await runHealingJob(env);
    for (const message of jobs.sent) {
      await processQueueMessage(env, message);
    }

    const after = rowsOf(env).find((r) => r.id === "c-e2e")!;
    assertEquals(after.status, "ready");
    const firstMessage = capturedFirstBody?.messages[0]?.content ?? "";
    assertEquals(firstMessage.includes("A previous attempt failed validation with:"), true);
    assertEquals(
      firstMessage.includes("bullets_ru[0] duplicates the tldr instead of adding new detail"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
