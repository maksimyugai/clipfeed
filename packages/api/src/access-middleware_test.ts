import "./env.d.ts";
import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import app from "./index.ts";
import { FakeD1 } from "./testing/fake_d1.ts";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const JWKS_CACHE_KEY = `access:jwks:${TEAM_DOMAIN}`;

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
    ASSETS: { fetch: () => Promise.resolve(new Response("<html>spa shell</html>")) },
    AI: { run: () => Promise.reject(new Error("AI.run should not be called in these tests")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
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

async function makeConfiguredEnv(): Promise<{ env: Env; token: string }> {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const env = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD });
  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify({ keys: [jwk] }));
  const token = await signJwt(privateKey, "kid-1");
  return { env, token };
}

Deno.test("access middleware: disabled mode (vars unset) passes requests through with a one-time warning", async () => {
  const env = makeEnv();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: unknown) => {
    warnings.push(String(msg));
  };

  try {
    const res = await app.request("/api/articles", {}, env, makeExecutionContext());
    assertEquals(res.status, 200);
    assertStringIncludes(warnings.join("\n"), "Access auth disabled");
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("access middleware: /api/health stays open even when Access is configured and no token is sent", async () => {
  const { env } = await makeConfiguredEnv();
  const res = await app.request("/api/health", {}, env, makeExecutionContext());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
});

Deno.test("access middleware: configured + no token -> 401 JSON for /api/*", async () => {
  const { env } = await makeConfiguredEnv();
  const res = await app.request("/api/articles", {}, env, makeExecutionContext());
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("content-type")?.includes("application/json"), true);
  const body = await res.json();
  assertEquals(body.error, "unauthorized");
});

Deno.test("access middleware: configured + no token -> 401 HTML for non-API (SPA) requests", async () => {
  const { env } = await makeConfiguredEnv();
  const res = await app.request("/", {}, env, makeExecutionContext());
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("content-type")?.includes("text/html"), true);
  const body = await res.text();
  assertStringIncludes(body, "Access required");
});

Deno.test("access middleware: valid Cf-Access-Jwt-Assertion header authenticates the request", async () => {
  const { env, token } = await makeConfiguredEnv();
  const res = await app.request(
    "/api/articles",
    { headers: { "Cf-Access-Jwt-Assertion": token } },
    env,
    makeExecutionContext(),
  );
  assertEquals(res.status, 200);
});

Deno.test("access middleware: valid CF_Authorization cookie authenticates the request (fallback)", async () => {
  const { env, token } = await makeConfiguredEnv();
  const res = await app.request(
    "/api/articles",
    { headers: { Cookie: `other=1; CF_Authorization=${token}; another=2` } },
    env,
    makeExecutionContext(),
  );
  assertEquals(res.status, 200);
});

Deno.test("access middleware: header takes priority over cookie when both are present", async () => {
  const { env, token } = await makeConfiguredEnv();
  const res = await app.request(
    "/api/articles",
    {
      headers: {
        "Cf-Access-Jwt-Assertion": token,
        Cookie: "CF_Authorization=garbage-not-a-jwt",
      },
    },
    env,
    makeExecutionContext(),
  );
  assertEquals(res.status, 200);
});

Deno.test("access middleware: invalid token -> 401, matches the JSON/HTML split by path", async () => {
  const { env } = await makeConfiguredEnv();
  const apiRes = await app.request(
    "/api/articles",
    { headers: { "Cf-Access-Jwt-Assertion": "not-a-real-jwt" } },
    env,
    makeExecutionContext(),
  );
  assertEquals(apiRes.status, 401);

  const spaRes = await app.request(
    "/some/spa/route",
    { headers: { "Cf-Access-Jwt-Assertion": "not-a-real-jwt" } },
    env,
    makeExecutionContext(),
  );
  assertEquals(spaRes.status, 401);
  assertMatch(spaRes.headers.get("content-type") ?? "", /text\/html/);
});
