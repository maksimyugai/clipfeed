import "./env.d.ts";
import { assertEquals } from "@std/assert";
import {
  buildCandidatePool,
  parseSemanticDedupMaxCandidates,
  parseSemanticDedupThreshold,
  type SemanticDedupConfig,
} from "./agent-pool.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { FakeKv } from "./testing/fake_kv.ts";
import type { Candidate } from "./agent-types.ts";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";

const NOW = new Date("2026-01-02T12:00:00.000Z");

// Title defaults to a single fused token derived from id (not a fixed
// literal, and deliberately NOT a normal sentence with shared filler words)
// so candidates built without an explicit title never collide under the
// pool's title-exact/Jaccard dedup layers (Task 24 Part B) — same
// convention as ranking_test.ts's makeCandidate. Tests that specifically
// want two candidates to collide pass matching titles explicitly.
function makeCandidate(overrides: Partial<Candidate>): Candidate {
  return {
    id: "c",
    sourceId: "src",
    discoverySource: "example.com",
    title: `zzzzzzzzz${overrides.id ?? "c"}`,
    url: "https://example.com/x",
    snippet: "",
    publishedAt: NOW.toISOString(),
    ...overrides,
  };
}

Deno.test("buildCandidatePool: drops candidates older than 24h, keeps fresh ones", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const fresh = makeCandidate({
    id: "fresh",
    url: "https://example.com/fresh",
    publishedAt: "2026-01-02T10:00:00.000Z",
  });
  const stale = makeCandidate({
    id: "stale",
    url: "https://example.com/stale",
    publishedAt: "2026-01-01T00:00:00.000Z",
  });

  const { pool } = await buildCandidatePool(db, kv, [fresh, stale], NOW);
  assertEquals(pool.map((c) => c.id), ["fresh"]);
});

Deno.test("buildCandidatePool: a candidate with no publishedAt is kept (can't judge age)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const noDate = makeCandidate({
    id: "no-date",
    url: "https://example.com/no-date",
    publishedAt: null,
  });
  const { pool } = await buildCandidatePool(db, kv, [noDate], NOW);
  assertEquals(pool.map((c) => c.id), ["no-date"]);
});

Deno.test("buildCandidatePool: pool-internal dedupe by canonicalized URL (trailing slash, www, hash ignored)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const a = makeCandidate({
    id: "a",
    url: "https://www.example.com/post/",
    publishedAt: "2026-01-02T11:00:00.000Z",
  });
  const b = makeCandidate({
    id: "b",
    url: "https://example.com/post#section",
    publishedAt: "2026-01-02T10:00:00.000Z",
  });

  const { pool } = await buildCandidatePool(db, kv, [a, b], NOW);
  assertEquals(pool.length, 1);
  // Newest-first sort runs before dedupe, so the more recent duplicate wins.
  assertEquals(pool[0].id, "a");
});

Deno.test("buildCandidatePool: drops candidates whose exact URL already exists in D1", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  db.rows.push({
    id: "existing-1",
    url: "https://example.com/already-saved",
    title: "x",
    source: null,
    added_at: NOW.toISOString(),
    added_via: "manual",
    tags: "[]",
    status: "ready",
    archived: 0,
    error: null,
    canonical_url: null,
    author: null,
    published_at: null,
    lang_original: null,
    full_text: null,
    summary_ru: null,
    summary_en: null,
    summary_json: null,
  });

  const existing = makeCandidate({ id: "dup", url: "https://example.com/already-saved" });
  const brandNew = makeCandidate({ id: "new", url: "https://example.com/brand-new" });

  const { pool } = await buildCandidatePool(db, kv, [existing, brandNew], NOW);
  assertEquals(pool.map((c) => c.id), ["new"]);
});

