import "./env.d.ts";
import type { Context, MiddlewareHandler } from "hono";
import { verifyAccessJwt } from "./access.ts";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    accessSub?: string;
    accessEmail?: string | null;
  };
};

const HEALTH_PATH = "/api/health";
const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_COOKIE_NAME = "CF_Authorization";

const UNAUTHORIZED_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Access required</title></head>
<body>
<h1>Access required</h1>
<p>This ClipFeed instance is protected by Cloudflare Access. Sign in through your
organization's Access login to continue.</p>
</body>
</html>
`;

// Logged once per isolate the first time auth is found disabled, so a
// fork/dev deployment without ACCESS_TEAM_DOMAIN + ACCESS_AUD doesn't spam
// logs on every request while still making the open state visible.
let warnedDisabled = false;

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

function unauthorizedResponse(c: Context<AppEnv>, isApi: boolean): Response {
  if (isApi) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.html(UNAUTHORIZED_HTML, 401);
}

// Verifies the Cloudflare Access JWT on every request except /api/health.
// No-ops (serves openly) when ACCESS_TEAM_DOMAIN/ACCESS_AUD aren't both
// set — the zero-config fork/dev bootstrap state.
export function accessAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.path === HEALTH_PATH) {
      return next();
    }

    const config = readConfig(c.env);
    if (!config) {
      if (!warnedDisabled) {
        console.warn("Access auth disabled — set ACCESS_TEAM_DOMAIN and ACCESS_AUD");
        warnedDisabled = true;
      }
      return next();
    }

    const isApi = c.req.path.startsWith("/api/");
    const token = extractToken(c);
    if (!token) {
      logAuthFailure("missing_token", c.req.path);
      return unauthorizedResponse(c, isApi);
    }

    const result = await verifyAccessJwt(token, config.teamDomain, config.aud, c.env.CACHE);
    if (!result.ok) {
      logAuthFailure(result.reason, c.req.path);
      return unauthorizedResponse(c, isApi);
    }

    c.set("accessSub", result.claims.sub);
    c.set("accessEmail", result.claims.email ?? null);
    return next();
  };
}
