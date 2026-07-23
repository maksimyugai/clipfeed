import "../env.d.ts";
import type { ArticleListItem, ArticleStatus } from "@clipfeed/shared/types";
import { getArticlesByIds, listArticles } from "../articles/db.ts";
import {
  embedText,
  queryRelatedEmbeddings,
  type RelatedMatch,
  resolveEmbeddingModel,
} from "./embeddings.ts";

const DEFAULT_SEARCH_RATE_PER_MIN = 30;
const MIN_SEARCH_RATE_PER_MIN = 1;
const MAX_SEARCH_RATE_PER_MIN = 1000;

// [vars] string, parsed defensively — same convention as
// agent-pool.ts's parseSemanticDedupMaxCandidates.
export function parseSearchRatePerMin(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_SEARCH_RATE_PER_MIN;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < MIN_SEARCH_RATE_PER_MIN || n > MAX_SEARCH_RATE_PER_MIN) {
    console.warn(JSON.stringify({
      event: "search_rate_per_min_invalid",
      raw: trimmed,
      fallback: DEFAULT_SEARCH_RATE_PER_MIN,
    }));
    return DEFAULT_SEARCH_RATE_PER_MIN;
  }
  return Math.round(n);
}

// Empirically derived (see README "Semantic dedup & search" for the live
// query->score table this was tuned against) — Vectorize's topK always
// returns the K nearest vectors regardless of how far they actually are,
// so an off-topic query against a small corpus otherwise returns "least
// far" noise dressed up as search results instead of an honest empty list.
const DEFAULT_SEARCH_MIN_SCORE = 0.5;

export function parseSearchMinScore(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_SEARCH_MIN_SCORE;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.warn(JSON.stringify({
      event: "search_min_score_invalid",
      raw: trimmed,
      fallback: DEFAULT_SEARCH_MIN_SCORE,
    }));
    return DEFAULT_SEARCH_MIN_SCORE;
  }
  return n;
}

// Task 43 Part 5: a fixed SEARCH_MIN_SCORE penalizes SHORT queries unfairly.
// Article embeddings are built from title + tldr + bullets (hundreds of
// characters — see embeddings.ts's buildEmbeddingText); a one- or two-word
// query produces a much shorter vector whose cosine similarity against that
// long text is mathematically lower even for a perfect topical match. Live
// numbers gathered against the owner's real corpus (60 real articles, real
// bge-m3 embeddings, before any threshold filtering) confirmed this:
//   "кабели"             (1 word)  -> top real match 0.490
//   "кабель"              (1 word)  -> top real match 0.497
//   "кабели по"           (2 words) -> top real match 0.502 (the padding
//                                      word alone pushed a genuine match
//                                      from below 0.5 to just above it)
//   "подводные кабели"    (2 words) -> top real match 0.539
//   "бетономешалка"       (1 word,  unrelated to any stored article)
//                                   -> top real match only 0.390
//   "бетономешалка производитель" (2 words, still unrelated) -> only 0.365
// A genuine 1-word match and a 1-word nonsense query are ~0.10 apart, and a
// genuine 2-word match and nonsense are ~0.15 apart — comfortable margin for
// a per-length floor without letting nonsense through. Also tried wrapping
// short queries in a neutral template ("новости про {query}") before
// embedding: it raised "кабели" from 0.490 to 0.506, but LOWERED "кабель"
// from 0.497 to 0.492 — inconsistent, so it was NOT adopted (the task's own
// bar is "keep only if it demonstrably helps").
const SHORT_QUERY_ONE_WORD_DISCOUNT = 0.05;
const SHORT_QUERY_TWO_WORD_DISCOUNT = 0.02;

function countQueryWords(q: string): number {
  return q.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

// SEARCH_MIN_SCORE stays the base/ceiling value (used as-is for 3+ word
// queries, and as the reference point the 1-/2-word discounts are taken
// off of) so it's still the one tunable var an owner adjusts to raise or
// lower the whole scale.
export function adaptiveMinScore(baseMinScore: number, q: string): number {
  const words = countQueryWords(q);
  const discount = words <= 1
    ? SHORT_QUERY_ONE_WORD_DISCOUNT
    : words === 2
    ? SHORT_QUERY_TWO_WORD_DISCOUNT
    : 0;
  // Rounded to avoid float noise (e.g. 0.7 - 0.05 === 0.6499999999999999)
  // leaking into an otherwise-clean tunable value.
  return Math.round(Math.max(0, baseMinScore - discount) * 1000) / 1000;
}

// Vectorize is queried for more than `limit` candidates so the min-score
// filter below has real material to work with — filtering topK=limit down
// to (say) 3 matches would otherwise under-fill a request that could have
// been satisfied by digging a little deeper. Capped at 60 regardless of
// how large `limit` is asked to be, since this is still one Vectorize call
// either way and there's no product need for a deeper search than that.
const TOPK_MULTIPLIER = 3;
const MAX_TOPK = 60;

function expandedTopK(limit: number): number {
  return Math.min(limit * TOPK_MULTIPLIER, MAX_TOPK);
}

const RATE_LIMIT_TTL_SECONDS = 90; // one bucket-minute plus slack

function rateLimitKey(now: Date): string {
  // Minute-bucketed, UTC — same coarse-bucket counter pattern as
  // cost-guard.ts's daily counter, just at minute instead of day
  // granularity. KV reads/writes aren't atomic, so concurrent requests can
  // race past the limit by a small margin — acceptable here, same tradeoff
  // cost-guard.ts already makes for the (much higher-stakes) daily LLM
  // budget.
  return `search_rate:${now.toISOString().slice(0, 16)}`; // YYYY-MM-DDTHH:MM
}

// GET /api/search and /api/admin/search share this one counter — a single
// per-minute budget for the whole instance, not per-caller, since there's
// no authenticated identity on the public route to key by.
export async function tryConsumeSearchRateLimit(
  cache: KVNamespace,
  limitPerMin: number,
  now: Date = new Date(),
): Promise<boolean> {
  const key = rateLimitKey(now);
  const current = await cache.get(key);
  const count = current ? Number(current) : 0;
  if (count >= limitPerMin) return false;
  await cache.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL_SECONDS });
  return true;
}

