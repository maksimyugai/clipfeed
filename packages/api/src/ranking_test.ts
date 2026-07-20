import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { fallbackPicks, rankCandidates } from "./ranking.ts";
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
    DIGEST_HOUR_UTC: "6",
    ANTHROPIC_API_KEY: "sk-direct",
    ...overrides,
  };
}

function anthropicTextResponse(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

Deno.test("fallbackPicks: newest-first, one per distinct source, up to PICK_COUNT", () => {
  const candidates = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "b1", sourceId: "b" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "c1", sourceId: "c" }),
    makeCandidate({ id: "d1", sourceId: "d" }),
    makeCandidate({ id: "e1", sourceId: "e" }),
  ];
  const picks = fallbackPicks(candidates);
  assertEquals(picks, ["a1", "b1", "c1", "d1", "e1"]);
});

Deno.test("fallbackPicks: backfills from remaining candidates when fewer than PICK_COUNT distinct sources exist", () => {
  const candidates = [
    makeCandidate({ id: "a1", sourceId: "a" }),
    makeCandidate({ id: "a2", sourceId: "a" }),
    makeCandidate({ id: "a3", sourceId: "a" }),
  ];
  const picks = fallbackPicks(candidates);
  assertEquals(picks, ["a1", "a2", "a3"]);
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
