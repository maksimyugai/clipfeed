import "./env.d.ts";
import { assertEquals } from "@std/assert";
import {
  DEFAULT_AGENT_DAILY_PICKS,
  enforceRankingDiversity,
  fallbackPicks,
  parseAgentDailyPicks,
  rankCandidates,
} from "./ranking.ts";
import type { Candidate } from "./agent-types.ts";

function makeCandidate(overrides: Partial<Candidate>): Candidate {
  return {
    id: "c",
    sourceId: "src",
    discoverySource: "example.com",
    title: "Title",
    url: "https://example.com/x",
    snippet: "snippet",
    publishedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
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
  // Task 18: the fallback path must still spread across sources even at the
  // new, larger default pick count — not silently collapse to "whatever's
  // newest regardless of source" the way a naive slice(0, N) would.
  const candidates = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
    makeCandidate({ id: "b2", sourceId: "b" }),
    makeCandidate({ id: "c1", sourceId: "c" }),
    makeCandidate({ id: "c2", sourceId: "c" }),
  ];
  const picks = fallbackPicks(candidates, 10);
  // Only 6 candidates exist across 3 sources — all of them get picked, but
  // every source is represented at least once (the one-per-source first
  // pass guarantees this before any backfill happens).
  assertEquals(picks.length, 6);
  const sourceIds = new Set(candidates.filter((c) => picks.includes(c.id)).map((c) => c.sourceId));
  assertEquals(sourceIds.size, 3);
  assertEquals(sourceIds.size >= Math.min(3, sourceIds.size), true);
});

Deno.test("fallbackPicks: empty input yields no picks", () => {
  assertEquals(fallbackPicks([]), []);
});

Deno.test("rankCandidates: empty candidate pool short-circuits to no picks, no LLM call", async () => {
  const env = makeEnv();
  const picks = await rankCandidates(env, "interests", []);
  assertEquals(picks, []);
});

Deno.test("rankCandidates: valid plain JSON array of ids is used as-is", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(anthropicTextResponse(JSON.stringify(["a", "c"])))) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [
      makeCandidate({ id: "a" }),
      makeCandidate({ id: "b" }),
      makeCandidate({ id: "c" }),
    ];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(picks, ["a", "c"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: fenced JSON is unwrapped", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(anthropicTextResponse('```json\n["b"]\n```'))) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
    const picks = await rankCandidates(env, "interests", candidates);
    assertEquals(picks, ["b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rankCandidates: ids not in the pool are filtered out", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      anthropicTextResponse(JSON.stringify(["a", "not-real", "b"])),
    )) as typeof fetch;
  try {
    const env = makeEnv();
    const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
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
    return Promise.resolve(anthropicTextResponse(JSON.stringify(["nonexistent"])));
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
  globalThis.fetch =
    (() => Promise.resolve(anthropicTextResponse(JSON.stringify(["a"])))) as typeof fetch;
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
        return Promise.resolve({ response: JSON.stringify(["a"]) });
      },
    },
  });
  const picks = await rankCandidates(env, "interests", [makeCandidate({ id: "a" })]);
  assertEquals(picks, ["a"]);
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

// --- rankCandidates: the rendered prompt states N and the hard rules ---

Deno.test("rankCandidates: the rendered system prompt states the pick count and all three hard rules", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSystem = "";
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { system: string };
    capturedSystem = body.system;
    return Promise.resolve(anthropicTextResponse(JSON.stringify(["a"])));
  }) as typeof fetch;
  try {
    const env = makeEnv({ AGENT_DAILY_PICKS: "7" });
    await rankCandidates(env, "interests", [makeCandidate({ id: "a" })]);
    assertEquals(capturedSystem.includes("Pick the 7 best items"), true);
    assertEquals(capturedSystem.includes("at most 2 items per source"), true);
    assertEquals(
      capturedSystem.includes("cover at least 3 distinct topic areas from the interest list"),
      true,
    );
    assertEquals(
      capturedSystem.includes("prefer substantive reporting over link-posts and speculation"),
      true,
    );
    assertEquals(capturedSystem.includes("JSON array of the 7 best item ids"), true);
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
    return Promise.resolve(anthropicTextResponse(JSON.stringify(["a"])));
  }) as typeof fetch;
  try {
    const env = makeEnv({ AGENT_DAILY_PICKS: "not-a-number" });
    await rankCandidates(env, "interests", [makeCandidate({ id: "a" })]);
    assertEquals(capturedSystem.includes(`Pick the ${DEFAULT_AGENT_DAILY_PICKS} best items`), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- enforceRankingDiversity: the fixup table (over-representation, backfill order, exhausted pool) ---

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
  // Model ranked all 3 "a" items ahead of "b1" — a3 must be dropped (cap 2
  // per source) and the freed slot backfilled from b1, the next pool
  // candidate not already picked.
  const picks = enforceRankingDiversity(["a1", "a2", "a3"], pool, 3);
  assertEquals(picks, ["a1", "a2", "b1"]);
});

Deno.test("enforceRankingDiversity: backfill order follows the pool's own order (newest-first), not the model's ranked order", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "c1", sourceId: "c" }), // newest non-"a" pool candidate
    makeCandidate({ id: "b1", sourceId: "b" }), // older
  ];
  // Model's ranked list drops both "a3" and never mentions "b1"/"c1" at all
  // — backfill must still reach into the pool (not just the model's list)
  // and prefer c1 over b1 because the pool itself is newest-first.
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
  const picks = enforceRankingDiversity(
    ["a1", "a2", "a3", "b1", "b2", "b3"],
    pool,
    6,
  );
  // a3 and b3 both dropped (2 slots reopened), backfilled from the only
  // remaining pool candidate (c1) and then exhausted (see next test for the
  // fully-exhausted case) — only 1 of the 2 reopened slots can be filled.
  assertEquals(picks, ["a1", "a2", "b1", "b2", "c1"]);
});

Deno.test("enforceRankingDiversity: exhausted pool — fewer than pickCount is returned rather than violating the cap", () => {
  const pool = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
    makeCandidate({ id: "a4", sourceId: "a" }),
  ];
  // Every candidate is from the same single source — the cap allows only 2,
  // so no amount of backfilling can reach pickCount 10; the pool is well
  // and truly exhausted after that.
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
