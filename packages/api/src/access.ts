import "./env.d.ts";

const JWKS_TTL_SECONDS = 6 * 60 * 60;
const CLOCK_LEEWAY_SECONDS = 60;

// JOSE JWK entries carry extra fields (kid, use, alg) beyond WebCrypto's own
// JsonWebKey shape.
interface AccessJwk extends JsonWebKey {
  kid?: string;
}

export interface AccessClaims {
  sub: string;
  email?: string;
  aud: string[] | string;
  iss: string;
  exp: number;
  nbf?: number;
}

export type VerifyResult =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: string };

function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToString(b64url: string): string {
  return new TextDecoder().decode(base64UrlToBytes(b64url));
}

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const header = JSON.parse(base64UrlToString(headerB64)) as Record<string, unknown>;
    const payload = JSON.parse(base64UrlToString(payloadB64)) as Record<string, unknown>;
    const signature = base64UrlToBytes(signatureB64);
    return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature };
  } catch {
    return null;
  }
}

function jwksCacheKey(teamDomain: string): string {
  return `access:jwks:${teamDomain}`;
}

// Fetches the Access JWKS, using the KV cache unless forceRefresh is set
// (used once, on a kid miss, to pick up key rotation without waiting out
// the TTL).
async function getJwks(
  cache: KVNamespace,
  teamDomain: string,
  forceRefresh = false,
): Promise<AccessJwk[] | null> {
  const key = jwksCacheKey(teamDomain);

  if (!forceRefresh) {
    const cached = await cache.get(key);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { keys?: AccessJwk[] };
        if (Array.isArray(parsed.keys)) return parsed.keys;
      } catch {
        // fall through to a fresh fetch
      }
    }
  }

  let res: Response;
  try {
    res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = await res.text();
  let parsed: { keys?: AccessJwk[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.keys)) return null;

  await cache.put(key, body, { expirationTtl: JWKS_TTL_SECONDS });
  return parsed.keys;
}

function validateClaims(
  payload: Record<string, unknown>,
  teamDomain: string,
  aud: string,
  now: Date,
): string | null {
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const audClaim = payload.aud;
  const audList = Array.isArray(audClaim)
    ? audClaim
    : typeof audClaim === "string"
    ? [audClaim]
    : [];
  if (!audList.includes(aud)) return "aud_mismatch";

  if (payload.iss !== `https://${teamDomain}`) return "iss_mismatch";

  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp === null || nowSeconds > exp + CLOCK_LEEWAY_SECONDS) return "expired";

  const nbf = typeof payload.nbf === "number" ? payload.nbf : null;
  if (nbf !== null && nowSeconds < nbf - CLOCK_LEEWAY_SECONDS) return "not_yet_valid";

  return null;
}

// Verifies a Cloudflare Access JWT: RS256 signature against the team's
// JWKS (cached in KV, refetched once on an unknown kid for key rotation),
// then aud/iss/exp/nbf claims with a 60s clock-skew leeway.
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
  cache: KVNamespace,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const parsed = parseJwt(token);
  if (!parsed) return { ok: false, reason: "malformed_token" };
  const { header, payload, signingInput, signature } = parsed;

  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
  if (typeof header.kid !== "string") return { ok: false, reason: "malformed_token" };

  let jwks = await getJwks(cache, teamDomain);
  if (!jwks) return { ok: false, reason: "jwks_fetch_failed" };

  let jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwks = await getJwks(cache, teamDomain, true);
    if (!jwks) return { ok: false, reason: "jwks_fetch_failed" };
    jwk = jwks.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: "unknown_kid" };
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return { ok: false, reason: "invalid_key" };
  }

  let signatureValid: boolean;
  try {
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      new TextEncoder().encode(signingInput),
    );
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  if (!signatureValid) return { ok: false, reason: "invalid_signature" };

  const claimsError = validateClaims(payload, teamDomain, aud, now);
  if (claimsError) return { ok: false, reason: claimsError };

  return {
    ok: true,
    claims: {
      sub: typeof payload.sub === "string" ? payload.sub : "",
      email: typeof payload.email === "string" ? payload.email : undefined,
      aud: payload.aud as string[] | string,
      iss: String(payload.iss),
      exp: Number(payload.exp),
      nbf: typeof payload.nbf === "number" ? payload.nbf : undefined,
    },
  };
}
