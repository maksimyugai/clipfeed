import "./env.d.ts";
import { assert, assertEquals } from "@std/assert";
import { runArticlePipeline, runSummarization, selectProviderMode } from "./pipeline.ts";

const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Title",
  tldr_ru: "Кратко.",
  tldr_en: "Short.",
  bullets_ru: ["Пункт 1"],
  bullets_en: ["Point 1"],
  tags: ["tag"],
  lang_original: "en",
};

function anthropicSuccessResponse(): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(VALID_SUMMARY) }] }),
    { status: 200 },
  );
}

function makeEnv(overrides: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: {
      run(): Promise<unknown> {
        throw new Error("AI.run should not be called for this branch");
      },
    },
    SUMMARY_MODEL: "test-anthropic-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    DIGEST_HOUR_UTC: "6",
    PUBLIC_BASE_URL: "",
    ...overrides,
  };
}

Deno.test("runSummarization: AI_GATEWAY_URL set -> gateway mode (even if ANTHROPIC_API_KEY is also set)", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl: string | undefined;
  globalThis.fetch = ((input: string | URL | Request) => {
    calledUrl = input.toString();
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  try {
    const env = makeEnv({
      AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
      CF_AIG_TOKEN: "gw-token",
      ANTHROPIC_API_KEY: "sk-direct-should-not-matter",
    });
    const result = await runSummarization(env, "Title", "Body text");
    assertEquals(result, VALID_SUMMARY);
    assertEquals(
      calledUrl,
      "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic/v1/messages",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runSummarization: no AI_GATEWAY_URL, ANTHROPIC_API_KEY set -> direct mode", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl: string | undefined;
  globalThis.fetch = ((input: string | URL | Request) => {
    calledUrl = input.toString();
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  try {
    const env = makeEnv({ ANTHROPIC_API_KEY: "sk-direct" });
    const result = await runSummarization(env, "Title", "Body text");
    assertEquals(result, VALID_SUMMARY);
    assertEquals(calledUrl, "https://api.anthropic.com/v1/messages");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runSummarization: neither secret set -> Workers AI mode (zero-config default)", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  let aiCalledWithModel: string | undefined;
  try {
    const env = makeEnv({
      AI: {
        run(model: string): Promise<unknown> {
          aiCalledWithModel = model;
          return Promise.resolve({ response: VALID_SUMMARY });
        },
      },
    });
    const result = await runSummarization(env, "Title", "Body text");
    assertEquals(result, VALID_SUMMARY);
    assertEquals(aiCalledWithModel, "test-workers-ai-model");
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- selectProviderMode: full truth table (3 vars, 8 combinations) ---
// A mode is only eligible when its config is COMPLETE — partial configs
// (URL without any credential, token without URL) must fall back to
// Workers AI rather than attempting a call that's guaranteed to 401.

const TRUTH_TABLE: Array<{
  label: string;
  aiGatewayUrl?: string;
  cfAigToken?: string;
  anthropicApiKey?: string;
  expected: "gateway" | "direct" | "workers-ai";
}> = [
  { label: "nothing set", expected: "workers-ai" },
  { label: "only ANTHROPIC_API_KEY", anthropicApiKey: "sk", expected: "direct" },
  {
    label: "only CF_AIG_TOKEN (no URL) — partial, falls back",
    cfAigToken: "tok",
    expected: "workers-ai",
  },
  {
    label:
      "CF_AIG_TOKEN + ANTHROPIC_API_KEY, no URL — gateway not eligible, key still usable direct",
    cfAigToken: "tok",
    anthropicApiKey: "sk",
    expected: "direct",
  },
  {
    label: "only AI_GATEWAY_URL (no credential) — partial, falls back",
    aiGatewayUrl: "https://gw.example/anthropic",
    expected: "workers-ai",
  },
  {
    label: "AI_GATEWAY_URL + ANTHROPIC_API_KEY (BYOK passthrough, no token) — complete",
    aiGatewayUrl: "https://gw.example/anthropic",
    anthropicApiKey: "sk",
    expected: "gateway",
  },
  {
    label: "AI_GATEWAY_URL + CF_AIG_TOKEN, no key — complete",
    aiGatewayUrl: "https://gw.example/anthropic",
    cfAigToken: "tok",
    expected: "gateway",
  },
  {
    label: "all three set — gateway takes priority",
    aiGatewayUrl: "https://gw.example/anthropic",
    cfAigToken: "tok",
    anthropicApiKey: "sk",
    expected: "gateway",
  },
];

for (const { label, expected, ...config } of TRUTH_TABLE) {
  Deno.test(`selectProviderMode: ${label}`, () => {
    assertEquals(selectProviderMode(config), expected);
  });
}

Deno.test("selectProviderMode: empty-string values are treated as unset", () => {
  assertEquals(
    selectProviderMode({ aiGatewayUrl: "", cfAigToken: "", anthropicApiKey: "" }),
    "workers-ai",
  );
  assertEquals(
    selectProviderMode({ aiGatewayUrl: "https://gw.example", cfAigToken: "", anthropicApiKey: "" }),
    "workers-ai",
  );
});

Deno.test("selectProviderMode: whitespace-only values are treated as unset", () => {
  assertEquals(
    selectProviderMode({ aiGatewayUrl: "   ", cfAigToken: "\t", anthropicApiKey: "\n " }),
    "workers-ai",
  );
});

Deno.test("selectProviderMode: whitespace-padded real values still count as set", () => {
  assertEquals(
    selectProviderMode({ aiGatewayUrl: "  https://gw.example  ", anthropicApiKey: " sk " }),
    "gateway",
  );
});

// --- End-to-end regressions for the bug this task fixes ---

Deno.test("runSummarization: AI_GATEWAY_URL set alone (no credential) falls back to Workers AI, never calls fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  let aiCalled = false;
  try {
    const env = makeEnv({
      AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct123/clipfeed/anthropic",
      AI: {
        run(): Promise<unknown> {
          aiCalled = true;
          return Promise.resolve({ response: VALID_SUMMARY });
        },
      },
    });
    const result = await runSummarization(env, "Title", "Body text");
    assertEquals(result, VALID_SUMMARY);
    assertEquals(aiCalled, true);
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runSummarization: CF_AIG_TOKEN set alone (no URL) falls back to Workers AI, never calls fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  let aiCalled = false;
  try {
    const env = makeEnv({
      CF_AIG_TOKEN: "gw-token",
      AI: {
        run(): Promise<unknown> {
          aiCalled = true;
          return Promise.resolve({ response: VALID_SUMMARY });
        },
      },
    });
    const result = await runSummarization(env, "Title", "Body text");
    assertEquals(result, VALID_SUMMARY);
    assertEquals(aiCalled, true);
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- runArticlePipeline: terminal-state guarantee + input capping ---

const ARTICLE_HTML = `<html><head><title>Example</title></head><body><article><h1>Example</h1>` +
  `<p>Hello world, this is the first paragraph of example content.</p>` +
  `<p>Here is a second paragraph with more detail to summarize.</p></article></body></html>`;

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

// A controllable D1 double: lets a test fail a specific write (identified by
// a substring of its SQL) while leaving every other write — crucially the
// catch block's own markArticleFailed() call — working normally.
class ControllableD1 {
  rows = new Map<string, Record<string, unknown>>();
  constructor(private failOn: (sql: string) => boolean = () => false) {}

  prepare(sql: string): D1PreparedStatement {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const makeStatement = (values: unknown[]): D1PreparedStatement => ({
      bind: (...newValues: unknown[]) => makeStatement(newValues),
      run: <T = unknown>() => {
        if (this.failOn(normalized)) {
          return Promise.reject(new Error("db write failed"));
        }
        const id = values[values.length - 1] as string;
        const row = this.rows.get(id) ?? {};
        if (normalized.includes("SET status = 'failed'")) {
          row.status = "failed";
          row.error = values[0];
        } else if (normalized.includes("SET full_text = ?")) {
          row.status = "ready";
        }
        this.rows.set(id, row);
        return Promise.resolve({ results: [] as T[], success: true, meta: {} });
      },
      all: <T = unknown>() => Promise.resolve({ results: [] as T[], success: true, meta: {} }),
      first: <T = unknown>() => Promise.resolve(null as T | null),
    });
    return makeStatement([]);
  }
}

function makePipelineEnv(overrides: Partial<Env> & { DB: D1Database }): Env {
  return {
    CACHE: new FakeKV() as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: {
      run(): Promise<unknown> {
        throw new Error("AI.run should not be called for this branch");
      },
    },
    SUMMARY_MODEL: "test-anthropic-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    DIGEST_HOUR_UTC: "6",
    PUBLIC_BASE_URL: "",
    ANTHROPIC_API_KEY: "sk-direct",
    ...overrides,
  };
}

Deno.test("runArticlePipeline: fetch stage throws -> row ends 'failed' with 'internal: fetch: ...'", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
  try {
    const db = new ControllableD1();
    const env = makePipelineEnv({ DB: db as unknown as D1Database });
    await runArticlePipeline(env, {
      id: "p-fetch",
      url: "https://example.com/article",
      requestTags: [],
    });
    const row = db.rows.get("p-fetch");
    assertEquals(row?.status, "failed");
    assert((row?.error as string).startsWith("internal: fetch: "));
    assert((row?.error as string).includes("network down"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runArticlePipeline: budget stage throws -> row ends 'failed' with 'internal: budget: ...'", async () => {
  const db = new ControllableD1();
  const env = makePipelineEnv({ DB: db as unknown as D1Database });
  env.CACHE = {
    get(): Promise<string | null> {
      return Promise.reject(new Error("kv unavailable"));
    },
    put(): Promise<void> {
      return Promise.resolve();
    },
  } as unknown as KVNamespace;

  await runArticlePipeline(env, {
    id: "p-budget",
    url: "https://example.com/article",
    html: ARTICLE_HTML,
    requestTags: [],
  });

  const row = db.rows.get("p-budget");
  assertEquals(row?.status, "failed");
  assert((row?.error as string).startsWith("internal: budget: "));
  assert((row?.error as string).includes("kv unavailable"));
});

Deno.test("runArticlePipeline: summarize stage throws -> row ends 'failed' with 'internal: summarize: ...'", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(new Response("server error", { status: 500 }))) as typeof fetch;
  try {
    const db = new ControllableD1();
    const env = makePipelineEnv({ DB: db as unknown as D1Database });
    await runArticlePipeline(env, {
      id: "p-summarize",
      url: "https://example.com/article",
      html: ARTICLE_HTML,
      requestTags: [],
    });
    const row = db.rows.get("p-summarize");
    assertEquals(row?.status, "failed");
    assert((row?.error as string).startsWith("internal: summarize: "));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runArticlePipeline: persist stage throws -> row ends 'failed' with 'internal: persist: ...'", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(anthropicSuccessResponse())) as typeof fetch;
  try {
    const db = new ControllableD1((sql) => sql.includes("SET full_text = ?"));
    const env = makePipelineEnv({ DB: db as unknown as D1Database });
    await runArticlePipeline(env, {
      id: "p-persist",
      url: "https://example.com/article",
      html: ARTICLE_HTML,
      requestTags: [],
    });
    const row = db.rows.get("p-persist");
    assertEquals(row?.status, "failed");
    assert((row?.error as string).startsWith("internal: persist: "));
    assert((row?.error as string).includes("db write failed"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runArticlePipeline: 'internal:' error is capped at 200 chars total", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("x".repeat(500)))) as typeof fetch;
  try {
    const db = new ControllableD1();
    const env = makePipelineEnv({ DB: db as unknown as D1Database });
    await runArticlePipeline(env, {
      id: "p-cap",
      url: "https://example.com/article",
      requestTags: [],
    });
    const row = db.rows.get("p-cap");
    assert((row?.error as string).length <= 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runArticlePipeline: daily-limit early return is NOT wrapped with 'internal:' (deliberate, not an exception)", async () => {
  const db = new ControllableD1();
  const env = makePipelineEnv({ DB: db as unknown as D1Database, DAILY_SUMMARY_LIMIT: 0 });
  await runArticlePipeline(env, {
    id: "p-limit",
    url: "https://example.com/article",
    html: ARTICLE_HTML,
    requestTags: [],
  });
  const row = db.rows.get("p-limit");
  assertEquals(row?.error, "daily-limit");
});

Deno.test("runArticlePipeline: workers-ai mode caps summarization input at 16k chars", async () => {
  const longText = "A".repeat(20_000);
  const html =
    `<html><head><title>Long</title></head><body><article><p>${longText}</p></article></body></html>`;

  let capturedContent = "";
  const db = new ControllableD1();
  const env = makePipelineEnv({
    DB: db as unknown as D1Database,
    ANTHROPIC_API_KEY: undefined,
    AI: {
      run(_model: string, input: unknown): Promise<unknown> {
        const messages = (input as { messages: { role: string; content: string }[] }).messages;
        capturedContent = messages[1].content;
        return Promise.resolve({ response: VALID_SUMMARY });
      },
    },
  });

  await runArticlePipeline(env, {
    id: "p-wai-cap",
    url: "https://example.com/x",
    html,
    requestTags: [],
  });

  assert(capturedContent.includes("A".repeat(16_000)));
  assert(!capturedContent.includes("A".repeat(16_001)));
  assertEquals(db.rows.get("p-wai-cap")?.status, "ready");
});

Deno.test("runArticlePipeline: gateway/direct mode does NOT apply the 16k workers-ai cap (keeps up to extract.ts's 30k)", async () => {
  const longText = "B".repeat(20_000);
  const html =
    `<html><head><title>Long</title></head><body><article><p>${longText}</p></article></body></html>`;

  let capturedBody = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return Promise.resolve(anthropicSuccessResponse());
  }) as typeof fetch;

  try {
    const db = new ControllableD1();
    const env = makePipelineEnv({
      DB: db as unknown as D1Database,
      ANTHROPIC_API_KEY: "sk-direct",
    });
    await runArticlePipeline(env, {
      id: "p-direct-nocap",
      url: "https://example.com/x",
      html,
      requestTags: [],
    });
    assert(capturedBody.includes("B".repeat(20_000)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