Deno.test("buildCandidatePool: caps at 160, newest first", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidates: Candidate[] = Array.from({ length: 200 }, (_, i) =>
    makeCandidate({
      id: `c${i}`,
      url: `https://example.com/${i}`,
      publishedAt: new Date(NOW.getTime() - i * 1000).toISOString(),
    }));

  const { pool } = await buildCandidatePool(db, kv, candidates, NOW);
  assertEquals(pool.length, 160);
  assertEquals(pool[0].id, "c0");
  assertEquals(pool[159].id, "c159");
});

Deno.test("buildCandidatePool: empty input yields an empty pool without querying D1 for nothing", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const { pool } = await buildCandidatePool(db, kv, [], NOW);
  assertEquals(pool, []);
});

// --- thin/mirror host filter (link-posts, not articles) ---

Deno.test("buildCandidatePool: drops candidates on known thin/mirror hosts, keeps everything else", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const thin = [
    makeCandidate({ id: "xcancel", url: "https://xcancel.com/someuser/status/123" }),
    makeCandidate({ id: "nitter", url: "https://nitter.net/someuser/status/456" }),
    makeCandidate({ id: "twitter", url: "https://twitter.com/someuser/status/789" }),
    makeCandidate({ id: "x", url: "https://x.com/someuser/status/321" }),
    makeCandidate({ id: "tco", url: "https://t.co/abc123" }),
    // www-prefixed variant of a denylisted host is still caught.
    makeCandidate({ id: "www-x", url: "https://www.x.com/someuser/status/654" }),
  ];
  const real = makeCandidate({ id: "real", url: "https://arstechnica.com/article" });

  const { pool } = await buildCandidatePool(db, kv, [...thin, real], NOW);
  assertEquals(pool.map((c) => c.id), ["real"]);
});

Deno.test("buildCandidatePool: a subdomain of a denylisted host is not caught (exact-host match only)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const subdomain = makeCandidate({ id: "sub", url: "https://blog.x.com/some-post" });
  const { pool } = await buildCandidatePool(db, kv, [subdomain], NOW);
  assertEquals(pool.map((c) => c.id), ["sub"]);
});

// --- paywalled-title filter (see PAYWALL_TITLE_MARKERS) — a cheap,
// no-fetch-needed signal some sources embed directly in the title. ---

Deno.test("buildCandidatePool: drops a candidate whose title starts with the LWN subscriber-only marker '[$]'", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const paywalled = makeCandidate({
    id: "paywalled",
    title: "[$] Fedora grapples with change",
    url: "https://lwn.net/Articles/1/",
  });
  const free = makeCandidate({
    id: "free",
    title: "AMD Getting The Linux Kernel Ready For Zen 6",
    url: "https://lwn.net/Articles/2/",
  });

  const { pool } = await buildCandidatePool(db, kv, [paywalled, free], NOW);
  assertEquals(pool.map((c) => c.id), ["free"]);
});

Deno.test("buildCandidatePool: the paywall marker must be at the START of the title, not merely present", async () => {
  // Regression guard for the obvious over-eager alternative (a substring
  // check anywhere in the title) — "$" appearing mid-title (e.g. a price)
  // is real editorial content, not LWN's subscriber-only convention.
  const db = new FakeD1();
  const kv = new FakeKv();
  const notPaywalled = makeCandidate({
    id: "not-paywalled",
    title: "New GPU launches at $499, undercutting rivals [$] mentioned in passing",
  });
  const { pool } = await buildCandidatePool(db, kv, [notPaywalled], NOW);
  assertEquals(pool.map((c) => c.id), ["not-paywalled"]);
});

// --- learned thin-host blocklist (see thin-host-learning.ts) — the filter
// is a union: static denylist above, plus any host the KV list has learned. ---

Deno.test("buildCandidatePool: drops a candidate on a LEARNED thin host (not in the static denylist)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  await kv.put("thinhost:mirror.example", "2"); // already crossed the threshold

  const learned = makeCandidate({ id: "learned", url: "https://mirror.example/post/1" });
  const real = makeCandidate({ id: "real", url: "https://arstechnica.com/article" });

  const { pool } = await buildCandidatePool(db, kv, [learned, real], NOW);
  assertEquals(pool.map((c) => c.id), ["real"]);
});

