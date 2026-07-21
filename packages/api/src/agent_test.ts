import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { runAgentJob } from "./agent.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { FakeQueue } from "./testing/fake_queue.ts";
import type { SourceConfig } from "./agent-types.ts";

// Meets validateSummary's content bar (>=120 char tldrs, 3-6 bullets each
// 20-220 chars and not duplicating the tldr, 1-6 tags) — see summarize.ts.
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
    "Price rises from $5 to $8 per month, a nearly 60% increase for new payments.",
    "Existing annual-plan subscribers keep their price until their plan renews.",
    "The company delayed the increase for over a year and a half before acting.",
    "No competitor has announced a comparable price change so far this year.",
  ],
  tags: ["tag"],
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

// Distinct, unrelated per-index topic words (not a shared stem/suffix like
// "story 0"/"story 1") so items from the same or different sources never
// look like the same story to ranking.ts's dedupStories() — that logic is
// exercised deliberately in ranking_test.ts, but here it would otherwise
// collapse this fixture's filler items down to fewer than intended.
const FIXTURE_TOPICS = ["quokka", "narwhal", "obelisk", "marimba", "tundra", "brioche"];

function rssFixture(sourceIdLabel: string, count: number): string {
  const items = Array.from(
    { length: count },
    (_, i) =>
      `<item><title>${sourceIdLabel}-${
        FIXTURE_TOPICS[i % FIXTURE_TOPICS.length]
      }</title><link>https://articles.example.com/${sourceIdLabel}-${i}</link><pubDate>${
        new Date(Date.now() - i * 60_000).toUTCString()
      }</pubDate></item>`,
  ).join("");
  return `<rss><channel>${items}</channel></rss>`;
}

