import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { buildCandidatePool } from "./agent-pool.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { FakeKv } from "./testing/fake_kv.ts";
import type { Candidate } from "./agent-types.ts";

const NOW = new Date("2026-01-02T12:00:00.000Z");

function makeCandidate(overrides: Partial<Candidate>): Candidate {
  return {
    id: "c",
    sourceId: "src",
    discoverySource: "example.com",
    title: "Title",
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

  const pool = await buildCandidatePool(db, kv, [fresh, stale], NOW);
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
  const pool = await buildCandidatePool(db, kv, [noDate], NOW);
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

  const pool = await buildCandidatePool(db, kv, [a, b], NOW);
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

  const pool = await buildCandidatePool(db, kv, [existing, brandNew], NOW);
  assertEquals(pool.map((c) => c.id), ["new"]);
});

Deno.test("buildCandidatePool: caps at 120, newest first", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const candidates: Candidate[] = Array.from({ length: 150 }, (_, i) =>
    makeCandidate({
      id: `c${i}`,
      url: `https://example.com/${i}`,
      publishedAt: new Date(NOW.getTime() - i * 1000).toISOString(),
    }));

  const pool = await buildCandidatePool(db, kv, candidates, NOW);
  assertEquals(pool.length, 120);
  assertEquals(pool[0].id, "c0");
  assertEquals(pool[119].id, "c119");
});

Deno.test("buildCandidatePool: empty input yields an empty pool without querying D1 for nothing", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const pool = await buildCandidatePool(db, kv, [], NOW);
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

  const pool = await buildCandidatePool(db, kv, [...thin, real], NOW);
  assertEquals(pool.map((c) => c.id), ["real"]);
});

Deno.test("buildCandidatePool: a subdomain of a denylisted host is not caught (exact-host match only)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  const subdomain = makeCandidate({ id: "sub", url: "https://blog.x.com/some-post" });
  const pool = await buildCandidatePool(db, kv, [subdomain], NOW);
  assertEquals(pool.map((c) => c.id), ["sub"]);
});

// --- learned thin-host blocklist (see thin-host-learning.ts) — the filter
// is a union: static denylist above, plus any host the KV list has learned. ---

Deno.test("buildCandidatePool: drops a candidate on a LEARNED thin host (not in the static denylist)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  await kv.put("thinhost:mirror.example", "2"); // already crossed the threshold

  const learned = makeCandidate({ id: "learned", url: "https://mirror.example/post/1" });
  const real = makeCandidate({ id: "real", url: "https://arstechnica.com/article" });

  const pool = await buildCandidatePool(db, kv, [learned, real], NOW);
  assertEquals(pool.map((c) => c.id), ["real"]);
});

Deno.test("buildCandidatePool: keeps a candidate on a host with a count still BELOW the learned threshold", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  await kv.put("thinhost:mirror.example", "1"); // one failure so far — not learned yet

  const notYetLearned = makeCandidate({ id: "not-yet", url: "https://mirror.example/post/1" });
  const pool = await buildCandidatePool(db, kv, [notYetLearned], NOW);
  assertEquals(pool.map((c) => c.id), ["not-yet"]);
});

Deno.test("buildCandidatePool: the static denylist and the learned list both apply independently (true union)", async () => {
  const db = new FakeD1();
  const kv = new FakeKv();
  await kv.put("thinhost:mirror.example", "5");

  const staticallyDenied = makeCandidate({ id: "static", url: "https://x.com/a/status/1" });
  const learnedDenied = makeCandidate({ id: "learned", url: "https://mirror.example/a" });
  const real = makeCandidate({ id: "real", url: "https://arstechnica.com/article" });

  const pool = await buildCandidatePool(db, kv, [staticallyDenied, learnedDenied, real], NOW);
  assertEquals(pool.map((c) => c.id), ["real"]);
});