Deno.test("buildCandidatePool: keeps a candidate on a host with a count still BELOW the learned threshold", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  await kv.put("thinhost:mirror.example", "1"); // one failure so far — not learned yet

  const notYetLearned = makeCandidate({ id: "not-yet", url: "https://mirror.example/post/1" });
  const { pool } = await buildCandidatePool(db, kv, [notYetLearned], NOW);
  assertEquals(pool.map((c) => c.id), ["not-yet"]);
});

Deno.test("buildCandidatePool: the static denylist and the learned list both apply independently (true union)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  await kv.put("thinhost:mirror.example", "5");

  const staticallyDenied = makeCandidate({ id: "static", url: "https://x.com/a/status/1" });
  const learnedDenied = makeCandidate({ id: "learned", url: "https://mirror.example/a" });
  const real = makeCandidate({ id: "real", url: "https://arstechnica.com/article" });

  const { pool } = await buildCandidatePool(db, kv, [staticallyDenied, learnedDenied, real], NOW);
  assertEquals(pool.map((c) => c.id), ["real"]);
});

// --- Task 24 Part B: pre-scrape title-based dedup (normalized-exact +
// Jaccard), against both the 72h DB window and other pool candidates ---

function pushExistingRow(db: FakeD1, overrides: { id: string; title: string; added_at: string }) {
  db.rows.push({
    url: `https://example.com/${overrides.id}`,
    source: null,
    added_via: "manual",
    tags: "[]",
    status: "ready",
    archived: 0,
    error: null,
    canonical_url: null,
    author: null,
    published_at: null,
    lang_original: null,
    full_text: null,
    summary_ru: null,
    summary_en: null,
    summary_json: null,
    ...overrides,
  });
}

Deno.test("buildCandidatePool: drops a candidate whose normalized title exactly matches one in the 72h DB window", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  pushExistingRow(db, {
    id: "existing-1",
    title: "AMD Prepares Zen 6 Perf Profiling in the Linux Kernel",
    added_at: "2026-01-02T00:00:00.000Z", // within 72h of NOW (2026-01-02T12:00)
  });

  const dup = makeCandidate({
    id: "dup",
    // Punctuation/case differ but normalize to the same exact form.
    title: "amd prepares zen 6 perf profiling in the linux kernel!",
    url: "https://elsewhere.example/post",
  });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [dup], NOW);
  assertEquals(pool, []);
  assertEquals(dedupDrops, [
    { candidateTitle: dup.title, reason: "title", matchedId: "existing-1" },
  ]);
});

Deno.test("buildCandidatePool: keeps a candidate whose matching DB title is OUTSIDE the 72h window", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  pushExistingRow(db, {
    id: "old-1",
    title: "AMD Prepares Zen 6 Perf Profiling in the Linux Kernel",
    added_at: "2025-12-20T00:00:00.000Z", // well outside 72h of NOW
  });

  const notReallyADup = makeCandidate({
    id: "fresh",
    title: "AMD Prepares Zen 6 Perf Profiling in the Linux Kernel",
    url: "https://elsewhere.example/post",
  });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [notReallyADup], NOW);
  assertEquals(pool.map((c) => c.id), ["fresh"]);
  assertEquals(dedupDrops, []);
});

Deno.test("buildCandidatePool: drops a candidate whose title is Jaccard->=0.6 similar to one in the 72h DB window", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  pushExistingRow(db, {
    id: "existing-2",
    title: "Moonshot AI releases Kimi K2 model with major reasoning gains",
    added_at: "2026-01-02T00:00:00.000Z",
  });

  const paraphrase = makeCandidate({
    id: "paraphrase",
    title: "Kimi K2, the new Moonshot AI model, brings major reasoning gains",
    url: "https://elsewhere.example/post",
  });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [paraphrase], NOW);
  assertEquals(pool, []);
  assertEquals(dedupDrops, [
    { candidateTitle: paraphrase.title, reason: "jaccard", matchedId: "existing-2" },
  ]);
});