export interface SearchHit {
  article: ArticleListItem;
  score: number;
}

// Pure, so the filter/order/truncate logic is unit-testable without a
// Vectorize stub. Drops anything below `minScore` (a query that's
// genuinely off-topic for the whole corpus should come back empty, not
// "least far" noise dressed up as a match — see SEARCH_MIN_SCORE above),
// re-sorts by score descending (Vectorize already returns matches this
// way, but topK was over-fetched — see expandedTopK — so re-asserting the
// order here rather than trusting it stays that way after any future
// change is cheap insurance), then truncates to the caller's requested
// `limit`.
export function filterAndOrderMatches(
  matches: RelatedMatch[],
  minScore: number,
  limit: number,
): RelatedMatch[] {
  return matches
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// The one search implementation behind both GET /api/search (public) and
// GET /api/admin/search (owner) — callers only differ in how they shape
// each row afterward (toPublicArticle vs. the raw ArticleListItem, see
// index.ts). Semantic when `env.VECTORS` is configured and the embed call
// succeeds; falls back to the pre-existing title/summary LIKE search
// (score 0 for every row, in the same added_at-DESC order listArticles
// already uses) when Vectorize isn't provisioned, the embed call fails, or
// the query embeds to nothing useful — never throws, never a dead end for
// the caller.
//
// Task 41 Part D: `status`, when given, filters BOTH search paths — the
// public route passes 'ready' (a pending/failed article must never surface
// in a visitor's results, same principle as the list/detail routes; a
// resummarize-in-progress row can still match its OLD embedding while
// showing 'pending', so the semantic path needs this filter too, not just
// the keyword fallback). The admin route passes nothing (undefined), same
// as its list-endpoint counterpart.
export async function searchArticles(
  env: Env,
  q: string,
  limit: number,
  status?: ArticleStatus,
): Promise<SearchHit[]> {
  if (!env.VECTORS) {
    return await keywordSearch(env, q, limit, status);
  }

  let vector: number[];
  try {
    const model = resolveEmbeddingModel(env.EMBEDDING_MODEL);
    vector = await embedText(env.AI, model, q);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "search_embed_failed",
      error: err instanceof Error ? err.message : String(err),
    }));
    return await keywordSearch(env, q, limit);
  }

  let rawMatches: RelatedMatch[];
  try {
    rawMatches = await queryRelatedEmbeddings(env.VECTORS, vector, { topK: expandedTopK(limit) });
  } catch (err) {
    // A real query failure (not just "no matches") — same fallback as an
    // embed failure above, not an empty result set. Covers `wrangler dev`,
    // where `env.VECTORS` is present but throws on every call (see
    // embeddings.ts's module doc comment on why queryRelatedEmbeddings
    // itself doesn't swallow this).
    console.warn(JSON.stringify({
      event: "search_query_failed",
      error: err instanceof Error ? err.message : String(err),
    }));
    return await keywordSearch(env, q, limit);
  }

  const minScore = adaptiveMinScore(parseSearchMinScore(env.SEARCH_MIN_SCORE), q);
  const matches = filterAndOrderMatches(rawMatches, minScore, limit);

  const rows = await getArticlesByIds(env.DB, matches.map((m) => m.id));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const hits: SearchHit[] = [];
  for (const match of matches) {
    const article = byId.get(match.id);
    if (!article) continue; // deleted since being embedded — skip, not an error
    if (status && article.status !== status) continue;
    const { full_text: _fullText, ...listItem } = article;
    hits.push({ article: listItem, score: match.score });
  }
  return hits;
}

async function keywordSearch(
  env: Env,
  q: string,
  limit: number,
  status?: ArticleStatus,
): Promise<SearchHit[]> {
  const result = await listArticles(env.DB, { limit, q, status });
  return result.items.slice(0, limit).map((article) => ({ article, score: 0 }));
}
