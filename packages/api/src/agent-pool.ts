import "./env.d.ts";
import type { Candidate } from "./agent-types.ts";
import {
  findExistingUrls,
  findRecentTitlesForDedup,
  RECENT_TITLES_DEDUP_WINDOW_MS,
  type RecentTitleRow,
} from "./db.ts";
import { isLearnedThinHost } from "./thin-host-learning.ts";
import { normalizeTitleExact, titleSimilarity } from "./title-similarity.ts";
import {
  buildEmbeddingText,
  cosineSimilarity,
  embedText,
  queryRelatedEmbeddings,
  type RelatedMatch,
} from "./embeddings.ts";
import { resolveDomainPrecedence } from "./domain-block.ts";
import { hostname } from "./url-host.ts";

const POOL_CAP = 160;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SEMANTIC_DEDUP_MAX_CANDIDATES = 40;
const MIN_SEMANTIC_DEDUP_MAX_CANDIDATES = 1;
const MAX_SEMANTIC_DEDUP_MAX_CANDIDATES = 160; // never exceeds POOL_CAP

// Empirically derived, not chosen a priori — a real same-story pair
// already in production (two independently-written Kimi K3/Qwen 3.8
// launch write-ups, one framed as "risk to Anthropic" and the other as
// "US vs. China AI race") measured a cosine score of 0.835 on this
// model/text-shape. 0.86 (this task's starting default) would have MISSED
// that exact pair; 0.82 gives a small margin below the measured score so
// it's actually caught, while staying well above where genuinely distinct
// stories are expected to sit. See README "Semantic dedup & search" for the
// full write-up and the honest best-effort caveat this one data point implies.
const DEFAULT_SEMANTIC_DEDUP_THRESHOLD = 0.82;

// [vars] strings, parsed defensively — same "missing/invalid -> logged
// warning + safe default" convention as ranking.ts's parseAgentDailyPicks.
export function parseSemanticDedupMaxCandidates(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_SEMANTIC_DEDUP_MAX_CANDIDATES;
  const n = Number(trimmed);
  if (
    !Number.isFinite(n) || n < MIN_SEMANTIC_DEDUP_MAX_CANDIDATES ||
    n > MAX_SEMANTIC_DEDUP_MAX_CANDIDATES
  ) {
    console.warn(JSON.stringify({
      event: "semantic_dedup_max_candidates_invalid",
      raw: trimmed,
      fallback: DEFAULT_SEMANTIC_DEDUP_MAX_CANDIDATES,
    }));
    return DEFAULT_SEMANTIC_DEDUP_MAX_CANDIDATES;
  }
  return Math.round(n);
}

export function parseSemanticDedupThreshold(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_SEMANTIC_DEDUP_THRESHOLD;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.warn(JSON.stringify({
      event: "semantic_dedup_threshold_invalid",
      raw: trimmed,
      fallback: DEFAULT_SEMANTIC_DEDUP_THRESHOLD,
    }));
    return DEFAULT_SEMANTIC_DEDUP_THRESHOLD;
  }
  return n;
}

// Multi-layer pre-scrape dedup (Task 24 Part B): reject duplicate/same-story
// candidates here, BEFORE ranking and summarization, so no ranking or
// summary tokens are spent on them — cheaper than the existing post-pick
// dedup in ranking.ts (dedupStories), which only runs on the handful of
// candidates the model already picked. TITLE_JACCARD_THRESHOLD is
// deliberately higher than ranking.ts's STORY_SIMILARITY_THRESHOLD (0.6 vs.
// 0.5) — this stage runs on the WHOLE pool (potentially 100+ candidates vs.
// a handful of picks), so a lower bar here would risk dropping genuinely
// distinct stories that merely share a topic's common vocabulary; the
// post-pick stage is a final backstop with a smaller, already-curated set
// where a slightly more aggressive threshold is safer.
const TITLE_JACCARD_THRESHOLD = 0.6;

// Same window the embed stage's dedup query filters on (see
// embeddings.ts's queryRelatedEmbeddings) — a same-story candidate is only
// worth catching against recently-saved articles; anything older is out of
// scope for "the daily agent double-saved today's story."
const SEMANTIC_DEDUP_WINDOW_MS = 72 * 60 * 60 * 1000;

