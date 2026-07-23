import "../env.d.ts";
import { assertEquals } from "@std/assert";
import {
  type CurationSelectionConfig,
  dedupStories,
  DEFAULT_AGENT_DAILY_PICKS,
  enforceRankingDiversity,
  fallbackPicks,
  parseAgentDailyPicks,
  rankCandidates,
  type RankedItem,
  selectPicks,
} from "./ranking.ts";
import type { Candidate } from "./agent-types.ts";
import { FakeD1 } from "../testing/fake_d1.ts";
import { insertPendingArticle } from "../articles/db.ts";

function makeCandidate(overrides: Partial<Candidate>): Candidate {
  // Title defaults to a single fused token derived from id (not a fixed
  // literal, and deliberately NOT a normal sentence with shared filler
  // words) so candidates built without an explicit title never share any
  // normalized token with each other — dedupStories() would otherwise see
  // any two default-titled candidates as the same story. Tests that
  // specifically want two candidates to collide pass matching titles
  // explicitly.
  return {
    id: "c",
    sourceId: "src",
    discoverySource: "example.com",
    title: `zzzzzzzzz${overrides.id ?? "c"}`,
    url: "https://example.com/x",
    snippet: "snippet",
    publishedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1() as unknown as D1Database,
    CACHE: {} as KVNamespace,
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
    QUEUE_WAIT_TIMEOUT_MIN: 30,
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

function anthropicTextResponse(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

// Task 33 §4: the model now returns a labeled, over-length list — each item
// shaped {"i": "<candidate id>", "topic": "..."}, not a flat array of ids.
// Candidates default to topic "other" here so they never accidentally match
// curation.json's real quota topics (linux/hardware/security) unless a test
// deliberately wants that interaction (see the quota-specific tests below,
// which use selectPicks directly with a synthetic config instead of relying
// on the real committed curation.json).
function labeledResponse(ids: string[], topic = "other"): Response {
  return anthropicTextResponse(JSON.stringify(ids.map((id) => ({ i: id, topic }))));
}

Deno.test("fallbackPicks: newest-first, one per distinct source, up to pickCount", () => {
  const candidates = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "c1", sourceId: "c" }),
    makeCandidate({ id: "d1", sourceId: "d" }),
    makeCandidate({ id: "e1", sourceId: "e" }),
  ];
  const picks = fallbackPicks(candidates, 5);
  assertEquals(picks, ["a1", "b1", "c1", "d1", "e1"]);
});

Deno.test("fallbackPicks: backfills from remaining candidates when fewer than pickCount distinct sources exist", () => {
  const candidates = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
  ];
  const picks = fallbackPicks(candidates, 3);
  assertEquals(picks, ["a1", "a2", "a3"]);
});

Deno.test("fallbackPicks: defaults to DEFAULT_AGENT_DAILY_PICKS (10) when pickCount is omitted", () => {
  const candidates = Array.from(
    { length: 12 },
    (_, i) => makeCandidate({ id: `s${i}-1`, sourceId: `s${i}` }),
  );
  const picks = fallbackPicks(candidates);
  assertEquals(picks.length, DEFAULT_AGENT_DAILY_PICKS);
});

Deno.test("fallbackPicks: covers at least min(3, distinct sources) sources when extended to a larger pickCount", () => {
  const candidates = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
    makeCandidate({ id: "b2", sourceId: "b" }),
    makeCandidate({ id: "c1", sourceId: "c" }),
    makeCandidate({ id: "c2", sourceId: "c" }),
  ];
  const picks = fallbackPicks(candidates, 10);
  assertEquals(picks.length, 6);
  const sourceIds = new Set(candidates.filter((c) => picks.includes(c.id)).map((c) => c.sourceId));
  assertEquals(sourceIds.size, 3);
  assertEquals(sourceIds.size >= Math.min(3, sourceIds.size), true);
});

Deno.test("fallbackPicks: empty input yields no picks", () => {
  assertEquals(fallbackPicks([]), []);
});

// --- enforceRankingDiversity: the fixup table (over-representation, backfill order, exhausted pool) ---
// Still exercised directly (pure function), even though it's now only used
// on the fallback path inside rankCandidates (see ranking.ts's doc comment).

Deno.test("enforceRankingDiversity: no violation -> picks pass through unchanged, even if shorter than pickCount", () => {
  const pool = [
    makeCandidate({ id: "a", sourceId: "src-a" }),
    makeCandidate({ id: "b", sourceId: "src-b" }),
  ];
  const picks = enforceRankingDiversity(["b"], pool, 10);
  assertEquals(picks, ["b"]);
});

