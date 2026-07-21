import "./env.d.ts";
import type { Candidate } from "./agent-types.ts";
import { findExistingUrls } from "./db.ts";
import { isLearnedThinHost } from "./thin-host-learning.ts";

const POOL_CAP = 160;
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Known thin/mirror hosts whose pages are link-posts, not articles — a
// Twitter/X mirror or shortener yields ~0 chars of real extractable text
// (Readability, and even the raw body-text fallback, mostly see nav/footer
// chrome), which used to reach the LLM and either produce a hallucinated
// summary or an opaque downstream failure (see pipeline.ts's
// MIN_EXTRACTED_TEXT_CHARS guard, which now also catches this class at the
// pipeline level — this filter just avoids spending a saved-article slot
// and a pipeline run on a candidate that's guaranteed to hit it). Most HN
// stories link to real articles, so this doesn't meaningfully shrink the
// pool — extend as new hosts show up repeatedly in practice, though most of
// that job is now automatic: see thin-host-learning.ts, consulted below
// alongside this static list.
const THIN_HOST_DENYLIST = new Set([
  "xcancel.com",
  "nitter.net",
  "twitter.com",
  "x.com",
  "t.co",
]);

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function isThinHost(cache: KVNamespace, url: string): Promise<boolean> {
  const host = hostname(url);
  if (host === null) return false;
  if (THIN_HOST_DENYLIST.has(host)) return true;
  return await isLearnedThinHost(cache, host);
}

function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/$/, "");
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return url;
  }
}

// pubDate-based where available (RSS/Atom items usually carry one); a
// candidate with no parseable date (HN items always have one, but a
// malformed feed item might not) is kept rather than dropped, since we
// can't judge its age either way.
function isWithinWindow(candidate: Candidate, now: Date): boolean {
  if (!candidate.publishedAt) return true;
  const t = new Date(candidate.publishedAt).getTime();
  if (Number.isNaN(t)) return true;
  return t >= now.getTime() - WINDOW_MS;
}

function publishedAtMs(candidate: Candidate): number {
  if (!candidate.publishedAt) return 0;
  const t = new Date(candidate.publishedAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// 24h filter -> newest-first sort -> pool-internal dedupe by canonicalized
// URL -> drop candidates already saved (exact url match against D1) -> cap.
// The DB check runs AFTER dedup/before the cap so the cap always applies to
// genuinely new candidates, not ones that'll be dropped anyway.
export async function buildCandidatePool(
  db: D1Database,
  cache: KVNamespace,
  candidates: Candidate[],
  now: Date = new Date(),
): Promise<Candidate[]> {
  const fresh = candidates.filter((c) => isWithinWindow(c, now));

  const thinChecks = await Promise.all(fresh.map((c) => isThinHost(cache, c.url)));
  const substantial = fresh.filter((c, i) => {
    if (thinChecks[i]) {
      console.log(JSON.stringify({ event: "candidate_dropped_thin_host", url: c.url }));
      return false;
    }
    return true;
  });
  substantial.sort((a, b) => publishedAtMs(b) - publishedAtMs(a));

  const seenCanonical = new Set<string>();
  const deduped: Candidate[] = [];
  for (const candidate of substantial) {
    const key = canonicalize(candidate.url);
    if (seenCanonical.has(key)) continue;
    seenCanonical.add(key);
    deduped.push(candidate);
  }

  const existingUrls = await findExistingUrls(db, deduped.map((c) => c.url));
  const newOnly = deduped.filter((c) => !existingUrls.has(c.url));

  return newOnly.slice(0, POOL_CAP);
}
