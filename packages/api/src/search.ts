import "./env.d.ts";
import type { ArticleListItem } from "@clipfeed/shared/types";
import { getArticlesByIds, listArticles } from "./db.ts";
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

// The one search implementation behind both GET /api/search (public) and
// GET /api/admin/search (owner) — callers only differ in how they shape
// each row afterward (toPublicArticle vs. the raw ArticleListItem, see
// index.ts). Semantic when `env.VECTORS` is configured and the embed call
// succeeds; falls back to the pre-existing title/summary LIKE search
// (score 0 for every row, in the same added_at-DESC order listArticles
// already uses) when Vectorize isn't provisioned, the embed call fails, or
// the query embeds to nothing useful — never throws, never a dead end for
// the caller.
export async function searchArticles(env: Env, q: string, limit: number): Promise<SearchHit[]> {
  if (!env.VECTORS) {
    return await keywordSearch(env, q, limit);
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

  let matches: RelatedMatch[];
  try {
    matches = await queryRelatedEmbeddings(env.VECTORS, vector, { topK: limit });
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

  const rows = await getArticlesByIds(env.DB, matches.map((m) => m.id));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const hits: SearchHit[] = [];
  for (const match of matches) {
    const article = byId.get(match.id);
    if (!article) continue; // deleted since being embedded — skip, not an error
    const { full_text: _fullText, ...listItem } = article;
    hits.push({ article: listItem, score: match.score });
  }
  return hits;
}

async function keywordSearch(env: Env, q: string, limit: number): Promise<SearchHit[]> {
  const result = await listArticles(env.DB, { limit, q });
  return result.items.slice(0, limit).map((article) => ({ article, score: 0 }));
}