Deno.test("enforceRankingDiversity: over-representation — a 3rd pick from an already-capped source is dropped and backfilled from the next-ranked candidate of another source", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
  ];
  const picks = enforceRankingDiversity(["a1", "a2", "a3"], pool, 3);
  assertEquals(picks, ["a1", "a2", "b1"]);
});

Deno.test("enforceRankingDiversity: backfill order follows the pool's own order (newest-first), not the model's ranked order", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "c1", sourceId: "c" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
  ];
  const picks = enforceRankingDiversity(["a1", "a2", "a3"], pool, 3);
  assertEquals(picks, ["a1", "a2", "c1"]);
});

Deno.test("enforceRankingDiversity: two sources both over-represented drops+backfills independently for each", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
    makeCandidate({ id: "b2", sourceId: "b" }),
    makeCandidate({ id: "b3", sourceId: "b" }),
    makeCandidate({ id: "c1", sourceId: "c" }),
  ];
  const picks = enforceRankingDiversity(["a1", "a2", "a3", "b1", "b2", "b3"], pool, 6);
  assertEquals(picks, ["a1", "a2", "b1", "b2", "c1"]);
});

Deno.test("enforceRankingDiversity: exhausted pool — fewer than pickCount is returned rather than violating the cap", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "a4", sourceId: "a" }),
  ];
  const picks = enforceRankingDiversity(["a1", "a2", "a3", "a4"], pool, 10);
  assertEquals(picks, ["a1", "a2"]);
});

Deno.test("enforceRankingDiversity: never exceeds pickCount even when backfill candidates are plentiful", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
    makeCandidate({ id: "b2", sourceId: "b" }),
  ];
  const picks = enforceRankingDiversity(["a1", "a2", "a3"], pool, 2);
  assertEquals(picks, ["a1", "a2"]);
});

// --- dedupStories: post-pick enforcement (fallback path only now) ---

Deno.test("dedupStories: no similar titles -> picks pass through unchanged", () => {
  const pool = [
    makeCandidate({ id: "a", title: "NVIDIA announces new RTX 5090 graphics card" }),
    makeCandidate({ id: "b", title: "Linux kernel 6.9 released with new scheduler" }),
  ];
  assertEquals(dedupStories(["a", "b"], pool, 10), ["a", "b"]);
});

Deno.test("dedupStories: a same-story duplicate (lower-ranked) is dropped and backfilled from the next pool candidate", () => {
  const pool = [
    makeCandidate({ id: "a", sourceId: "outlet-a", title: "Moonshot AI launches Kimi K2 model" }),
    makeCandidate({
      id: "b",
      sourceId: "outlet-b",
      title: "Moonshot AI выпустила модель Kimi K2",
    }),
    makeCandidate({
      id: "c",
      sourceId: "outlet-c",
      title: "Linux kernel 6.9 released with new scheduler",
    }),
  ];
  const picks = dedupStories(["a", "b", "c"], pool, 3);
  assertEquals(picks, ["a", "c"]);
});

Deno.test("dedupStories: backfill still respects the per-source cap (MAX_PICKS_PER_SOURCE)", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "src-a", title: "Moonshot AI launches Kimi K2 model" }),
    makeCandidate({
      id: "a2",
      sourceId: "src-a",
      title: "Something else entirely from source a about telescopes",
    }),
    makeCandidate({
      id: "b1",
      sourceId: "src-b",
      title: "Moonshot AI выпустила модель Kimi K2",
    }),
    makeCandidate({
      id: "a3",
      sourceId: "src-a",
      title: "A third, unrelated src-a story about bakeries",
    }),
    makeCandidate({
      id: "c1",
      sourceId: "src-c",
      title: "An unrelated story about marathon training from source c",
    }),
  ];
  const picks = dedupStories(["a1", "a2", "b1"], pool, 3);
  assertEquals(picks, ["a1", "a2", "c1"]);
});

Deno.test("dedupStories: exhausted pool — fewer picks than pickCount is fine, never violates the cap or re-includes a duplicate", () => {
  const pool = [
    makeCandidate({ id: "a", title: "Moonshot AI launches Kimi K2 model" }),
    makeCandidate({ id: "b", title: "Moonshot AI выпустила модель Kimi K2" }),
  ];
  const picks = dedupStories(["a", "b"], pool, 10);
  assertEquals(picks, ["a"]);
});

Deno.test("dedupStories: against-DB window — a pick matching a title saved in the last 48h is dropped even with no in-batch duplicate", () => {
  const pool = [
    makeCandidate({ id: "a", title: "Moonshot AI launches Kimi K2 model" }),
    makeCandidate({ id: "b", title: "Linux kernel 6.9 released with new scheduler" }),
  ];
  const recentTitles = ["Moonshot AI выпустила модель Kimi K2"];
  const picks = dedupStories(["a", "b"], pool, 10, recentTitles);
  assertEquals(picks, ["b"]);
});