Deno.test("buildCandidatePool: pool-internal exact-title duplicate — keeps the first (newest), drops the later one with no matchedId", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const newer = makeCandidate({
    id: "newer",
    title: "Same Story Different URL",
    url: "https://a.example/post",
    publishedAt: "2026-01-02T11:00:00.000Z",
  });
  const older = makeCandidate({
    id: "older",
    title: "same story different url",
    url: "https://b.example/post",
    publishedAt: "2026-01-02T10:00:00.000Z",
  });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [newer, older], NOW);
  assertEquals(pool.map((c) => c.id), ["newer"]);
  assertEquals(dedupDrops, [
    { candidateTitle: older.title, reason: "title", matchedId: undefined },
  ]);
});

Deno.test("buildCandidatePool: pool-internal Jaccard duplicate is dropped, keeping the higher-ranked (earlier-sorted) candidate", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const first = makeCandidate({
    id: "first",
    title: "Moonshot AI releases Kimi K2 model with major reasoning gains",
    url: "https://a.example/post",
    publishedAt: "2026-01-02T11:00:00.000Z",
  });
  const second = makeCandidate({
    id: "second",
    title: "Kimi K2, the new Moonshot AI model, brings major reasoning gains",
    url: "https://b.example/post",
    publishedAt: "2026-01-02T10:00:00.000Z",
  });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [first, second], NOW);
  assertEquals(pool.map((c) => c.id), ["first"]);
  assertEquals(dedupDrops, [
    { candidateTitle: second.title, reason: "jaccard", matchedId: undefined },
  ]);
});

Deno.test("buildCandidatePool: unrelated titles are never dropped by the title/Jaccard layers", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  pushExistingRow(db, {
    id: "existing-3",
    title: "NVIDIA announces new RTX 5090 graphics card",
    added_at: "2026-01-02T00:00:00.000Z",
  });

  const unrelated = makeCandidate({
    id: "unrelated",
    title: "Linux kernel 6.9 released with new scheduler",
    url: "https://elsewhere.example/post",
  });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [unrelated], NOW);
  assertEquals(pool.map((c) => c.id), ["unrelated"]);
  assertEquals(dedupDrops, []);
});

Deno.test("buildCandidatePool: drop counts by reason are all present in dedupDrops for the caller's run stats", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  db.rows.push({
    id: "existing-url-dup",
    url: "https://example.com/already-saved",
    title: "x",
    source: null,
    added_at: NOW.toISOString(),
    added_via: "manual",
    tags: "[]",
    status: "ready",
    archived: 0,
    error: null,
    canonical_url: null,
    author: null,
    published_at: null,
    lang_original: null,
    full_text: null,
    summary_ru: null,
    summary_en: null,
    summary_json: null,
  });
  pushExistingRow(db, {
    id: "existing-title-dup",
    title: "Exact Title Match Here",
    added_at: NOW.toISOString(),
  });
  pushExistingRow(db, {
    id: "existing-jaccard-dup",
    title: "Moonshot AI releases Kimi K2 model with major reasoning gains",
    added_at: NOW.toISOString(),
  });

  const urlDup = makeCandidate({ id: "url-dup", url: "https://example.com/already-saved" });
  const titleDup = makeCandidate({
    id: "title-dup",
    title: "exact title match here",
    url: "https://elsewhere.example/title-dup",
  });
  const jaccardDup = makeCandidate({
    id: "jaccard-dup",
    title: "Kimi K2, the new Moonshot AI model, brings major reasoning gains",
    url: "https://elsewhere.example/jaccard-dup",
  });
  const keeper = makeCandidate({ id: "keeper", url: "https://elsewhere.example/keeper" });

  const { pool, dedupDrops } = await buildCandidatePool(
    db,
    kv,
    [urlDup, titleDup, jaccardDup, keeper],
    NOW,
  );
  assertEquals(pool.map((c) => c.id), ["keeper"]);
  const reasonCounts = { url: 0, title: 0, jaccard: 0, semantic: 0 };
  for (const drop of dedupDrops) reasonCounts[drop.reason] += 1;
  assertEquals(reasonCounts, { url: 1, title: 1, jaccard: 1, semantic: 0 });
});

