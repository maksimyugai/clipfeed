// SSRF-safe outbound fetch for user-supplied article URLs. Blocks the
// obvious escape hatches (private/reserved IP literals, localhost, redirects
// into them) at the network boundary. Does not resolve DNS for ordinary
// hostnames before fetching (Workers has no synchronous DNS API), so it
// cannot catch DNS-rebinding to a private address behind a public domain —
// only IP-literal and localhost/.local/.internal hosts are enforced.

export class SsrfError extends Error {}

const PRIVATE_HOST_SUFFIXES = [".local", ".internal"];
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 5 * 1024 * 1024;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 0) return true; // 0.0.0.0/8 (includes 0.0.0.0)
  return false;
}

function parseIPv6(rawHost: string): number[] | null {
  let host = rawHost;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.split("%")[0]; // strip zone id
  if (!host.includes(":")) return null;

  const halves = host.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups = s.split(":").map((g) => parseInt(g, 16));
    return groups.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : groups;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tail = parseGroups(halves[1]);
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

function isPrivateIPv6(host: string): boolean {
  const groups = parseIPv6(host);
  if (!groups) return false;
  if (groups.slice(0, 7).every((n) => n === 0) && groups[7] === 1) return true; // ::1
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link local)
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isPrivateIPv4(host)) return true;
  if (host.includes(":") && isPrivateIPv6(host)) return true;
  return false;
}

export function assertSafeUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`unsupported protocol: ${url.protocol}`);
  }
  if (isPrivateHost(url.hostname)) {
    throw new SsrfError(`blocked host: ${url.hostname}`);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new SsrfError("response exceeded size cap");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

// Fetches a URL under the SSRF guard, following up to MAX_REDIRECTS hops
// while re-validating each Location header. Returns the response body text,
// capped at MAX_BYTES.
export async function safeFetchText(targetUrl: string): Promise<string> {
  let current = new URL(targetUrl);
  assertSafeUrl(current);

  let redirects = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        headers: BROWSER_HEADERS,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new SsrfError("redirect with no location");
      if (redirects >= MAX_REDIRECTS) throw new SsrfError("too many redirects");
      redirects += 1;
      current = new URL(location, current);
      assertSafeUrl(current);
      continue;
    }

    if (!response.ok) {
      throw new SsrfError(`upstream responded ${response.status}`);
    }

    return await readCapped(response, MAX_BYTES);
  }
}
