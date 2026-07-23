import "../env.d.ts";
import type { Context, MiddlewareHandler } from "hono";
import { verifyAccessJwt } from "./access.ts";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    accessSub?: string;
    accessEmail?: string | null;
  };
};

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_COOKIE_NAME = "CF_Authorization";

interface AccessConfig {
  teamDomain: string;
  aud: string;
}

function readConfig(env: Env): AccessConfig | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!teamDomain || !aud) return null;
  return { teamDomain, aud };
}

function extractToken(c: Context<AppEnv>): string | null {
  const header = c.req.header(ACCESS_JWT_HEADER);
  if (header) return header;

  const cookieHeader = c.req.header("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === ACCESS_COOKIE_NAME) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

function logAuthFailure(reason: string, path: string): void {
  // Structured, reason-category only — never log token contents.
  console.warn(JSON.stringify({ event: "access_auth_failed", reason, path }));
}

// Gates every route it's mounted on behind a verified Cloudflare Access
// JWT — in this app, that's /api/admin/* only (see index.ts). Public reads
// (the feed, article details, static assets) never pass through this
// middleware at all.
//
// Unlike a typical "open until configured" bootstrap default, this FAILS
// CLOSED when ACCESS_TEAM_DOMAIN/ACCESS_AUD aren't both set: under the
// public-read/owner-write model, an unconfigured instance must never
// silently let mutation routes through open just because nobody's gotten
// around to setting up Access yet.
export function accessAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = readConfig(c.env);
    if (!config) {
      logAuthFailure("auth_not_configured", c.req.path);
      return c.json({ error: "auth_not_configured" }, 401);
    }

    const token = extractToken(c);
    if (!token) {
      logAuthFailure("missing_token", c.req.path);
      return c.json({ error: "unauthorized" }, 401);
    }

    const result = await verifyAccessJwt(token, config.teamDomain, config.aud, c.env.CACHE);
    if (!result.ok) {
      logAuthFailure(result.reason, c.req.path);
      return c.json({ error: "unauthorized" }, 401);
    }

    c.set("accessSub", result.claims.sub);
    c.set("accessEmail", result.claims.email ?? null);
    return next();
  };
}