// --- Task 27: semantic dedup layer (last, most expensive, only runs when
// `semantic.vectors` is provided) ---

// A unit vector whose cosine similarity to the fixed BASIS vector below is
// exactly `cosine` — lets a test assert a precise score rather than an
// approximate one. Only dimensions 0/1 are non-zero; the rest pad out to
// EMBEDDING_DIMENSIONS, since embedText's dimension guard requires the
// stubbed Ai to "return" a full-length vector.
function unitVectorWithCosine(cosine: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = cosine;
  v[1] = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return v;
}
const BASIS = (() => {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = 1;
  return v;
})();

// Maps a candidate's embedding text (title-only here, since every test
// candidate below uses an empty snippet) to a fixed vector — a stand-in for
// the real Workers AI call.
function makeStubAi(vectorsByText: Record<string, number[]>): Ai {
  return {
    run(_model: string, input: unknown) {
      const text = (input as { text: string }).text;
      const vector = vectorsByText[text];
      if (!vector) throw new Error(`makeStubAi: no vector stubbed for text "${text}"`);
      return Promise.resolve({ shape: [1, vector.length], data: [vector] });
    },
  };
}

function makeThrowingAi(): Ai {
  return { run: () => Promise.reject(new Error("workers ai down")) };
}

// Simulates `wrangler dev`'s reality: env.VECTORS is present but every
// method throws ("needs to be run remotely" — Vectorize has no local
// emulation) — distinct from `vectors: undefined` above.
function makeThrowingVectors(): VectorizeIndex {
  const fail = () => Promise.reject(new Error("Binding VECTORS needs to be run remotely"));
  return { upsert: fail, deleteByIds: fail, query: fail };
}

function makeStubVectors(
  matches: VectorizeMatch[],
  onQuery?: (vector: number[], options: VectorizeQueryOptions) => void,
): VectorizeIndex {
  return {
    upsert: () => Promise.reject(new Error("not used")),
    deleteByIds: () => Promise.reject(new Error("not used")),
    query(vector, options) {
      onQuery?.(vector, options ?? {});
      return Promise.resolve({ matches, count: matches.length });
    },
  };
}

function makeSemanticConfig(overrides: Partial<SemanticDedupConfig>): SemanticDedupConfig {
  return {
    ai: makeStubAi({}),
    vectors: undefined,
    model: "@cf/baai/bge-m3",
    maxCandidates: 40,
    threshold: 0.82,
    ...overrides,
  };
}

Deno.test("buildCandidatePool: semantic layer is skipped entirely when semantic config is omitted", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidate = makeCandidate({ id: "solo", title: "Some Unique Headline About Widgets" });
  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [candidate], NOW);
  assertEquals(pool.map((c) => c.id), ["solo"]);
  assertEquals(dedupDrops, []);
});

Deno.test("buildCandidatePool: semantic layer is skipped when vectors is undefined (no Vectorize provisioned)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidate = makeCandidate({ id: "solo", title: "Some Unique Headline About Widgets" });
  const semantic = makeSemanticConfig({ vectors: undefined });
  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [candidate], NOW, semantic);
  assertEquals(pool.map((c) => c.id), ["solo"]);
  assertEquals(dedupDrops, []);
});

