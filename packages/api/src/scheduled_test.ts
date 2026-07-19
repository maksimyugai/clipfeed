import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { handleScheduled, parseHour } from "./scheduled.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

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

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1() as unknown as D1Database,
    CACHE: new FakeKV() as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: { run: () => Promise.reject(new Error("AI.run should not be called")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    PUBLIC_BASE_URL: "",
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    DIGEST_HOUR_UTC: "6",
    ...overrides,
  };
}

// --- parseHour ---

Deno.test("parseHour: valid hours 0-23 parse correctly", () => {
  assertEquals(parseHour("0"), 0);
  assertEquals(parseHour("5"), 5);
  assertEquals(parseHour("23"), 23);
});

Deno.test("parseHour: empty string disables (null)", () => {
  assertEquals(parseHour(""), null);
  assertEquals(parseHour("   "), null);
});

Deno.test("parseHour: out-of-range or non-numeric values disable (null)", () => {
  assertEquals(parseHour("24"), null);
  assertEquals(parseHour("-1"), null);
  assertEquals(parseHour("not-a-number"), null);
  assertEquals(parseHour("5.5"), null);
});

Deno.test("parseHour: whitespace-padded valid values still parse", () => {
  assertEquals(parseHour(" 5 "), 5);
});

// --- handleScheduled ---

function stubFetch(handler: (url: string, init?: RequestInit) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(input.toString(), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("handleScheduled: on the agent hour, runs the agent job (fetches sources)", async () => {
  let fetchCalled = false;
  const restore = stubFetch(() => {
    fetchCalled = true;
    return new Response("nope", { status: 500 });
  });
  try {
    const env = makeEnv({ AGENT_HOUR_UTC: "5", DIGEST_HOUR_UTC: "" });
    const scheduledTime = new Date("2026-01-01T05:00:00Z").getTime();
    await handleScheduled(env, scheduledTime);
    assertEquals(fetchCalled, true);
  } finally {
    restore();
  }
});

Deno.test("handleScheduled: off the agent hour, does not run the agent job", async () => {
  let fetchCalled = false;
  const restore = stubFetch(() => {
    fetchCalled = true;
    return new Response("nope", { status: 500 });
  });
  try {
    const env = makeEnv({ AGENT_HOUR_UTC: "5", DIGEST_HOUR_UTC: "" });
    const scheduledTime = new Date("2026-01-01T04:00:00Z").getTime();
    await handleScheduled(env, scheduledTime);
    assertEquals(fetchCalled, false);
  } finally {
    restore();
  }
});

Deno.test("handleScheduled: an invalid/empty AGENT_HOUR_UTC disables the job entirely (never fires)", async () => {
  let fetchCalled = false;
  const restore = stubFetch(() => {
    fetchCalled = true;
    return new Response("nope", { status: 500 });
  });
  try {
    const env = makeEnv({ AGENT_HOUR_UTC: "", DIGEST_HOUR_UTC: "" });
    for (let hour = 0; hour < 24; hour++) {
      const scheduledTime = new Date(Date.UTC(2026, 0, 1, hour)).getTime();
      await handleScheduled(env, scheduledTime);
    }
    assertEquals(fetchCalled, false);
  } finally {
    restore();
  }
});

Deno.test("handleScheduled: digest hour sends the morning digest (Telegram configured, no ready articles -> silent, no throw)", async () => {
  const env = makeEnv({
    AGENT_HOUR_UTC: "",
    DIGEST_HOUR_UTC: "6",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
    TELEGRAM_OWNER_CHAT_ID: "12345",
  });
  const scheduledTime = new Date("2026-01-01T06:00:00Z").getTime();
  // No articles ready -> sendMorningDigest's buildAndSendDigest sends
  // nothing and returns; must not throw even without a fetch stub.
  await handleScheduled(env, scheduledTime);
});

Deno.test("handleScheduled: both jobs can fire on the same tick when set to the same hour", async () => {
  let fetchCalled = false;
  const restore = stubFetch(() => {
    fetchCalled = true;
    return new Response("nope", { status: 500 });
  });
  try {
    const env = makeEnv({ AGENT_HOUR_UTC: "5", DIGEST_HOUR_UTC: "5" });
    const scheduledTime = new Date("2026-01-01T05:00:00Z").getTime();
    await handleScheduled(env, scheduledTime);
    assertEquals(fetchCalled, true);
  } finally {
    restore();
  }
});