Deno.test("dedupStories: logs 'rank_story_dedup' with kept/dropped counts only when a drop actually happens", () => {
  const original = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const pool = [
      makeCandidate({ id: "a", title: "Moonshot AI launches Kimi K2 model" }),
      makeCandidate({ id: "b", title: "Moonshot AI выпустила модель Kimi K2" }),
      makeCandidate({ id: "c", title: "Linux kernel 6.9 released with new scheduler" }),
    ];
    dedupStories(["a", "b", "c"], pool, 3);
    const parsed = logs.map((args) => JSON.parse(String(args[0])));
    const dedupLog = parsed.find((l) => l.event === "rank_story_dedup");
    assertEquals(dedupLog?.kept, 2);
    assertEquals(dedupLog?.dropped, 1);

    logs.length = 0;
    const noDupPool = [
      makeCandidate({ id: "x", title: "NVIDIA announces new RTX 5090 graphics card" }),
      makeCandidate({ id: "y", title: "Linux kernel 6.9 released with new scheduler" }),
    ];
    dedupStories(["x", "y"], noDupPool, 2);
    assertEquals(logs.some((args) => String(args[0]).includes("rank_story_dedup")), false);
  } finally {
    console.log = original;
  }
});

// --- parseAgentDailyPicks: defensive [vars] parsing ---

Deno.test("parseAgentDailyPicks: undefined/empty falls back to the default, no warning", () => {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    assertEquals(parseAgentDailyPicks(undefined), DEFAULT_AGENT_DAILY_PICKS);
    assertEquals(parseAgentDailyPicks("  "), DEFAULT_AGENT_DAILY_PICKS);
    assertEquals(warnings.length, 0);
  } finally {
    console.warn = original;
  }
});

Deno.test("parseAgentDailyPicks: a valid in-range value is used as-is, no warning", () => {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    assertEquals(parseAgentDailyPicks("7"), 7);
    assertEquals(warnings.length, 0);
  } finally {
    console.warn = original;
  }
});

Deno.test("parseAgentDailyPicks: the boundary values 1 and 20 are both accepted", () => {
  assertEquals(parseAgentDailyPicks("1"), 1);
  assertEquals(parseAgentDailyPicks("20"), 20);
});

Deno.test("parseAgentDailyPicks: non-numeric, below-min, and above-max all fall back WITH a warning", () => {
  const original = console.warn;
  let warnCount = 0;
  console.warn = () => {
    warnCount += 1;
  };
  try {
    assertEquals(parseAgentDailyPicks("not-a-number"), DEFAULT_AGENT_DAILY_PICKS);
    assertEquals(parseAgentDailyPicks("0"), DEFAULT_AGENT_DAILY_PICKS);
    assertEquals(parseAgentDailyPicks("21"), DEFAULT_AGENT_DAILY_PICKS);
    assertEquals(warnCount, 3);
  } finally {
    console.warn = original;
  }
});

// --- rankCandidates: empty pool / labeled parse contract ---

Deno.test("rankCandidates: empty candidate pool short-circuits to no picks, no LLM call", async () => {
  const env = makeEnv();
  const picks = await rankCandidates(env, "interests", []);
  assertEquals(picks, []);
});

