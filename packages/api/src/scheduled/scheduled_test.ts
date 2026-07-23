import "../env.d.ts";
import { assertEquals } from "@std/assert";
import { handleScheduled, parseHour } from "./scheduled.ts";
import { recordAgentRun } from "../agent/agent-run-tracker.ts";
import { FakeD1 } from "../testing/fake_d1.ts";

class FakeKV {
  store = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  // Task 33: runAgentJob (reached via the agent-hour dispatch) lists
  // autoblock:* entries once per run — always empty here, same convention
  // as agent_test.ts's own FakeKV.
  list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    return Promise.resolve({ keys: [], list_complete: true });
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
    QUEUE_WAIT_TIMEOUT_MIN: 30,
    PUBLIC_BASE_URL: "",
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    AGENT_DAILY_PICKS: "10",
    SUMMARY_BODY_TARGET_CHARS: "1200",
    // Outside the default publish window (4-18 UTC) and disabled — most
    // tests below aren't exercising the publish job, and its own dedicated
    // tests further down override these explicitly.
    PUBLISH_ENABLED: "false",
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
    const env = makeEnv({ AGENT_HOUR_UTC: "5" });
    const scheduledTime = new Date("2026-01-01T05:00:00Z").getTime();
    await handleScheduled(env, scheduledTime);
    assertEquals(fetchCalled, true);
  } finally {
    restore();
  }
});

Deno.test("handleScheduled: on the agent hour, skips the agent job when a run marker for today already exists (Task 36 Part B)", async () => {
  let fetchCalled = false;
  const restore = stubFetch(() => {
    fetchCalled = true;
    return new Response("nope", { status: 500 });
  });
  try {
    const env = makeEnv({ AGENT_HOUR_UTC: "5" });
    const scheduledTime = new Date("2026-01-01T05:00:00Z").getTime();
    // A manual run already happened earlier today (e.g. /scrape before the
    // scheduled hour) — the scheduled dispatch must not double it.
    await recordAgentRun(
      env.CACHE,
      { startedAt: "2026-01-01T02:00:00.000Z", picks: 8, trigger: "manual" },
      new Date(scheduledTime),
    );
    await handleScheduled(env, scheduledTime);
    assertEquals(fetchCalled, false);
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
    const env = makeEnv({ AGENT_HOUR_UTC: "5" });
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
    const env = makeEnv({ AGENT_HOUR_UTC: "" });
    for (let hour = 0; hour < 24; hour++) {
      const scheduledTime = new Date(Date.UTC(2026, 0, 1, hour)).getTime();
      await handleScheduled(env, scheduledTime);
    }
    assertEquals(fetchCalled, false);
  } finally {
    restore();
  }
});

// --- runPublishJob wiring (see telegram-publish_test.ts for the job's own
// window/enabled/candidate-selection unit tests — these just cover that
// handleScheduled actually calls it on every tick, agent hour or not) ---

Deno.test("handleScheduled: within the publish window, attempts to publish (Telegram configured, empty queue -> silent, no throw)", async () => {
  const env = makeEnv({
    AGENT_HOUR_UTC: "",
    PUBLISH_ENABLED: "true",
    PUBLISH_START_HOUR_UTC: "4",
    PUBLISH_END_HOUR_UTC: "18",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
    TELEGRAM_OWNER_CHAT_ID: "12345",
  });
  const scheduledTime = new Date("2026-01-01T06:00:00Z").getTime();
  // No 'ready' articles -> getNextPublishCandidate finds nothing, publish
  // is a silent no-op; must not throw even without a fetch stub.
  await handleScheduled(env, scheduledTime);
});

Deno.test("handleScheduled: publish job runs every tick regardless of the agent hour", async () => {
  let fetchCalled = false;
  const restore = stubFetch(() => {
    fetchCalled = true;
    return new Response("nope", { status: 500 });
  });
  try {
    const env = makeEnv({
      AGENT_HOUR_UTC: "5",
      PUBLISH_ENABLED: "true",
      PUBLISH_START_HOUR_UTC: "4",
      PUBLISH_END_HOUR_UTC: "18",
    });
    const scheduledTime = new Date("2026-01-01T05:00:00Z").getTime();
    await handleScheduled(env, scheduledTime);
    // Agent hour matched -> its sources.json fetch fired. Telegram isn't
    // configured in this env, so the publish job itself no-ops before
    // touching D1/fetch — this just proves the agent branch and the
    // always-run publish call coexist without one breaking the other.
    assertEquals(fetchCalled, true);
  } finally {
    restore();
  }
});