Deno.test("buildCandidatePool: drops a candidate whose Vectorize match scores >= threshold, logs score + matchedId", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidate = makeCandidate({ id: "dup", title: "Paraphrased Headline" });
  const ai = makeStubAi({ "Paraphrased Headline": unitVectorWithCosine(0.95) });
  const vectors = makeStubVectors([{ id: "existing-article-id", score: 0.95 }]);
  const semantic = makeSemanticConfig({ ai, vectors, threshold: 0.82 });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [candidate], NOW, semantic);
  assertEquals(pool, []);
  assertEquals(dedupDrops, [{
    candidateTitle: "Paraphrased Headline",
    reason: "semantic",
    matchedId: "existing-article-id",
    score: 0.95,
  }]);
});

Deno.test("buildCandidatePool: keeps a candidate whose best Vectorize match scores below threshold", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidate = makeCandidate({ id: "distinct", title: "Distinct Headline" });
  const ai = makeStubAi({ "Distinct Headline": unitVectorWithCosine(0.5) });
  const vectors = makeStubVectors([{ id: "unrelated-id", score: 0.5 }]);
  const semantic = makeSemanticConfig({ ai, vectors, threshold: 0.82 });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [candidate], NOW, semantic);
  assertEquals(pool.map((c) => c.id), ["distinct"]);
  assertEquals(dedupDrops, []);
});

Deno.test("buildCandidatePool: queries Vectorize with topK=3 and an added_at filter 72h before `now`", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidate = makeCandidate({ id: "c1", title: "Headline One" });
  const ai = makeStubAi({ "Headline One": BASIS });
  let capturedOptions: VectorizeQueryOptions | undefined;
  const vectors = makeStubVectors([], (_vector, options) => {
    capturedOptions = options;
  });
  const semantic = makeSemanticConfig({ ai, vectors });

  await buildCandidatePool(db, kv, [candidate], NOW, semantic);
  assertEquals(capturedOptions?.topK, 3);
  assertEquals(capturedOptions?.filter, {
    added_at: { $gte: new Date(NOW.getTime() - 72 * 60 * 60 * 1000).toISOString() },
  });
});

Deno.test("buildCandidatePool: within-batch pairwise semantic dedup — keeps the first (newest), drops the later one, no matchedId", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  // Deliberately no shared words (Jaccard would otherwise catch these two
  // first, before the semantic layer ever runs) — that's the whole point
  // this test exists to demonstrate: differently-worded headlines about the
  // same story that the string layers miss.
  const first = makeCandidate({
    id: "first",
    title: "Kernel Maintainers Debate Scheduler Rewrite",
    url: "https://elsewhere.example/first",
    publishedAt: "2026-01-02T11:00:00.000Z",
  });
  const second = makeCandidate({
    id: "second",
    title: "Linux Task Scheduling Overhaul Sparks Argument",
    url: "https://elsewhere.example/second",
    publishedAt: "2026-01-02T10:00:00.000Z",
  });
  const ai = makeStubAi({
    "Kernel Maintainers Debate Scheduler Rewrite": BASIS,
    "Linux Task Scheduling Overhaul Sparks Argument": unitVectorWithCosine(0.9),
  });
  const vectors = makeStubVectors([]); // no DB matches — this is purely within-batch
  const semantic = makeSemanticConfig({ ai, vectors, threshold: 0.82 });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [first, second], NOW, semantic);
  assertEquals(pool.map((c) => c.id), ["first"]);
  assertEquals(dedupDrops, [{
    candidateTitle: "Linux Task Scheduling Overhaul Sparks Argument",
    reason: "semantic",
    score: 0.9,
  }]);
});