export type PoolDedupReason = "url" | "title" | "jaccard" | "semantic";

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

// Some sources mark a subscriber-only/paywalled story directly in the
// title — the cheapest possible signal, no fetch needed to know the article
// text won't be reachable. LWN prefixes subscriber-only article titles with
// "[$]" in its RSS feed (see README "Sources"); extend this list if another
// source shows a similar convention in practice.
const PAYWALL_TITLE_MARKERS = ["[$]"];

function isPaywalledTitle(title: string): boolean {
  return PAYWALL_TITLE_MARKERS.some((marker) => title.startsWith(marker));
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

export interface PoolDedupDrop {
  candidateTitle: string;
  reason: PoolDedupReason;
  matchedId?: string;
  score?: number;
}

// Config for the semantic dedup layer (Task 27) — omitted entirely (or with
// `vectors` undefined) skips the layer, same graceful-degradation contract
// as the rest of the embeddings feature (see embeddings.ts): a fork that
// hasn't provisioned Vectorize still gets the 3 string-only layers above,
// nothing crashes, no extra Workers AI calls are made.
export interface SemanticDedupConfig {
  ai: Ai;
  vectors: VectorizeIndex | undefined;
  model: string;
  maxCandidates: number;
  threshold: number;
}

export interface BuildCandidatePoolResult {
  pool: Candidate[];
  dedupDrops: PoolDedupDrop[];
  blockedDropped: number;
}

// Task 33 §2/§5 — absolute domain block, checked BEFORE ranking (zero LLM
// spend) so a blocked candidate never even reaches the model. Combines the
// manual, git-committed blocklist.json with KV auto-learned blocks via the
// same precedence resolver the admin endpoints and manual-add warning use
// (see domain-block.ts) — `autoBlockedDomains` is fetched ONCE per agent
// run (see autoblock.ts's listAutoBlocks) rather than one KV get per
// candidate. Omitted entirely (or both fields empty) disables the layer —
// same graceful-degradation convention as the rest of this file.
export interface BlockConfig {
  blockedDomains: string[];
  autoBlockedDomains: ReadonlySet<string>;
}

function logPoolDedupDrop(drop: PoolDedupDrop): void {
  console.log(JSON.stringify({ event: "pool_dedup_dropped", ...drop }));
}

// Title-comparison entry used by both the exact-match index and the Jaccard
// scan below — `id` is present for a row that already exists in the DB (so
// a drop's log line/stats can name what it matched) and absent for a
// pool-internal candidate that hasn't been saved yet.
interface TitleEntry {
  title: string;
  id?: string;
}

// The embedding text for a not-yet-summarized candidate: only a title and
// an RSS/HN snippet are available at this stage (no tldr/bullets — those
// don't exist until after summarization) — reuses buildEmbeddingText's
// trim/join/truncate logic by shaping the candidate as the same
// { title, tldr, bullets } input, with bullets omitted.
function candidateEmbeddingText(candidate: Candidate): string {
  return buildEmbeddingText({
    title_en: candidate.title,
    tldr_en: candidate.snippet,
    bullets_en: null,
  });
}

// Last, most expensive dedup layer (Task 27): only runs on candidates that
// already survived the 3 string layers above, and only up to
// `maxCandidates` of them (newest-first, so a pool larger than the cap
// simply leaves its oldest survivors unchecked rather than erroring) — caps
// the Workers AI call cost of this stage. For each candidate: embed it, then
// (a) query Vectorize for same-story matches among recently-saved articles
// (72h window) and (b) compare against every other candidate's embedding
// already computed earlier in this same loop (pairwise within-batch dedup).
// Either match >= threshold drops the candidate. An embed call that itself
// fails (Workers AI error/timeout) fails OPEN — the candidate is kept
// un-checked rather than dropped, since a transient embedding failure is not
// evidence of duplication (same "auxiliary, never blocks the primary
// outcome" posture as the embed pipeline stage — see embeddings.ts).
async function applySemanticDedup(
  candidates: Candidate[],
  semantic: SemanticDedupConfig | undefined,
  now: Date,
  drops: PoolDedupDrop[],
): Promise<Candidate[]> {
  if (!semantic || !semantic.vectors) return candidates;
  const vectors = semantic.vectors;

  const toCheck = candidates.slice(0, semantic.maxCandidates);
  const rest = candidates.slice(semantic.maxCandidates);
  const sinceIso = new Date(now.getTime() - SEMANTIC_DEDUP_WINDOW_MS).toISOString();

  const survivors: Candidate[] = [];
  const keptVectors: number[][] = [];

  for (const candidate of toCheck) {
    const text = candidateEmbeddingText(candidate);
    if (!text) {
      survivors.push(candidate);
      continue;
    }

    let vector: number[];
    try {
      vector = await embedText(semantic.ai, semantic.model, text);
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pool_dedup_semantic_embed_failed",
        title: candidate.title,
        error: err instanceof Error ? err.message : String(err),
      }));
      survivors.push(candidate);
      continue;
    }

    let dbMatches: RelatedMatch[];
    try {
      dbMatches = await queryRelatedEmbeddings(vectors, vector, { topK: 3, sinceIso });
    } catch (err) {
      // A real query failure (not just "no matches") — e.g. `wrangler dev`,
      // where `env.VECTORS` is present but throws on every call (see
      // embeddings.ts's module doc comment). Same fail-open treatment as an
      // embed failure above: can't check against the DB, but the
      // within-batch pairwise check below still runs.
      console.warn(JSON.stringify({
        event: "pool_dedup_semantic_query_failed",
        title: candidate.title,
        error: err instanceof Error ? err.message : String(err),
      }));
      dbMatches = [];
    }
    const dbMatch = dbMatches.find((m) => m.score >= semantic.threshold);
    if (dbMatch) {
      const drop: PoolDedupDrop = {
        candidateTitle: candidate.title,
        reason: "semantic",
        matchedId: dbMatch.id,
        score: dbMatch.score,
      };
      drops.push(drop);
      logPoolDedupDrop(drop);
      continue;
    }

    let batchScore = -1;
    for (const kept of keptVectors) {
      batchScore = Math.max(batchScore, cosineSimilarity(vector, kept));
    }
    if (batchScore >= semantic.threshold) {
      const drop: PoolDedupDrop = {
        candidateTitle: candidate.title,
        reason: "semantic",
        score: batchScore,
      };
      drops.push(drop);
      logPoolDedupDrop(drop);
      continue;
    }

    keptVectors.push(vector);
    survivors.push(candidate);
  }

  return [...survivors, ...rest];
}