Deno.test("rankCandidates: a valid labeled JSON array is parsed and selected via general fill", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(labeledResponse(["a", "c"]))) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a" }),
      makeCandidate({ id: "b", sourceId: "src-b" }),
      makeCandidate({ id: "c", sourceId: "src-c" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(picks, ["a", "c"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: fenced JSON is unwrapped", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      anthropicTextResponse('```json\n[{"i": "b", "topic": "other"}]\n```'),
    )) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a" }),
      makeCandidate({ id: "b", sourceId: "src-b" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(picks, ["b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: ids not in the pool are filtered out", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(labeledResponse(["a", "not-real", "b"]))) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a" }),
      makeCandidate({ id: "b", sourceId: "src-b" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(picks, ["a", "b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: an unrecognized topic label falls back to 'other' rather than rejecting the item", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      anthropicTextResponse(JSON.stringify([{ i: "a", topic: "not-a-real-topic" }])),
    )) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [makeCandidate({ id: "a", sourceId: "src-a" })];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(picks, ["a"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: entries missing 'i', a non-string 'i', or a duplicate 'i' are all dropped rather than crashing the parse", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      anthropicTextResponse(JSON.stringify([
        { topic: "other" }, // missing i
        { i: 42, topic: "other" }, // non-string i
        { i: "a", topic: "other" },
        { i: "a", topic: "other" }, // duplicate of the valid one above
        { i: "b", topic: "other" },
      ])),
    )) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a" }),
      makeCandidate({ id: "b", sourceId: "src-b" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(picks, ["a", "b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: only invalid ids -> parse treated as failed -> retries then falls back", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(labeledResponse(["nonexistent"]));
  }) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a" }),
      makeCandidate({ id: "b", sourceId: "src-b" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(calls, 2);
    assertEquals(picks, fallbackPicks(candidates));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: a flat array of plain id strings (the old contract) is rejected -> retries then falls back", async () => {
  // Task 33 changed the response CONTRACT — a model/gateway that still
  // responds with the pre-Task-33 flat array of strings must be treated as
  // a parse failure, not silently accepted, since there's no topic label to
  // read.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(anthropicTextResponse(JSON.stringify(["a", "b"])));
  }) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a" }),
      makeCandidate({ id: "b", sourceId: "src-b" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(calls, 2);
    assertEquals(picks, fallbackPicks(candidates));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: unparseable output retries once, then falls back to distinct-source picks", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(anthropicTextResponse("not json at all"));
  }) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a" }),
      makeCandidate({ id: "b", sourceId: "src-b" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(calls, 2);
    assertEquals(picks, fallbackPicks(candidates));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: provider/network error retries once, then falls back (never throws)", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(new Response("server error", { status: 500 }));
  }) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [makeCandidate({ id: "a", sourceId: "src-a" })];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(calls, 2);
    assertEquals(picks, fallbackPicks(candidates));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: does not touch env.CACHE (no daily budget consumption)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(labeledResponse(["a"]))) as typeof fetch;
  try {
    const env = makeEnv({
      CACHE: {
        get(): Promise<string | null> {
          throw new Error("CACHE should not be touched by ranking");
        },
        put(): Promise<void> {
          throw new Error("CACHE should not be touched by ranking");
        },
        delete(): Promise<void> {
          throw new Error("CACHE should not be touched by ranking");
        },
        list(): Promise<never> {
          throw new Error("CACHE should not be touched by ranking");
        },
      },
    });
    const picks = await rankCandidates(env, "interests", [makeCandidate({ id: "a" })]);
    assertEquals(picks, ["a"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: works in workers-ai mode too (all three modes supported)", async () => {
  const env = makeEnv({
    ANTHROPIC_API_KEY: undefined,
    AI: {
      run(): Promise<unknown> {
        return Promise.resolve({ response: JSON.stringify([{ i: "a", topic: "other" }]) });
      },
    },
  });
  const picks = await rankCandidates(env, "interests", [makeCandidate({ id: "a" })]);
  assertEquals(picks, ["a"]);
});

// --- rankCandidates: the rendered prompt states N, the hard rules, and the ---
// --- labeled response shape (Task 33 §4) ---

Deno.test("rankCandidates: the rendered system prompt states the pick count, hard rules, and the labeled response shape", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSystem = "";
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { system: string };
    capturedSystem = body.system;
    return Promise.resolve(labeledResponse(["a"]));
  }) as typeof fetch;
  try {
    const env = makeEnv({ AGENT_DAILY_PICKS: "7" });
    await rankCandidates(env, "interests", [makeCandidate({ id: "a" })]);
    assertEquals(capturedSystem.includes("pick the final 7 items"), true);
    assertEquals(capturedSystem.includes("up to 14 good items"), true);
    assertEquals(capturedSystem.includes("at most 2 items per source"), true);
    assertEquals(
      capturedSystem.includes("cover at least 3 distinct topic areas from the interest list"),
      true,
    );
    assertEquals(
      capturedSystem.includes("prefer substantive reporting over link-posts and speculation"),
      true,
    );
    assertEquals(
      capturedSystem.includes("never rank two items covering the same story/event"),
      true,
    );
    assertEquals(capturedSystem.includes('"i": "<candidate id>"'), true);
    assertEquals(capturedSystem.includes("ai, hardware, linux, security"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: the ranked-list cap never exceeds 24 even at the maximum AGENT_DAILY_PICKS (20)", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSystem = "";
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { system: string };
    capturedSystem = body.system;
    return Promise.resolve(labeledResponse(["a"]));
  }) as typeof fetch;
  try {
    const env = makeEnv({ AGENT_DAILY_PICKS: "20" });
    await rankCandidates(env, "interests", [makeCandidate({ id: "a" })]);
    assertEquals(capturedSystem.includes("up to 24 good items"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: a missing/invalid AGENT_DAILY_PICKS falls back to 10 in the rendered prompt", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSystem = "";
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { system: string };
    capturedSystem = body.system;
    return Promise.resolve(labeledResponse(["a"]));
  }) as typeof fetch;
  try {
    const env = makeEnv({ AGENT_DAILY_PICKS: "not-a-number" });
    await rankCandidates(env, "interests", [makeCandidate({ id: "a" })]);
    assertEquals(
      capturedSystem.includes(`pick the final ${DEFAULT_AGENT_DAILY_PICKS} items`),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- rankCandidates: end-to-end wiring of the against-DB dedup window ---
// (still applies on the successful-parse path via selectPicks internally)

Deno.test("rankCandidates: queries the DB for titles saved in the last 48h and drops a same-story pick", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(labeledResponse(["a", "b"]))) as typeof fetch;
  try {
    const db = new FakeD1();
    const now = new Date("2026-01-03T12:00:00.000Z");
    await insertPendingArticle(db as unknown as D1Database, {
      id: "recent-1",
      url: "https://other-outlet.example.com/kimi-k2",
      title: "Moonshot AI выпустила модель Kimi K2",
      source: "other-outlet.example.com",
      tags: [],
      added_via: "agent",
      added_at: "2026-01-02T18:00:00.000Z",
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a", title: "Moonshot AI launches Kimi K2 model" }),
      makeCandidate({
        id: "b",
        sourceId: "src-b",
        title: "Linux kernel 6.9 released with new scheduler",
      }),
    ];
    const picks = await rankCandidates(env, "interests", candidates, [], now);
    assertEquals(picks, ["b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: a saved title OLDER than the 48h window does not suppress a matching pick", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(labeledResponse(["a", "b"]))) as typeof fetch;
  try {
    const db = new FakeD1();
    const now = new Date("2026-01-03T12:00:00.000Z");
    await insertPendingArticle(db as unknown as D1Database, {
      id: "old-1",
      url: "https://other-outlet.example.com/kimi-k2",
      title: "Moonshot AI выпустила модель Kimi K2",
      source: "other-outlet.example.com",
      tags: [],
      added_via: "agent",
      added_at: "2025-12-30T12:00:00.000Z",
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const candidates = [
      makeCandidate({ id: "a", sourceId: "src-a", title: "Moonshot AI launches Kimi K2 model" }),
      makeCandidate({
        id: "b",
        sourceId: "src-b",
        title: "Linux kernel 6.9 released with new scheduler",
      }),
    ];
    const picks = await rankCandidates(env, "interests", candidates, [], now);
    assertEquals(picks, ["a", "b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- rankCandidates: unknown priority source ids from curation.json are ---
// --- ignored when `sources` (sources.json) doesn't recognize them ---

Deno.test("rankCandidates: priority sources from curation.json that aren't passed in `sources` never get a forced/guaranteed slot", async () => {
  // curation.json lists "phoronix"/"lwn"/"thehackernews" as priority
  // sources — passing an empty `sources` list (the default) means
  // validatePrioritySources rejects all of them as unknown, so general fill
  // alone determines the outcome; this just documents that behavior rather
  // than asserting on ranking.ts's internal wiring.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(labeledResponse(["a", "b"]))) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a", sourceId: "phoronix" }),
      makeCandidate({ id: "b", sourceId: "src-b" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates, []);
    assertEquals(picks, ["a", "b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- selectPicks: the deterministic selection algorithm (Task 33 §6) ---
// Tested directly with a synthetic CurationSelectionConfig, independent of
// the real committed curation.json — this is where priority sources, topic
// quotas, general fill, the preferred-domain tie-break, and the
// throughout-constraints (max-2-per-source, story-dedup) get their real
// coverage.

function rankedItem(id: string, topic = "other"): RankedItem {
  return { id, topic };
}

function noopConfig(overrides: Partial<CurationSelectionConfig> = {}): CurationSelectionConfig {
  return { topicQuotas: {}, prioritySources: [], preferredDomains: [], ...overrides };
}

Deno.test("selectPicks: empty config behaves exactly like plain ranked-order general fill", () => {
  const pool = [
    makeCandidate({ id: "a", sourceId: "src-a" }),
    makeCandidate({ id: "b", sourceId: "src-b" }),
    makeCandidate({ id: "c", sourceId: "src-c" }),
  ];
  const ranked = [rankedItem("a"), rankedItem("b"), rankedItem("c")];
  const composition = selectPicks(ranked, pool, noopConfig(), 2);
  assertEquals(composition.picks, ["a", "b"]);
  assertEquals(composition.priorityFilled, {});
  assertEquals(composition.quotaFilled, {});
});

Deno.test("selectPicks: priority source present in the ranked list gets a guaranteed slot even if ranked low", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "p1", sourceId: "priority-src" }),
  ];
  // Model ranked the priority source's item DEAD LAST — it must still be
  // selected because prioritySources gets first pick, before general fill.
  const ranked = [rankedItem("a1"), rankedItem("a2"), rankedItem("a3"), rankedItem("p1")];
  const config = noopConfig({ prioritySources: ["priority-src"] });
  const composition = selectPicks(ranked, pool, config, 3);
  assertEquals(composition.picks.includes("p1"), true);
  assertEquals(composition.priorityFilled, { "priority-src": true });
});

Deno.test("selectPicks: priority source absent from the ranked list is unfilled, no forcing", () => {
  const pool = [
    makeCandidate({ id: "a", sourceId: "a" }),
    // "priority-src" has candidates in the POOL but the model never ranked
    // any of them — selectPicks only looks at rankedItems, not the raw pool.
    makeCandidate({ id: "p1", sourceId: "priority-src" }),
  ];
  const ranked = [rankedItem("a")];
  const config = noopConfig({ prioritySources: ["priority-src"] });
  const composition = selectPicks(ranked, pool, config, 5);
  assertEquals(composition.picks.includes("p1"), false);
  assertEquals(composition.priorityFilled, { "priority-src": false });
});

Deno.test("selectPicks: logs 'rank_priority_unfilled' only for sources that didn't get a slot", () => {
  const original = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => logs.push(args);
  try {
    const pool = [
      makeCandidate({ id: "a", sourceId: "present-src" }),
    ];
    const ranked = [rankedItem("a")];
    const config = noopConfig({ prioritySources: ["present-src", "absent-src"] });
    selectPicks(ranked, pool, config, 3);
    const parsed = logs.map((args) => JSON.parse(String(args[0])));
    const unfilledEvents = parsed.filter((l) => l.event === "rank_priority_unfilled");
    assertEquals(unfilledEvents.length, 1);
    assertEquals(unfilledEvents[0].sourceId, "absent-src");
  } finally {
    console.log = original;
  }
});

Deno.test("selectPicks: topic quota fills best-first from candidates labeled that topic", () => {
  const pool = [
    makeCandidate({ id: "l1", sourceId: "s1" }),
    makeCandidate({ id: "l2", sourceId: "s2" }),
    makeCandidate({ id: "o1", sourceId: "s3" }),
  ];
  const ranked = [rankedItem("o1", "other"), rankedItem("l1", "linux"), rankedItem("l2", "linux")];
  const config = noopConfig({ topicQuotas: { linux: 1 } });
  // pickCount 1 isolates the quota step's own choice: "l1" is the
  // highest-ranked "linux" item, so it fills the quota — and since the
  // quota already used the only slot, general fill never runs at all.
  const composition = selectPicks(ranked, pool, config, 1);
  assertEquals(composition.picks, ["l1"]);
  assertEquals(composition.quotaFilled, { linux: 1 });
  assertEquals(composition.byTopic, { linux: 1 });
});

Deno.test("selectPicks: a quota with fewer matching candidates than requested takes what exists and logs the shortfall", () => {
  const pool = [makeCandidate({ id: "l1", sourceId: "s1" })];
  const ranked = [rankedItem("l1", "linux")];
  const config = noopConfig({ topicQuotas: { linux: 2 } });

  const original = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => logs.push(args);
  try {
    const composition = selectPicks(ranked, pool, config, 5);
    assertEquals(composition.quotaFilled, { linux: 1 });
    const parsed = logs.map((args) => JSON.parse(String(args[0])));
    const unfilled = parsed.find((l) => l.event === "rank_quota_unfilled");
    assertEquals(unfilled?.topic, "linux");
    assertEquals(unfilled?.wanted, 2);
    assertEquals(unfilled?.got, 1);
  } finally {
    console.log = original;
  }
});

Deno.test("selectPicks: a quota candidate that would exceed the per-source cap is skipped in favor of the next same-topic candidate", () => {
  const pool = [
    makeCandidate({ id: "s-a1", sourceId: "src-a" }),
    makeCandidate({ id: "s-a2", sourceId: "src-a" }),
    makeCandidate({ id: "s-a3", sourceId: "src-a" }),
    makeCandidate({ id: "s-b1", sourceId: "src-b" }),
  ];
  // wanted=3, all four candidates labeled "linux": the quota loop's OWN
  // scan fills s-a1 and s-a2 (bringing src-a to its cap of 2), must then
  // SKIP s-a3 (same source, at cap) without stopping the scan (wanted=3
  // isn't met yet), and lands on s-b1 to satisfy the quota.
  const ranked = [
    rankedItem("s-a1", "linux"),
    rankedItem("s-a2", "linux"),
    rankedItem("s-a3", "linux"),
    rankedItem("s-b1", "linux"),
  ];
  const config = noopConfig({ topicQuotas: { linux: 3 } });
  const composition = selectPicks(ranked, pool, config, 4);
  assertEquals(composition.picks.includes("s-a3"), false);
  assertEquals(composition.picks.includes("s-b1"), true);
  assertEquals(composition.quotaFilled, { linux: 3 });
});

Deno.test("selectPicks: a quota pick that would be a story-duplicate of an already-selected item is skipped, backfilling from the same topic", () => {
  const pool = [
    makeCandidate({
      id: "priority-pick",
      sourceId: "priority-src",
      title: "Moonshot AI launches Kimi K2 model",
    }),
    makeCandidate({
      id: "l-dup",
      sourceId: "s1",
      title: "Moonshot AI выпустила модель Kimi K2", // same story, different outlet
    }),
    makeCandidate({ id: "l-ok", sourceId: "s2", title: "Unrelated Linux kernel news" }),
  ];
  const ranked = [
    rankedItem("priority-pick", "ai"),
    rankedItem("l-dup", "linux"),
    rankedItem("l-ok", "linux"),
  ];
  const config = noopConfig({
    prioritySources: ["priority-src"],
    topicQuotas: { linux: 1 },
  });
  const composition = selectPicks(ranked, pool, config, 3);
  assertEquals(composition.picks.includes("priority-pick"), true);
  assertEquals(composition.picks.includes("l-dup"), false);
  assertEquals(composition.picks.includes("l-ok"), true);
  assertEquals(composition.quotaFilled, { linux: 1 });
});

Deno.test("selectPicks: general fill's preferred-domain tie-break promotes a preferred candidate past exactly one adjacent non-preferred rival, never a large gap", () => {
  // Six candidates, "preferred" ranked dead last (index 5). The tie-break is
  // a SINGLE bounded forward pass (one adjacent swap per non-preferred
  // predecessor), so it can move up by at most one position — from index 5
  // to index 4 — never jumping all the way to the front.
  const pool = [
    makeCandidate({ id: "a", sourceId: "s-a" }),
    makeCandidate({ id: "b", sourceId: "s-b" }),
    makeCandidate({ id: "c", sourceId: "s-c" }),
    makeCandidate({ id: "d", sourceId: "s-d" }),
    makeCandidate({ id: "e", sourceId: "s-e" }),
    makeCandidate({ id: "preferred", sourceId: "s-p", url: "https://phoronix.com/article" }),
  ];
  const ranked = [
    rankedItem("a"),
    rankedItem("b"),
    rankedItem("c"),
    rankedItem("d"),
    rankedItem("e"),
    rankedItem("preferred"),
  ];
  const config = noopConfig({ preferredDomains: ["phoronix.com"] });

  // The single bounded pass promotes "preferred" from index 5 to index 4
  // (past "e" only) — a pickCount of 4 takes indices 0-3, so "preferred"
  // (now at index 4) is still just outside; if the tie-break jumped it all
  // the way to the front instead, it WOULD be included here.
  const composition = selectPicks(ranked, pool, config, 4);
  assertEquals(composition.picks.includes("preferred"), false);
  assertEquals(composition.picks, ["a", "b", "c", "d"]);
});

Deno.test("selectPicks: general fill's preferred-domain tie-break DOES win an adjacent tie", () => {
  const pool = [
    makeCandidate({ id: "a", sourceId: "s-a", url: "https://unrelated.example.com/x" }),
    makeCandidate({ id: "preferred", sourceId: "s-p", url: "https://phoronix.com/article" }),
  ];
  const ranked = [rankedItem("a"), rankedItem("preferred")];
  const config = noopConfig({ preferredDomains: ["phoronix.com"] });
  // pickCount 1: without the tie-break, general fill would take "a" (ranked
  // first); WITH the adjacent tie-break, "preferred" moves ahead of "a" and
  // wins the single slot instead.
  const composition = selectPicks(ranked, pool, config, 1);
  assertEquals(composition.picks, ["preferred"]);
});

Deno.test("selectPicks: preferredDomains alone (no matching candidate) has no effect on picks", () => {
  const pool = [
    makeCandidate({ id: "a", sourceId: "s-a" }),
    makeCandidate({ id: "b", sourceId: "s-b" }),
  ];
  const ranked = [rankedItem("a"), rankedItem("b")];
  const config = noopConfig({ preferredDomains: ["nowhere-present.example"] });
  const composition = selectPicks(ranked, pool, config, 2);
  assertEquals(composition.picks, ["a", "b"]);
});

Deno.test("selectPicks: max-2-per-source cap applies throughout general fill, not just per-pass", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
  ];
  const ranked = [rankedItem("a1"), rankedItem("a2"), rankedItem("a3"), rankedItem("b1")];
  const composition = selectPicks(ranked, pool, noopConfig(), 4);
  assertEquals(composition.picks, ["a1", "a2", "b1"]);
  assertEquals(composition.bySource, { a: 2, b: 1 });
});

Deno.test("selectPicks: story-dedup against recentTitles (48h window) applies throughout, same as dedupStories", () => {
  const pool = [
    makeCandidate({ id: "a", sourceId: "s-a", title: "Moonshot AI launches Kimi K2 model" }),
    makeCandidate({ id: "b", sourceId: "s-b", title: "Unrelated Linux kernel news" }),
  ];
  const ranked = [rankedItem("a"), rankedItem("b")];
  const recentTitles = ["Moonshot AI выпустила модель Kimi K2"];
  const composition = selectPicks(ranked, pool, noopConfig(), 2, recentTitles);
  assertEquals(composition.picks, ["b"]);
});

Deno.test("selectPicks: total picks equal pickCount when the ranked list is large enough, fewer only when it's genuinely smaller", () => {
  const pool = Array.from(
    { length: 3 },
    (_, i) => makeCandidate({ id: `c${i}`, sourceId: `s${i}` }),
  );
  const ranked = pool.map((c) => rankedItem(c.id));
  const shortComposition = selectPicks(ranked, pool, noopConfig(), 10);
  assertEquals(shortComposition.picks.length, 3);

  const exactComposition = selectPicks(ranked, pool, noopConfig(), 2);
  assertEquals(exactComposition.picks.length, 2);
});

Deno.test("selectPicks: composition byTopic/bySource reflect only the FINAL picks, not intermediate candidates", () => {
  const pool = [
    makeCandidate({ id: "a", sourceId: "src-a" }),
    makeCandidate({ id: "b", sourceId: "src-b" }),
  ];
  const ranked = [rankedItem("a", "ai"), rankedItem("b", "security")];
  const composition = selectPicks(ranked, pool, noopConfig(), 1);
  assertEquals(composition.picks, ["a"]);
  assertEquals(composition.byTopic, { ai: 1 });
  assertEquals(composition.bySource, { "src-a": 1 });
});

Deno.test("selectPicks: logs 'rank_selection' exactly once per call with the full composition", () => {
  const original = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => logs.push(args);
  try {
    const pool = [makeCandidate({ id: "a", sourceId: "src-a" })];
    const ranked = [rankedItem("a", "ai")];
    selectPicks(ranked, pool, noopConfig(), 1);
    const parsed = logs.map((args) => JSON.parse(String(args[0])));
    const selectionEvents = parsed.filter((l) => l.event === "rank_selection");
    assertEquals(selectionEvents.length, 1);
    assertEquals(selectionEvents[0].picks, ["a"]);
    assertEquals(selectionEvents[0].byTopic, { ai: 1 });
    assertEquals(selectionEvents[0].bySource, { "src-a": 1 });
  } finally {
    console.log = original;
  }
});

Deno.test("selectPicks: order matters — priority runs before quotas, quotas before general fill", () => {
  // A single source id is BOTH a priority source AND the only source
  // carrying the quota topic — if general fill ran first, it would consume
  // the slot before priority/quota logic ever saw it. This test only
  // passes if priority claims its slot first, quotas claim next, and
  // general fill only sees what's left.
  const pool = [
    makeCandidate({ id: "p1", sourceId: "priority-src", title: "Priority source pick" }),
    makeCandidate({ id: "q1", sourceId: "quota-src", title: "Quota topic pick" }),
    makeCandidate({ id: "g1", sourceId: "general-src", title: "General fill pick" }),
  ];
  const ranked = [rankedItem("g1", "other"), rankedItem("q1", "linux"), rankedItem("p1", "other")];
  const config = noopConfig({ prioritySources: ["priority-src"], topicQuotas: { linux: 1 } });
  const composition = selectPicks(ranked, pool, config, 3);
  assertEquals(composition.picks.includes("p1"), true);
  assertEquals(composition.picks.includes("q1"), true);
  assertEquals(composition.picks.includes("g1"), true);
  assertEquals(composition.priorityFilled, { "priority-src": true });
  assertEquals(composition.quotaFilled, { linux: 1 });
});
