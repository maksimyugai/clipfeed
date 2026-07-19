import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { verifyAccessJwt } from "./access.ts";

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

async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  payload: Record<string, unknown>,
  alg = "RS256",
): Promise<string> {
  const header = { alg, typ: "JWT", kid };
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

function makeFakeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get(key: string): Promise<string | null> {
      return Promise.resolve(store.get(key) ?? null);
    },
    put(key: string, value: string): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function defaultPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    sub: "user-123",
    email: "person@example.com",
    aud: [AUD],
    iss: `https://${TEAM_DOMAIN}`,
    iat: now - 10,
    exp: now + 3600,
    nbf: now - 10,
    ...overrides,
  };
}

Deno.test("verifyAccessJwt: valid token succeeds and returns claims", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const token = await signJwt(privateKey, "kid-1", defaultPayload());

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.claims.sub, "user-123");
    assertEquals(result.claims.email, "person@example.com");
  }
});

Deno.test("verifyAccessJwt: service-token-style claims (no email) still succeed", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const payload = defaultPayload({ sub: "service-token-client-id" });
  delete payload.email;
  const token = await signJwt(privateKey, "kid-1", payload);

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.claims.sub, "service-token-client-id");
    assertEquals(result.claims.email, undefined);
  }
});

Deno.test("verifyAccessJwt: wrong aud fails", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const token = await signJwt(privateKey, "kid-1", defaultPayload({ aud: ["other-aud"] }));

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result, { ok: false, reason: "aud_mismatch" });
});

Deno.test("verifyAccessJwt: wrong iss fails", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const token = await signJwt(
    privateKey,
    "kid-1",
    defaultPayload({ iss: "https://evil.example.com" }),
  );

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result, { ok: false, reason: "iss_mismatch" });
});

Deno.test("verifyAccessJwt: expired token fails", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const token = await signJwt(privateKey, "kid-1", defaultPayload({ exp: nowSeconds() - 1000 }));

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result, { ok: false, reason: "expired" });
});

Deno.test("verifyAccessJwt: exp just within the 60s leeway still passes", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const token = await signJwt(privateKey, "kid-1", defaultPayload({ exp: nowSeconds() - 30 }));

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result.ok, true);
});

Deno.test("verifyAccessJwt: nbf in the future fails", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const token = await signJwt(privateKey, "kid-1", defaultPayload({ nbf: nowSeconds() + 1000 }));

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result, { ok: false, reason: "not_yet_valid" });
});

Deno.test("verifyAccessJwt: nbf just within the 60s leeway still passes", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const token = await signJwt(privateKey, "kid-1", defaultPayload({ nbf: nowSeconds() + 30 }));

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result.ok, true);
});

Deno.test("verifyAccessJwt: unknown kid triggers one JWKS refetch, then succeeds if found (rotation)", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-2");
  // Cache holds a stale JWKS that doesn't have kid-2 yet.
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [] }) });
  const token = await signJwt(privateKey, "kid-2", defaultPayload());

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
  }) as typeof fetch;

  try {
    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
    assertEquals(result.ok, true);
    assertEquals(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("verifyAccessJwt: kid still missing after refetch fails with unknown_kid", async () => {
  const { privateKey } = await generateKeyPair();
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [] }) });
  const token = await signJwt(privateKey, "kid-missing", defaultPayload());

  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() =>
      Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 }))) as typeof fetch;

  try {
    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
    assertEquals(result, { ok: false, reason: "unknown_kid" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("verifyAccessJwt: malformed token (wrong segment count) fails", async () => {
  const kv = makeFakeKv();
  const result = await verifyAccessJwt("not-a-jwt", TEAM_DOMAIN, AUD, kv);
  assertEquals(result, { ok: false, reason: "malformed_token" });
});

Deno.test("verifyAccessJwt: malformed token (invalid base64/JSON header) fails", async () => {
  const kv = makeFakeKv();
  const result = await verifyAccessJwt("not-base64!.also-not.signature", TEAM_DOMAIN, AUD, kv);
  assertEquals(result, { ok: false, reason: "malformed_token" });
});

Deno.test("verifyAccessJwt: tampered payload (invalid signature) fails", async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const jwk = await exportJwk(publicKey, "kid-1");
  const kv = makeFakeKv({ [JWKS_CACHE_KEY]: JSON.stringify({ keys: [jwk] }) });
  const token = await signJwt(privateKey, "kid-1", defaultPayload());
  const [headerB64, , sigB64] = token.split(".");
  const tamperedPayloadB64 = base64UrlEncodeString(
    JSON.stringify(defaultPayload({ sub: "attacker" })),
  );
  const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${sigB64}`;

  const result = await verifyAccessJwt(tamperedToken, TEAM_DOMAIN, AUD, kv);
  assertEquals(result, { ok: false, reason: "invalid_signature" });
});

Deno.test("verifyAccessJwt: unsupported alg (e.g. 'none') fails without attempting verification", async () => {
  const kv = makeFakeKv();
  const header = { alg: "none", typ: "JWT", kid: "kid-1" };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(defaultPayload()));
  const token = `${headerB64}.${payloadB64}.`;

  const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
  assertEquals(result, { ok: false, reason: "unsupported_alg" });
});

Deno.test("verifyAccessJwt: JWKS fetch failure (no cache, network error) fails distinctly", async () => {
  const { privateKey } = await generateKeyPair();
  const kv = makeFakeKv();
  const token = await signJwt(privateKey, "kid-1", defaultPayload());

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;

  try {
    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, kv);
    assertEquals(result, { ok: false, reason: "jwks_fetch_failed" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