class FakeKV {
  store = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

function anthropicText(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

const FIVE_RSS_SOURCES: SourceConfig[] = ["s1", "s2", "s3", "s4", "s5"].map((id) => ({
  id,
  type: "rss",
  url: `https://feeds.example.com/${id}`,
}));

function stubFetch(opts: { anthropicStatus?: number } = {}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();

    const feedMatch = url.match(/feeds\.example\.com\/(\w+)/);
    if (feedMatch) {
      return Promise.resolve(new Response(rssFixture(feedMatch[1], 2), { status: 200 }));
    }

    if (url.includes("api.anthropic.com")) {
      if (opts.anthropicStatus && opts.anthropicStatus !== 200) {
        return Promise.resolve(new Response("server error", { status: opts.anthropicStatus }));
      }
      const body = JSON.parse(String(init?.body)) as { system: string };
      if (body.system.includes("rank")) {
        // Return unparseable output so ranking falls back deterministically
        // to fallbackPicks() (newest-first, one per distinct source) rather
        // than depending on this test knowing generated candidate ids.
        return Promise.resolve(anthropicText("not valid json"));
      }
      return Promise.resolve(anthropicText(JSON.stringify(VALID_SUMMARY)));
    }

    if (url.includes("articles.example.com")) {
      return Promise.resolve(
        new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
      );
    }

    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1() as unknown as D1Database,
    CACHE: new FakeKV() as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: {
      run(): Promise<unknown> {
        throw new Error("AI.run should not be called for this branch");
      },
    },
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
    ANTHROPIC_API_KEY: "sk-direct",
    ...overrides,
  };
}

Deno.test("runAgentJob: end-to-end — 10 picks across 5 distinct sources inserted (added_via 'agent', tags seeded) and run through the pipeline", async () => {
  const restore = stubFetch();
  try {
    const env = makeEnv();
    await runAgentJob(env, FIVE_RSS_SOURCES);

    const db = env.DB as unknown as FakeD1;
    const agentRows = db.rows.filter((r) => r.added_via === "agent");
    // FIVE_RSS_SOURCES x 2 items each = 10 candidates, exactly AGENT_DAILY_PICKS's
    // default — the whole pool gets picked (fallback: one per source, then
    // backfill covers the rest).
    assertEquals(agentRows.length, 10);

    const sourceIds = new Set(agentRows.map((r) => (r.tags as string).replace(/[[\]"]/g, "")));
    assertEquals(sourceIds.size, 5);

    for (const row of agentRows) {
      assertEquals(row.status, "ready");
      assertEquals(row.summary_ru !== null, true);
    }
  } finally {
    restore();
  }
});

Deno.test("runAgentJob: no sources yielding candidates -> zero picks, no crash", async () => {
  const restore = stubFetch();
  try {
    const env = makeEnv();
    await runAgentJob(env, []);
    const db = env.DB as unknown as FakeD1;
    assertEquals(db.rows.length, 0);
  } finally {
    restore();
  }
});

Deno.test("runAgentJob: daily budget exhausted mid-run -> remaining picks land 'failed: daily-limit', still all 10 inserted", async () => {
  const restore = stubFetch();
  try {
    const env = makeEnv({ DAILY_SUMMARY_LIMIT: 2 });
    await runAgentJob(env, FIVE_RSS_SOURCES);

    const db = env.DB as unknown as FakeD1;
    const agentRows = db.rows.filter((r) => r.added_via === "agent");
    assertEquals(agentRows.length, 10);

    const ready = agentRows.filter((r) => r.status === "ready");
    const failed = agentRows.filter((r) => r.status === "failed" && r.error === "daily-limit");
    assertEquals(ready.length, 2);
    assertEquals(failed.length, 8);
  } finally {
    restore();
  }
});

Deno.test("runAgentJob: with JOBS configured, enqueues one 'process' message per pick instead of running the pipeline inline", async () => {
  const restore = stubFetch();
  try {
    const jobs = new FakeQueue();
    const env = makeEnv({ JOBS: jobs });
    await runAgentJob(env, FIVE_RSS_SOURCES);

    const db = env.DB as unknown as FakeD1;
    const agentRows = db.rows.filter((r) => r.added_via === "agent");
    assertEquals(agentRows.length, 10);
    // Still 'pending' — enqueued, not run inline.
    assertEquals(agentRows.every((r) => r.status === "pending"), true);

    assertEquals(jobs.sent.length, 10);
    assertEquals(jobs.sent.every((m) => m.kind === "process"), true);
    const enqueuedIds = new Set(jobs.sent.map((m) => m.articleId));
    assertEquals(enqueuedIds, new Set(agentRows.map((r) => r.id as string)));
  } finally {
    restore();
  }
});

Deno.test("runAgentJob: re-running within the same day does not duplicate articles", async () => {
  // One item per source (not two, like the other tests) — re-fetching the
  // same feeds yields the exact same candidate URLs both times, so a
  // second run's pool should end up empty rather than picking "the next
  // newest" item, which is what actually exercises the dedupe-against-DB
  // path in buildCandidatePool.
  const restoreOriginal = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const feedMatch = url.match(/feeds\.example\.com\/(\w+)/);
    if (feedMatch) {
      return Promise.resolve(new Response(rssFixture(feedMatch[1], 1), { status: 200 }));
    }
    if (url.includes("api.anthropic.com")) {
      const body = JSON.parse(String(init?.body)) as { system: string };
      if (body.system.includes("rank")) {
        return Promise.resolve(anthropicText("not valid json"));
      }
      return Promise.resolve(anthropicText(JSON.stringify(VALID_SUMMARY)));
    }
    if (url.includes("articles.example.com")) {
      return Promise.resolve(
        new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const env = makeEnv();
    await runAgentJob(env, FIVE_RSS_SOURCES);
    await runAgentJob(env, FIVE_RSS_SOURCES);

    const db = env.DB as unknown as FakeD1;
    const agentRows = db.rows.filter((r) => r.added_via === "agent");
    // Still exactly 5 — the second run's pool excludes every URL the first
    // run already saved (buildCandidatePool's D1 existence check).
    assertEquals(agentRows.length, 5);

    const urls = agentRows.map((r) => r.url);
    assertEquals(new Set(urls).size, urls.length);
  } finally {
    globalThis.fetch = restoreOriginal;
  }
});

Deno.test("runAgentJob: pool-stage title duplicates are counted and logged in the 'pool' stage stats (Task 24 Part B)", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  // A single source whose feed carries two items with the exact same title
  // (different URLs/links) — the pool-internal title-exact dedup layer
  // (agent-pool.ts) should drop the second one before ranking ever runs.
  const duplicateTitleFeed = `<rss><channel>` +
    `<item><title>Same Headline Twice</title><link>https://articles.example.com/dup-a</link><pubDate>${
      new Date().toUTCString()
    }</pubDate></item>` +
    `<item><title>Same Headline Twice</title><link>https://articles.example.com/dup-b</link><pubDate>${
      new Date(Date.now() - 60_000).toUTCString()
    }</pubDate></item>` +
    `</channel></rss>`;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const hostname = new URL(url).hostname;
    if (hostname === "feeds.example.com") {
      return Promise.resolve(new Response(duplicateTitleFeed, { status: 200 }));
    }
    if (hostname === "api.anthropic.com") {
      const body = JSON.parse(String(init?.body)) as { system: string };
      if (body.system.includes("rank")) return Promise.resolve(anthropicText("not valid json"));
      return Promise.resolve(anthropicText(JSON.stringify(VALID_SUMMARY)));
    }
    if (hostname === "articles.example.com") {
      return Promise.resolve(
        new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const env = makeEnv();
    await runAgentJob(env, [{
      id: "dup-source",
      type: "rss",
      url: "https://feeds.example.com/dup",
    }]);

    const poolLog = logs
      .map((args) => JSON.parse(String(args[0])))
      .find((entry) => entry.event === "agent_stage" && entry.stage === "pool");
    assertEquals(poolLog?.pool_size, 1);
    assertEquals(poolLog?.dedup_dropped, 1);
    assertEquals(poolLog?.dedup_dropped_by_reason, { url: 0, title: 1, jaccard: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
