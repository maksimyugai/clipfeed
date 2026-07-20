import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { app } from "./index.ts";
import type { AppEnv } from "./access-middleware.ts";
import { turnstileGuard } from "./turnstile-middleware.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function makeEnv(overrides: Partial<Env> = {}): Env {
  const kv = new Map<string, string>();
  return {
    DB: new FakeD1(),
    CACHE: {
      get(key: string): Promise<string | null> {
        return Promise.resolve(kv.get(key) ?? null);
      },
      put(key: string, value: string): Promise<void> {
        kv.set(key, value);
        return Promise.resolve();
      },
      delete(key: string): Promise<void> {
        kv.delete(key);
        return Promise.resolve();
      },
    },
    ASSETS: { fetch: () => Promise.resolve(new Response("not used")) },
    AI: { run: () => Promise.reject(new Error("AI.run should not be called in these tests")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    DIGEST_HOUR_UTC: "6",
    PUBLIC_BASE_URL: "",
    TURNSTILE_SITE_KEY: "test-site-key",
    TURNSTILE_SECRET_KEY: "test-secret-key",
    ...overrides,
  };
}

function makeExecutionContext() {
  return {
    props: {},
    waitUntil(): void {},
    passThroughOnException(): void {},
  };
}

function stubSiteverify(
  responder: (body: URLSearchParams) => Response,
): { restore: () => void; calls: number } {
  const originalFetch = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    if (url === SITEVERIFY_URL) {
      state.calls++;
      const body = new URLSearchParams(await new Request(url, init).text());
      return responder(body);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    get calls() {
      return state.calls;
    },
  };
}

// turnstileGuard is currently unmounted from the real app (see index.ts) —
// mutations are always Access-authenticated under /api/admin/* now, so
// there's no anonymous-mutation surface left for it to guard. These tests
// exercise the middleware directly on a standalone test route, so its
// logic (including the Access-identity bypass) stays proven correct if the
// module is ever remounted on a public endpoint later.
function makeTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/test-mutation", turnstileGuard(), (c) => c.json({ ok: true }));
  return app;
}

// Simulates "some earlier middleware already established a verified Access
// identity" without doing a full JWT round-trip — that verification path
// is already exhaustively covered by access-middleware_test.ts.
function makeTestAppWithAccessSub(sub: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/test-mutation", (c, next) => {
    c.set("accessSub", sub);
    return next();
  });
  app.post("/test-mutation", turnstileGuard(), (c) => c.json({ ok: true }));
  return app;
}

function postMutation(testApp: Hono<AppEnv>, env: Env, headers: Record<string, string> = {}) {
  return testApp.request(
    "/test-mutation",
    { method: "POST", headers },
    env,
    makeExecutionContext(),
  );
}

Deno.test("turnstile: inactive mode (vars unset) does not require a token", async () => {
  const env = makeEnv({ TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" });
  const res = await postMutation(makeTestApp(), env);
  assertEquals(res.status, 200);
});

Deno.test("turnstile: active + valid token -> request proceeds", async () => {
  const stub = stubSiteverify(() => Response.json({ success: true }));
  try {
    const env = makeEnv();
    const res = await postMutation(makeTestApp(), env, { "cf-turnstile-response": "good-token" });
    assertEquals(res.status, 200);
    assertEquals(stub.calls, 1);
  } finally {
    stub.restore();
  }
});

Deno.test("turnstile: active + missing token -> 403 turnstile_required", async () => {
  const env = makeEnv();
  const res = await postMutation(makeTestApp(), env);
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, "turnstile_required");
});

Deno.test("turnstile: active + invalid token -> 403 turnstile_failed with codes propagated", async () => {
  const stub = stubSiteverify(() =>
    Response.json({ success: false, "error-codes": ["invalid-input-response"] })
  );
  try {
    const env = makeEnv();
    const res = await postMutation(makeTestApp(), env, { "cf-turnstile-response": "bad-token" });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error, "turnstile_failed");
    assertEquals(body.codes, ["invalid-input-response"]);
  } finally {
    stub.restore();
  }
});

Deno.test("turnstile: a verified Access identity bypasses Turnstile entirely (no siteverify call)", async () => {
  const stub = stubSiteverify(() => Response.json({ success: true }));
  try {
    const env = makeEnv();
    const res = await postMutation(makeTestAppWithAccessSub("user-123"), env);
    assertEquals(res.status, 200);
    assertEquals(stub.calls, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("turnstile: siteverify network failure -> 502 turnstile_unavailable (fail closed)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
  try {
    const env = makeEnv();
    const res = await postMutation(makeTestApp(), env, { "cf-turnstile-response": "some-token" });
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error, "turnstile_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GET /api/config: returns the site key when Turnstile is active", async () => {
  const env = makeEnv();
  const res = await app.request("/api/config", {}, env, makeExecutionContext());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.turnstile_site_key, "test-site-key");
});

Deno.test("GET /api/config: returns null when Turnstile is inactive", async () => {
  const env = makeEnv({ TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" });
  const res = await app.request("/api/config", {}, env, makeExecutionContext());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.turnstile_site_key, null);
});

Deno.test("GET /api/config: reachable with no identity at all, even when Access is configured", async () => {
  const env = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD });
  const res = await app.request("/api/config", {}, env, makeExecutionContext());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.turnstile_site_key, "string");
});
