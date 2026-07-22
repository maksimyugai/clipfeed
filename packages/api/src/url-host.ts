// Shared hostname normalization — lowercase, "www." stripped — used
// wherever a candidate/article URL needs to be compared against a domain
// list (blocklist, autoblock, preferred, thin-host). Extracted from
// agent-pool.ts's previously-local helper of the same shape so the new
// curation modules (Task 33) don't reimplement it slightly differently.
export function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
