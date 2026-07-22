import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { parseSearchRatePerMin, searchArticles, tryConsumeSearchRateLimit } from "./search.ts";
import { insertPendingArticle, markArticleReady } from "./db.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { FakeKv } from "./testing/fake_kv.ts";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";

const MINIMAL_SUMMARY_JSON = {
  title_ru: "t",
  title_en: "t",
  tldr_ru: "t",
  tldr_en: "t",
  body_ru: [],
  body_en: [],
  bullets_ru: [],
  bullets_en: [],
  tags: [],
  lang_original: "en",
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1() as unknown as D1Database,
    CACHE: new FakeKv() as unknown as KVNamespace,
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
    ...overrides,
  };
}

// --- parseSearchRatePerMin: defensive [vars] parsing ---

Deno.test("parseSearchRatePerMin: undefined/empty falls back to the default (30)", () => {
  assertEquals(parseSearchRatePerMin(undefined), 30);
  assertEquals(parseSearchRatePerMin(""), 30);
  assertEquals(parseSearchRatePerMin("  "), 30);
});

Deno.test("parseSearchRatePerMin: a valid override is used, rounded", () => {
  assertEquals(parseSearchRatePerMin("10"), 10);
  assertEquals(parseSearchRatePerMin("10.6"), 11);
});

Deno.test("parseSearchRatePerMin: out-of-range/non-numeric falls back to the default", () => {
  assertEquals(parseSearchRatePerMin("0"), 30);
  assertEquals(parseSearchRatePerMin("not a number"), 30);
});

// --- tryConsumeSearchRateLimit ---

Deno.test("tryConsumeSearchRateLimit: allows requests up to the per-minute limit, then blocks", async () => {
  const cache = new FakeKv();
  const now = new Date("2026-01-01T00:00:00.000Z");
  assertEquals(await tryConsumeSearchRateLimit(cache, 2, now), true);
  assertEquals(await tryConsumeSearchRateLimit(cache, 2, now), true);
  assertEquals(await tryConsumeSearchRateLimit(cache, 2, now), false);
});

Deno.test("tryConsumeSearchRateLimit: a different minute bucket gets a fresh budget", async () => {
  const cache = new FakeKv();
  const minuteOne = new Date("2026-01-01T00:00:30.000Z");
  const minuteTwo = new Date("2026-01-01T00:01:00.000Z");
  assertEquals(await tryConsumeSearchRateLimit(cache, 1, minuteOne), true);
  assertEquals(await tryConsumeSearchRateLimit(cache, 1, minuteOne), false);
  assertEquals(await tryConsumeSearchRateLimit(cache, 1, minuteTwo), true);
});

// --- searchArticles ---

async function seedReadyArticle(
  db: D1Database,
  overrides: { id: string; title: string; added_at: string },
): Promise<void> {
  await insertPendingArticle(db, {
    id: overrides.id,
    url: `https://example.com/${overrides.id}`,
    title: overrides.title,
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: overrides.added_at,
  });
  await markArticleReady(db, overrides.id, {
    full_text: "full text",
    title: overrides.title,
    author: null,
    lang_original: "en",
    summary_ru: overrides.title,
    summary_en: overrides.title,
    summary_json: { ...MINIMAL_SUMMARY_JSON, title_en: overrides.title },
    tags: [],
  });
}

Deno.test("searchArticles: falls back to keyword (LIKE) search when VECTORS is undefined — score 0", async () => {
  const env = makeEnv({ VECTORS: undefined });
  await seedReadyArticle(env.DB, {
    id: "kw1",
    title: "Widgets Are Great",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await seedReadyArticle(env.DB, {
    id: "kw2",
    title: "Gadgets Are Fine",
    added_at: "2026-01-02T00:00:00.000Z",
  });

  const hits = await searchArticles(env, "Widgets", 20);
  assertEquals(hits.map((h) => h.article.id), ["kw1"]);
  assertEquals(hits[0].score, 0);
});

function makeStubAi(vector: number[]): Ai {
  return {
    run: () => Promise.resolve({ shape: [1, vector.length], data: [vector] }),
  };
}

function makeStubVectors(matches: VectorizeMatch[]): VectorizeIndex {
  return {
    upsert: () => Promise.reject(new Error("not used")),
    deleteByIds: () => Promise.reject(new Error("not used")),
    query: () => Promise.resolve({ matches, count: matches.length }),
  };
}

Deno.test("searchArticles: semantic path hydrates D1 rows in Vectorize's score order", async () => {
  const env = makeEnv({
    AI: makeStubAi(new Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    VECTORS: makeStubVectors([
      { id: "sem-b", score: 0.95 },
      { id: "sem-a", score: 0.80 },
    ]),
  });
  await seedReadyArticle(env.DB, {
    id: "sem-a",
    title: "Article A",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  await seedReadyArticle(env.DB, {
    id: "sem-b",
    title: "Article B",
    added_at: "2026-01-02T00:00:00.000Z",
  });

  const hits = await searchArticles(env, "some query", 20);
  assertEquals(hits.map((h) => h.article.id), ["sem-b", "sem-a"]);
  assertEquals(hits.map((h) => h.score), [0.95, 0.80]);
});

Deno.test("searchArticles: a Vectorize match with no D1 row is skipped, not an error", async () => {
  const env = makeEnv({
    AI: makeStubAi(new Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    VECTORS: makeStubVectors([
      { id: "deleted-article", score: 0.99 },
      { id: "sem-a", score: 0.80 },
    ]),
  });
  await seedReadyArticle(env.DB, {
    id: "sem-a",
    title: "Article A",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const hits = await searchArticles(env, "some query", 20);
  assertEquals(hits.map((h) => h.article.id), ["sem-a"]);
});

Deno.test("searchArticles: an embed failure falls back to keyword search rather than throwing", async () => {
  const env = makeEnv({
    AI: { run: () => Promise.reject(new Error("workers ai down")) },
    VECTORS: makeStubVectors([]),
  });
  await seedReadyArticle(env.DB, {
    id: "kw1",
    title: "Widgets Are Great",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const hits = await searchArticles(env, "Widgets", 20);
  assertEquals(hits.map((h) => h.article.id), ["kw1"]);
  assertEquals(hits[0].score, 0);
});

Deno.test("searchArticles: a Vectorize query failure (not just 'no matches') also falls back to keyword search", async () => {
  const env = makeEnv({
    AI: makeStubAi(new Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    VECTORS: {
      upsert: () => Promise.reject(new Error("not used")),
      deleteByIds: () => Promise.reject(new Error("not used")),
      query: () => Promise.reject(new Error("Binding VECTORS needs to be run remotely")),
    },
  });
  await seedReadyArticle(env.DB, {
    id: "kw1",
    title: "Widgets Are Great",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const hits = await searchArticles(env, "Widgets", 20);
  assertEquals(hits.map((h) => h.article.id), ["kw1"]);
  assertEquals(hits[0].score, 0);
});

Deno.test("searchArticles: hydrated rows never carry full_text (ArticleListItem shape)", async () => {
  const env = makeEnv({
    AI: makeStubAi(new Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    VECTORS: makeStubVectors([{ id: "sem-a", score: 0.9 }]),
  });
  await seedReadyArticle(env.DB, {
    id: "sem-a",
    title: "Article A",
    added_at: "2026-01-01T00:00:00.000Z",
  });

  const hits = await searchArticles(env, "some query", 20);
  assertEquals("full_text" in hits[0].article, false);
});