Deno.test("buildCandidatePool: candidates beyond maxCandidates are never embedded — left unchecked, not dropped", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const checked = makeCandidate({
    id: "checked",
    title: "Checked Headline",
    url: "https://elsewhere.example/checked",
    publishedAt: "2026-01-02T11:00:00.000Z",
  });
  const skipped = makeCandidate({
    id: "skipped",
    title: "Skipped Headline",
    url: "https://elsewhere.example/skipped",
    publishedAt: "2026-01-02T10:00:00.000Z",
  });
  // No vector stubbed for "Skipped Headline" — if it were embedded,
  // makeStubAi would throw and fail the test (unhandled rejection funnels
  // into the fail-open path, which would still keep it, masking the bug
  // this test exists to catch — so the assertion below on dedupDrops/pool
  // length is what actually proves it was never embedded).
  const ai = makeStubAi({ "Checked Headline": BASIS });
  const vectors = makeStubVectors([]);
  const semantic = makeSemanticConfig({ ai, vectors, maxCandidates: 1 });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [checked, skipped], NOW, semantic);
  assertEquals(pool.map((c) => c.id), ["checked", "skipped"]);
  assertEquals(dedupDrops, []);
});

Deno.test("buildCandidatePool: an embed failure fails OPEN — the candidate is kept, not dropped", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidate = makeCandidate({ id: "c1", title: "Headline One" });
  const semantic = makeSemanticConfig({ ai: makeThrowingAi(), vectors: makeStubVectors([]) });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [candidate], NOW, semantic);
  assertEquals(pool.map((c) => c.id), ["c1"]);
  assertEquals(dedupDrops, []);
});

Deno.test("buildCandidatePool: a Vectorize query failure (not merely 'no matches') also fails OPEN against the DB check, but the within-batch check still runs", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidate = makeCandidate({ id: "c1", title: "Headline One" });
  const ai = makeStubAi({ "Headline One": BASIS });
  const semantic = makeSemanticConfig({ ai, vectors: makeThrowingVectors() });

  const { pool, dedupDrops } = await buildCandidatePool(db, kv, [candidate], NOW, semantic);
  assertEquals(pool.map((c) => c.id), ["c1"]);
  assertEquals(dedupDrops, []);
});

// --- parseSemanticDedupMaxCandidates / parseSemanticDedupThreshold:
// defensive [vars] parsing ---

Deno.test("parseSemanticDedupMaxCandidates: undefined/empty falls back to the default (40)", () => {
  assertEquals(parseSemanticDedupMaxCandidates(undefined), 40);
  assertEquals(parseSemanticDedupMaxCandidates(""), 40);
  assertEquals(parseSemanticDedupMaxCandidates("  "), 40);
});

Deno.test("parseSemanticDedupMaxCandidates: a valid override is used, rounded", () => {
  assertEquals(parseSemanticDedupMaxCandidates("20"), 20);
  assertEquals(parseSemanticDedupMaxCandidates("20.6"), 21);
});

Deno.test("parseSemanticDedupMaxCandidates: out-of-range/non-numeric falls back to the default", () => {
  assertEquals(parseSemanticDedupMaxCandidates("0"), 40);
  assertEquals(parseSemanticDedupMaxCandidates("161"), 40);
  assertEquals(parseSemanticDedupMaxCandidates("not a number"), 40);
});

Deno.test("parseSemanticDedupThreshold: undefined/empty falls back to the default (0.82)", () => {
  assertEquals(parseSemanticDedupThreshold(undefined), 0.82);
  assertEquals(parseSemanticDedupThreshold(""), 0.82);
  assertEquals(parseSemanticDedupThreshold("  "), 0.82);
});

Deno.test("parseSemanticDedupThreshold: a valid override in [0,1] is used as-is", () => {
  assertEquals(parseSemanticDedupThreshold("0.9"), 0.9);
  assertEquals(parseSemanticDedupThreshold("0"), 0);
  assertEquals(parseSemanticDedupThreshold("1"), 1);
});

Deno.test("parseSemanticDedupThreshold: out-of-range/non-numeric falls back to the default", () => {
  assertEquals(parseSemanticDedupThreshold("-0.1"), 0.82);
  assertEquals(parseSemanticDedupThreshold("1.1"), 0.82);
  assertEquals(parseSemanticDedupThreshold("not a number"), 0.82);
});
