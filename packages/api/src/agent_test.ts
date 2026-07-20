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
    "Компания повышает стоимость подписки с $5 до $8 в месяц начиная с 1 сентября, ссылаясь на рост расходов на серверы. Изменение затронет около 2 миллионов подписчиков сервиса.",
  tldr_en:
    "The company is raising its subscription price from $5 to $8 a month starting September 1, citing rising server costs. The change affects roughly 2 million subscribers.",
  bullets_ru: [
    "Цена вырастет с $5 до $8 в месяц — рост на 60%.",
    "Годовые подписчики сохранят текущую цену до продления.",
    "Компания откладывала повышение полтора года.",
  ],
  bullets_en: [
    "Price rises from $5 to $8 per month, a 60% increase.",
    "Existing annual-plan subscribers keep their price until renewal.",
    "The company delayed the increase for a year and a half.",
  ],
  tags: ["tag"],
  lang_original: "en",
};

const ARTICLE_HTML = "<html><head><title>Example</title></head><body><article><h1>Example</h1>" +
  "<p>Hello world, this is the first paragraph of example content.</p>" +
  "<p>Here is a second paragraph with more detail to summarize.</p></article></body></html>";

function rssFixture(sourceIdLabel: string, count: number): string {
  const items = Array.from(
    { length: count },
    (_, i) =>
      `<item><title>${sourceIdLabel} story ${i}</title><link>https://articles.example.com/${sourceIdLabel}-${i}</link><pubDate>${
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
    DIGEST_HOUR_UTC: "6",
    ANTHROPIC_API_KEY: "sk-direct",
    ...overrides,
  };
}

Deno.test("runAgentJob: end-to-end — 5 distinct-source picks inserted (added_via 'agent', tags seeded) and run through the pipeline", async () => {
  const restore = stubFetch();
  try {
    const env = makeEnv();
    await runAgentJob(env, FIVE_RSS_SOURCES);

    const db = env.DB as unknown as FakeD1;
    const agentRows = db.rows.filter((r) => r.added_via === "agent");
    assertEquals(agentRows.length, 5);

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

Deno.test("runAgentJob: daily budget exhausted mid-run -> remaining picks land 'failed: daily-limit', still all 5 inserted", async () => {
  const restore = stubFetch();
  try {
    const env = makeEnv({ DAILY_SUMMARY_LIMIT: 2 });
    await runAgentJob(env, FIVE_RSS_SOURCES);

    const db = env.DB as unknown as FakeD1;
    const agentRows = db.rows.filter((r) => r.added_via === "agent");
    assertEquals(agentRows.length, 5);

    const ready = agentRows.filter((r) => r.status === "ready");
    const failed = agentRows.filter((r) => r.status === "failed" && r.error === "daily-limit");
    assertEquals(ready.length, 2);
    assertEquals(failed.length, 3);
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
    assertEquals(agentRows.length, 5);
    // Still 'pending' — enqueued, not run inline.
    assertEquals(agentRows.every((r) => r.status === "pending"), true);

    assertEquals(jobs.sent.length, 5);
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
