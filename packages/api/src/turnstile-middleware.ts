import "./env.d.ts";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./access-middleware.ts";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_HEADER = "cf-turnstile-response";

export interface TurnstileConfig {
  siteKey: string;
  secretKey: string;
}

// Turnstile is active only when both are set (trimmed non-empty) —
// otherwise mutating endpoints serve exactly as before this feature.
export function readTurnstileConfig(env: Env): TurnstileConfig | null {
  const siteKey = (env.TURNSTILE_SITE_KEY ?? "").trim();
  const secretKey = (env.TURNSTILE_SECRET_KEY ?? "").trim();
  if (!siteKey || !secretKey) return null;
  return { siteKey, secretKey };
}

interface SiteverifyBody {
  success?: boolean;
  "error-codes"?: unknown;
}

type VerifyResult =
  | { kind: "ok" }
  | { kind: "failed"; codes: string[] }
  | { kind: "unavailable" };

async function verifyTurnstileToken(
  secretKey: string,
  token: string,
  remoteip: string | null,
): Promise<VerifyResult> {
  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteip) body.set("remoteip", remoteip);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return { kind: "unavailable" };
  }

  if (!response.ok) {
    return { kind: "unavailable" };
  }

  let parsed: SiteverifyBody;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "unavailable" };
  }

  if (parsed.success === true) {
    return { kind: "ok" };
  }
  const codes = Array.isArray(parsed["error-codes"])
    ? parsed["error-codes"].filter((c): c is string => typeof c === "string")
    : [];
  return { kind: "failed", codes };
}

// Bot protection for mutating endpoints, mounted after accessAuth() and
// applied only to the specific routes that spend budget or write data (see
// index.ts). No-ops when Turnstile isn't configured. A request that already
// carries a verified Access identity (accessSub, set by
// access-middleware.ts) bypasses this check entirely — Access answers "who
// are you", Turnstile answers "are you a browser with a human", and the
// extension / future bots authenticate via Access service tokens and
// physically cannot render a widget, so they must never be asked to.
export function turnstileGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = readTurnstileConfig(c.env);
    if (!config) return next();

    if (c.get("accessSub")) return next();

    const token = c.req.header(TOKEN_HEADER);
    if (!token) {
      return c.json({ error: "turnstile_required" }, 403);
    }

    const remoteip = c.req.header("CF-Connecting-IP") ?? null;
    const result = await verifyTurnstileToken(config.secretKey, token, remoteip);

    switch (result.kind) {
      case "ok":
        return next();
      case "failed":
        return c.json({ error: "turnstile_failed", codes: result.codes }, 403);
      case "unavailable":
        return c.json({ error: "turnstile_unavailable" }, 502);
    }
  };
}
