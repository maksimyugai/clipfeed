// Pure domain-matching + precedence logic for Task 33's curation blocklist.
// No I/O here — callers (agent-pool.ts's pool filter, index.ts's admin
// endpoints/manual-add warning) fetch config/KV state and pass plain
// values in, keeping this module trivially unit-testable.

// Case-insensitive suffix match on hostname LABELS, not a raw string
// suffix: "example.com" blocks "example.com", "www.example.com" (already
// www-stripped by url-host.ts's hostname()) and "blog.example.com", but NOT
// "notexample.com" (no label boundary before "example") nor
// "example.com.evil.net" (the blocked domain isn't a suffix of this host's
// labels, just a substring).
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^www\./, "");
  return h === d || h.endsWith(`.${d}`);
}

export function domainMatchesAny(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => hostMatchesDomain(host, domain));
}

export type BlockLayer = "config" | "auto" | null;

export interface DomainPrecedence {
  blocked: boolean;
  layer: BlockLayer;
  preferred: boolean;
  conflict: boolean;
}

// Task 33 §5 precedence: blocklist.json (manual, absolute) beats KV
// autoblock (learned, absolute) beats "otherwise allowed". preferredDomains
// is ADVISORY ONLY — it never unblocks anything; a preferred-but-blocked
// domain is reported with conflict:true so the owner can decide
// deliberately (see health-report's curation section) rather than the
// whitelist silently overriding a block.
//
// autoBlockedDomains is a Set of exact hostnames (each autoblock entry is
// keyed to the one domain that actually failed — no suffix generalization,
// unlike the manual blocklist, which an owner may reasonably want to apply
// to a whole domain's subdomains at once).
export function resolveDomainPrecedence(
  host: string,
  blockedDomains: readonly string[],
  autoBlockedDomains: ReadonlySet<string>,
  preferredDomains: readonly string[],
): DomainPrecedence {
  const preferred = domainMatchesAny(host, preferredDomains);

  if (domainMatchesAny(host, blockedDomains)) {
    return { blocked: true, layer: "config", preferred, conflict: preferred };
  }
  if (autoBlockedDomains.has(host)) {
    return { blocked: true, layer: "auto", preferred, conflict: preferred };
  }
  return { blocked: false, layer: null, preferred, conflict: false };
}

// Normalizes free-form admin input (DELETE .../autoblock body) to a bare
// hostname: lowercase, strip a scheme, strip any path/query, strip "www.".
// Rejects anything that doesn't look like a real hostname (must contain at
// least one label separator and only valid hostname characters).
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeDomainInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0];
  value = value.replace(/^www\./, "");
  return HOSTNAME_RE.test(value) ? value : null;
}