// 24h filter -> domain block (Task 33 §2/§5: blocklist.json + KV
// auto-learned blocks, zero LLM spend — a distinct policy layer from the
// thin-host filter below, which exists for extraction-quality reasons, not
// curation taste) -> paywall-title-marker filter -> thin-host filter ->
// newest-first sort -> pool-internal dedupe by canonicalized URL -> drop
// candidates already saved (exact url match against D1) -> normalized-title
// exact match -> title Jaccard similarity -> semantic (optional, Task 27)
// -> cap. Layers 2 and 3 (title/Jaccard) are checked
// against BOTH the 72h DB window and every pool candidate already kept in
// this same pass — the DB check runs first per candidate (a match there
// always means "drop the newer candidate", since the existing row was
// already fully processed) then the pool-internal check (a match there
// drops whichever candidate is later/lower-ranked in the already
// newest-first-sorted pool, keeping the first one seen — same "keep first,
// drop subsequent" convention the canonical-URL dedupe above already uses).
// All 4 layers log 'pool_dedup_dropped' and their counts are returned for
// the caller's run stats (see agent.ts).
//
// Honest limitation (see also README "Daily scraping agent" and "Semantic
// dedup & search"): layers 1-3 are cheap string-only matching; the semantic
// layer (when Vectorize is configured) catches paraphrased duplicates those
// miss, but is itself best-effort — a similarity threshold necessarily
// trades false-positives (distinct stories dropped) against misses
// (duplicates kept), and it only runs on the newest `maxCandidates`
// survivors per run.
export async function buildCandidatePool(
  db: D1Database,
  cache: KVNamespace,
  candidates: Candidate[],
  now: Date = new Date(),
  semantic?: SemanticDedupConfig,
  block?: BlockConfig,
): Promise<BuildCandidatePoolResult> {
  const fresh = candidates.filter((c) => isWithinWindow(c, now));

  const blockedDomains = block?.blockedDomains ?? [];
  const autoBlockedDomains = block?.autoBlockedDomains ?? new Set<string>();
  let blockedDropped = 0;
  const unblocked = fresh.filter((c) => {
    const host = hostname(c.url);
    if (!host) return true;
    const result = resolveDomainPrecedence(host, blockedDomains, autoBlockedDomains, []);
    if (result.blocked) {
      blockedDropped += 1;
      console.log(JSON.stringify({ event: "pool_dropped_blocked", host, layer: result.layer }));
      return false;
    }
    return true;
  });

  const unpaywalled = unblocked.filter((c) => {
    if (isPaywalledTitle(c.title)) {
      console.log(JSON.stringify({ event: "pool_dropped_paywalled", url: c.url }));
      return false;
    }
    return true;
  });

  const thinChecks = await Promise.all(unpaywalled.map((c) => isThinHost(cache, c.url)));
  const substantial = unpaywalled.filter((c, i) => {
    if (thinChecks[i]) {
      console.log(JSON.stringify({ event: "candidate_dropped_thin_host", url: c.url }));
      return false;
    }
    return true;
  });
  substantial.sort((a, b) => publishedAtMs(b) - publishedAtMs(a));

  const drops: PoolDedupDrop[] = [];

  const seenCanonical = new Set<string>();
  const deduped: Candidate[] = [];
  for (const candidate of substantial) {
    const key = canonicalize(candidate.url);
    if (seenCanonical.has(key)) {
      const drop: PoolDedupDrop = { candidateTitle: candidate.title, reason: "url" };
      drops.push(drop);
      logPoolDedupDrop(drop);
      continue;
    }
    seenCanonical.add(key);
    deduped.push(candidate);
  }

  const existingUrls = await findExistingUrls(db, deduped.map((c) => c.url));
  const urlFiltered: Candidate[] = [];
  for (const candidate of deduped) {
    if (existingUrls.has(candidate.url)) {
      const drop: PoolDedupDrop = { candidateTitle: candidate.title, reason: "url" };
      drops.push(drop);
      logPoolDedupDrop(drop);
      continue;
    }
    urlFiltered.push(candidate);
  }

  const sinceIso = new Date(now.getTime() - RECENT_TITLES_DEDUP_WINDOW_MS).toISOString();
  const recentRows: RecentTitleRow[] = await findRecentTitlesForDedup(db, sinceIso);

  const exactIndex = new Map<string, TitleEntry>();
  const jaccardList: TitleEntry[] = [];
  for (const row of recentRows) {
    const entry: TitleEntry = { title: row.title, id: row.id };
    const key = normalizeTitleExact(row.title);
    if (!exactIndex.has(key)) exactIndex.set(key, entry);
    jaccardList.push(entry);
  }

  const titleFiltered: Candidate[] = [];
  for (const candidate of urlFiltered) {
    const exactKey = normalizeTitleExact(candidate.title);
    const exactMatch = exactIndex.get(exactKey);
    if (exactMatch) {
      const drop: PoolDedupDrop = {
        candidateTitle: candidate.title,
        reason: "title",
        matchedId: exactMatch.id,
      };
      drops.push(drop);
      logPoolDedupDrop(drop);
      continue;
    }

    const jaccardMatch = jaccardList.find(
      (entry) => titleSimilarity(entry.title, candidate.title) >= TITLE_JACCARD_THRESHOLD,
    );
    if (jaccardMatch) {
      const drop: PoolDedupDrop = {
        candidateTitle: candidate.title,
        reason: "jaccard",
        matchedId: jaccardMatch.id,
      };
      drops.push(drop);
      logPoolDedupDrop(drop);
      continue;
    }

    titleFiltered.push(candidate);
    const keptEntry: TitleEntry = { title: candidate.title };
    exactIndex.set(exactKey, keptEntry);
    jaccardList.push(keptEntry);
  }

  const semanticFiltered = await applySemanticDedup(titleFiltered, semantic, now, drops);

  return { pool: semanticFiltered.slice(0, POOL_CAP), dedupDrops: drops, blockedDropped };
}
