export type NormalizeUrlResult =
  | { ok: true; origin: string }
  | { ok: false; error: string };

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" ||
    hostname.endsWith(".localhost");
}

// Validates a user-entered server URL and normalizes it down to just the
// origin (scheme + host + port) — path/query/hash are dropped since the
// extension always talks to a fixed set of API paths under that origin.
// https is required except for localhost, so a forker testing against
// `wrangler dev` isn't forced onto TLS.
export function normalizeServerOrigin(input: string): NormalizeUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Server URL is required" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "URL must use http or https" };
  }
  if (url.protocol === "http:" && !isLocalhost(url.hostname)) {
    return { ok: false, error: "https is required (http is only allowed for localhost)" };
  }

  return { ok: true, origin: `${url.protocol}//${url.host}` };
}
