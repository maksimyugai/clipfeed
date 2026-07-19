import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { runSummarization, selectProviderMode } from "./pipeline.ts";

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
