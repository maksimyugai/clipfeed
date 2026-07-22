// Task 30 Part D: single source of truth for the header's GitHub icon link
// and the footer's license link (see Header.tsx, Footer.tsx). Backed by
// GET /api/config's `repo_url` field — [vars] REPO_URL defaults to "" (per
// the forkability policy, never an owner-specific default), so a fresh fork
// simply shows neither link until the owner sets their own.

const CONFIG_URL = "/api/config";

// The pure, directly-testable gating rule: only render the link for a
// well-formed https URL. Guards against a misconfigured REPO_URL (a bare
// domain, an http:// link, or accidental whitespace) ever producing a
// broken or insecure link in the header/footer.
export function isValidRepoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

let repoUrlCache: string | null | undefined; // undefined = not yet fetched

// Fetch-once-and-cache convention shared with loadTurnstileSiteKey/
// loadAgentSchedule — a fetch failure degrades to "no link shown", never
// blocks rendering the rest of the app.
export async function loadRepoUrl(): Promise<string | null> {
  if (repoUrlCache !== undefined) return repoUrlCache;
  try {
    const res = await fetch(CONFIG_URL);
    const body = await res.json() as { repo_url?: string };
    repoUrlCache = isValidRepoUrl(body.repo_url) ? body.repo_url! : null;
  } catch {
    repoUrlCache = null;
  }
  return repoUrlCache;
}
