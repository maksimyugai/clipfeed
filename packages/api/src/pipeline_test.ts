import "./env.d.ts";
import { assert, assertEquals } from "@std/assert";
import { runArticlePipeline, runSummarization, selectProviderMode } from "./pipeline.ts";

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
    SUMMARY_BODY_TARGET_CHARS: "1200",
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

// Long enough that extraction clears pipeline.ts's MIN_EXTRACTED_TEXT_CHARS
// (300) guard — a short 1-2 sentence fixture used to be enough before that
// guard existed.
const ARTICLE_HTML = `<html><head><title>Example</title></head><body><article><h1>Example</h1>` +
  `<p>Hello world, this is the first paragraph of example content, with enough extra words to ` +
  `comfortably clear the minimum extraction length used by the pipeline's insufficient-text ` +
  `guard in tests.</p>` +
  `<p>Here is a second paragraph with more detail to summarize, padded a little further so the ` +
  `combined extracted text safely stays well above that threshold even after Readability trims ` +
  `whitespace.</p></article></body></html>`;

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
    SUMMARY_BODY_TARGET_CHARS: "1200",
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

// --- runArticlePipeline: insufficient-text guard (thin/link-post pages) ---

Deno.test("runArticlePipeline: extraction under 300 chars -> 'failed' with a clear reason, never calls the LLM", async () => {
  // Mimics a Twitter/X mirror (xcancel.com/nitter-style) page: nav chrome
  // plus a one-line footer, no real article body — the realistic shape of
  // the incident this guard exists for.
  const thinHtml = `<html><head><title>Some Post</title></head><body><nav>xcancel</nav>` +
    `<div id="app"></div>` +
    `<footer>xcancel is an alternative front-end for X.</footer></body></html>`;

  let llmCalled = false;
  const db = new ControllableD1();
  const env = makePipelineEnv({
    DB: db as unknown as D1Database,
    AI: {
      run(): Promise<unknown> {
        llmCalled = true;
        throw new Error("LLM should not be called for near-empty extraction");
      },
    },
  });

  await runArticlePipeline(env, {
    id: "p-thin",
    url: "https://xcancel.com/someuser/status/123",
    html: thinHtml,
    requestTags: [],
  });

  const row = db.rows.get("p-thin");
  assertEquals(row?.status, "failed");
  assert((row?.error as string).startsWith("extraction: insufficient text ("));
  assert((row?.error as string).endsWith(" chars)"));
  assertEquals((row?.error as string).length > 0, true);
  assertEquals(llmCalled, false);
});

// Regression: a fresh insufficient-text failure teaches the agent's
// learned thin-host blocklist, not just the healing job's backfill pass
// for pre-existing rows (see healing_test.ts for that half) — see
// thin-host-learning.ts's recordThinHostFailure, called right alongside
// markArticleFailed in this exact guard.
Deno.test("runArticlePipeline: extraction under 300 chars also records a thin-host learning hit", async () => {
  const thinHtml = `<html><head><title>Some Post</title></head><body><nav>xcancel</nav>` +
    `<div id="app"></div>` +
    `<footer>xcancel is an alternative front-end for X.</footer></body></html>`;

  const db = new ControllableD1();
  const cache = new FakeKV();
  const env = makePipelineEnv({
    DB: db as unknown as D1Database,
    CACHE: cache as unknown as KVNamespace,
  });

  await runArticlePipeline(env, {
    id: "p-thin-2",
    url: "https://mirror.example/someuser/status/123",
    html: thinHtml,
    requestTags: [],
  });

  assertEquals(await cache.get("thinhost:mirror.example"), "1");
});

Deno.test("runArticlePipeline: extraction exactly at 300 chars passes the guard (boundary)", async () => {
  const body = "A".repeat(300);
  const html =
    `<html><head><title>Exactly300</title></head><body><article><p>${body}</p></article></body></html>`;

  const db = new ControllableD1();
  const env = makePipelineEnv({
    DB: db as unknown as D1Database,
    ANTHROPIC_API_KEY: undefined,
    AI: {
      run(): Promise<unknown> {
        return Promise.resolve({ response: VALID_SUMMARY });
      },
    },
  });

  await runArticlePipeline(env, {
    id: "p-300",
    url: "https://example.com/x",
    html,
    requestTags: [],
  });
  assertEquals(db.rows.get("p-300")?.status, "ready");
});

Deno.test("runArticlePipeline: workers-ai mode caps summarization input at 24k chars", async () => {
  const longText = "A".repeat(30_000);
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

  assert(capturedContent.includes("A".repeat(24_000)));
  assert(!capturedContent.includes("A".repeat(24_001)));
  assertEquals(db.rows.get("p-wai-cap")?.status, "ready");
});

Deno.test("runArticlePipeline: gateway/direct mode does NOT apply the 24k workers-ai cap (keeps up to extract.ts's 30k)", async () => {
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
