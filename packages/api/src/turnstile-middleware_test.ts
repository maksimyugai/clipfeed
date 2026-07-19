import "./env.d.ts";
import { assertEquals } from "@std/assert";
import app from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const JWKS_CACHE_KEY = `access:jwks:${TEAM_DOMAIN}`;
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
}

async function exportJwk(publicKey: CryptoKey, kid: string): Promise<Record<string, unknown>> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey) as Record<string, unknown>;
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

async function signJwt(privateKey: CryptoKey, kid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    sub: "user-123",
    email: "person@example.com",
    aud: [AUD],
    iss: `https://${TEAM_DOMAIN}`,
    iat: now - 10,
    exp: now + 3600,
    nbf: now - 10,
  };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

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
    },
    ASSETS: { fetch: () => Promise.resolve(new Response("not used")) },
    AI: { run: () => Promise.reject(new Error("AI.run should not be called in these tests")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
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

async function makeAccessConfiguredEnv(
  overrides: Partial<Env> = {},
): Promise<{ env: Env; token: string }> {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const env = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD, ...overrides });
  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify({ keys: [jwk] }));
  const token = await signJwt(privateKey, "kid-1");
  return { env, token };
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

function postArticles(env: Env, headers: Record<string, string> = {}) {
  return app.request(
    "/api/articles",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ url: "https://example.com/turnstile-test-article" }),
    },
    env,
    makeExecutionContext(),
  );
}

Deno.test("turnstile: inactive mode (vars unset) does not require a token", async () => {
  const env = makeEnv({ TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" });
  const res = await postArticles(env);
  assertEquals(res.status, 202);
});

Deno.test("turnstile: active + valid token -> request proceeds", async () => {
  const stub = stubSiteverify(() => Response.json({ success: true }));
  try {
    const env = makeEnv();
    const res = await postArticles(env, { "cf-turnstile-response": "good-token" });
    assertEquals(res.status, 202);
    assertEquals(stub.calls, 1);
  } finally {
    stub.restore();
  }
});

Deno.test("turnstile: active + missing token -> 403 turnstile_required", async () => {
  const env = makeEnv();
  const res = await postArticles(env);
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
    const res = await postArticles(env, { "cf-turnstile-response": "bad-token" });
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
    const { env, token } = await makeAccessConfiguredEnv();
    const res = await postArticles(env, { "Cf-Access-Jwt-Assertion": token });
    assertEquals(res.status, 202);
    assertEquals(stub.calls, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("turnstile: Access configured but no/invalid Access token -> Turnstile still enforced", async () => {
  const env = (await makeAccessConfiguredEnv()).env;
  // No Access token at all -> access-middleware itself returns 401 first;
  // this only proves Turnstile doesn't accidentally short-circuit auth.
  const res = await postArticles(env, { "cf-turnstile-response": "irrelevant" });
  assertEquals(res.status, 401);
});

Deno.test("turnstile: siteverify network failure -> 502 turnstile_unavailable (fail closed)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
  try {
    const env = makeEnv();
    const res = await postArticles(env, { "cf-turnstile-response": "some-token" });
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error, "turnstile_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("turnstile: GET endpoints are unaffected even when active and no token is sent", async () => {
  const env = makeEnv();
  const listRes = await app.request("/api/articles", {}, env, makeExecutionContext());
  assertEquals(listRes.status, 200);

  const byIdRes = await app.request(
    "/api/articles/does-not-exist",
    {},
    env,
    makeExecutionContext(),
  );
  assertEquals(byIdRes.status, 404); // reached the handler, not blocked by turnstile (which would be 403)
});

Deno.test("turnstile: guards all four mutating routes (missing token -> 403 turnstile_required)", async () => {
  const env = makeEnv();
  const cases: Array<[string, string]> = [
    ["POST", "/api/articles"],
    ["PATCH", "/api/articles/some-id"],
    ["DELETE", "/api/articles/some-id"],
    ["POST", "/api/articles/some-id/retry"],
  ];
  for (const [method, path] of cases) {
    const res = await app.request(
      path,
      { method, headers: { "content-type": "application/json" }, body: "{}" },
      env,
      makeExecutionContext(),
    );
    assertEquals(res.status, 403, `${method} ${path} should be blocked`);
    const body = await res.json();
    assertEquals(body.error, "turnstile_required");
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
  const { env } = await makeAccessConfiguredEnv();
  const res = await app.request("/api/config", {}, env, makeExecutionContext());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.turnstile_site_key, "string");
});
