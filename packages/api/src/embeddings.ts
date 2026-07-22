import "./env.d.ts";
import { withTimeout } from "./summarize.ts";

// Semantic dedup (agent-pool.ts) + semantic search (GET /api/search) share
// one embedding: ONE Workers AI multilingual embedding model, ONE
// Vectorize index. See README "Semantic dedup & search" for the model
// choice write-up and the live-measured threshold this task derived it
// against.

export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";

// Must match the Vectorize index's configured dimensions exactly (see
// wrangler.toml's [[vectorize]] + scripts/setup.ts's ensureVectorize,
// which creates the index at this same value) — see
// assertEmbeddingDimensions below for what happens if EMBEDDING_MODEL is
// ever changed without also recreating the index at its new size.
export const EMBEDDING_DIMENSIONS = 1024;

export function resolveEmbeddingModel(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  return trimmed === "" ? DEFAULT_EMBEDDING_MODEL : trimmed;
}

// bge-m3's documented practical input cap for the embedding endpoint is
// ~512 tokens — there's no tokenizer available at the edge to count
// exactly, so this is a conservative character-based proxy (well under
// the ~2000-2500 chars a 512-token budget could hold for mixed EN
// content), erring toward truncating a little early rather than risking
// the API's own truncate/error behavior on an oversized request.
const MAX_EMBEDDING_INPUT_CHARS = 1800;

const EMBEDDING_CALL_TIMEOUT_MS = 30_000;

export interface EmbeddingTextInput {
  title_en: string | null;
  tldr_en: string | null;
  bullets_en: string[] | null;
}

// The canonical text embedded for one article — EN only, never RU. Same
// reasoning as faithfulness.ts's EN-only claim set: RU/EN are
// independently-written parallel translations of the same underlying
// facts (see summarize.ts's prompt), so embedding one language captures
// equivalent semantic content to embedding both, at half the Workers AI
// calls, and — more importantly for this specific use — keeps every
// article in ONE shared embedding space regardless of lang_original,
// instead of a RU article and an EN article about the identical story
// landing in different regions of vector space purely from language
// rather than content. title_en first (highest signal density, shortest),
// then tldr_en, then every bullet — order roughly follows decreasing
// information density per character, though cosine similarity on a mean-
// pooled embedding is not order-sensitive in practice.
export function buildEmbeddingText(input: EmbeddingTextInput): string {
  const parts = [
    input.title_en?.trim(),
    input.tldr_en?.trim(),
    ...(input.bullets_en ?? []).map((b) => b.trim()),
  ].filter((p): p is string => Boolean(p));
  return parts.join("\n").slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

interface EmbeddingApiResponse {
  shape?: number[];
  data?: number[][];
}

// Defensive parse of Workers AI's embedding response shape ({ shape, data:
// number[][] }, one row per input text — we always send exactly one text,
// so `data[0]` is the vector) — an untrusted API response, same "never
// trust the shape" posture as parseWorkersAiResult in summarize.ts.
export function extractEmbeddingVector(raw: unknown): number[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("embedding: unexpected response shape");
  }
  const { data } = raw as EmbeddingApiResponse;
  const vector = data?.[0];
  if (
    !Array.isArray(vector) || vector.length === 0 || !vector.every((v) => typeof v === "number")
  ) {
    throw new Error("embedding: unexpected response shape");
  }
  return vector;
}

// Fails LOUDLY (throws) rather than silently upserting/querying a
// wrong-shaped vector into Vectorize — a mismatch (EMBEDDING_MODEL
// changed without recreating the Vectorize index at the new dimension
// count, or an unexpected model response) would otherwise either surface
// much later as an opaque Vectorize API rejection, or worse, silently
// corrupt/degrade dedup and search quality with no error at all. Called
// from embedText below on every single embed call — see this task's
// report for why this was worth guarding explicitly rather than trusting
// the model config to always match the index.
export function assertEmbeddingDimensions(vector: number[], expected: number): void {
  if (vector.length !== expected) {
    throw new Error(
      `embedding: dimension mismatch — model produced ${vector.length}, expected ${expected} ` +
        `(EMBEDDING_DIMENSIONS/Vectorize index out of sync with EMBEDDING_MODEL)`,
    );
  }
}

// One Workers AI call -> one validated, dimension-checked vector. Throws
// on any failure (timeout, bad response shape, dimension mismatch) — the
// caller (pipeline.ts's embed stage) is responsible for catching this and
// treating it as best-effort, per this task's "embed failures must never
// fail the article" requirement; this function itself stays honest about
// failure rather than swallowing it.
export async function embedText(ai: Ai, model: string, text: string): Promise<number[]> {
  const raw = await withTimeout(
    ai.run(model, { text }),
    EMBEDDING_CALL_TIMEOUT_MS,
    `timed out after ${EMBEDDING_CALL_TIMEOUT_MS}ms`,
  );
  const vector = extractEmbeddingVector(raw);
  assertEmbeddingDimensions(vector, EMBEDDING_DIMENSIONS);
  return vector;
}

// Standard cosine similarity, [-1, 1] (in practice ~[0, 1] for this
// model's embeddings) — the metric the Vectorize index itself is
// configured with (metric = "cosine"), duplicated here in plain JS for
// the within-batch pairwise dedup pass (agent-pool.ts), which compares
// freshly computed candidate vectors against each other directly, without
// a Vectorize round-trip.
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ArticleEmbeddingMetadata {
  added_at: string;
  source: string | null;
  added_via: string;
  lang_original: string | null;
}

// Vectorize metadata values must be string/number/boolean — null fields
// (source/lang_original can genuinely be null on a stored article) are
// coerced to "" rather than omitted, since a missing key and an empty
// string behave identically for every current consumer (neither is ever
// filtered on) and a stable key set is simpler to reason about.
function toVectorizeMetadata(meta: ArticleEmbeddingMetadata): Record<string, string> {
  return {
    added_at: meta.added_at,
    source: meta.source ?? "",
    added_via: meta.added_via,
    lang_original: meta.lang_original ?? "",
  };
}

// upsert/delete below are no-ops when `vectors` is undefined, AND swallow
// any error the call itself throws — both are write-side, best-effort
// operations with no meaningful fallback for a caller to run instead (see
// README): a fork that hasn't run `deno task setup` yet, or `wrangler dev`
// (which has no local Vectorize emulation at all — `env.VECTORS` there is a
// live but non-functional proxy that throws "needs to be run remotely" on
// every method call, not simply undefined) must never crash on these calls.
// queryRelatedEmbeddings below is deliberately NOT swallowed the same
// way — it's a read with a real fallback (keyword search in search.ts,
// fail-open in agent-pool.ts's dedup layer), so its caller needs to know a
// query genuinely failed rather than silently returning matches: [].
function logVectorizeFailure(event: string, err: unknown, extra: Record<string, unknown> = {}) {
  console.warn(JSON.stringify({
    event,
    error: err instanceof Error ? err.message : String(err),
    ...extra,
  }));
}

export async function upsertArticleEmbedding(
  vectors: VectorizeIndex | undefined,
  id: string,
  values: number[],
  metadata: ArticleEmbeddingMetadata,
): Promise<void> {
  if (!vectors) return;
  try {
    await vectors.upsert([{ id, values, metadata: toVectorizeMetadata(metadata) }]);
  } catch (err) {
    logVectorizeFailure("vectorize_upsert_failed", err, { id });
  }
}

export async function deleteArticleEmbedding(
  vectors: VectorizeIndex | undefined,
  id: string,
): Promise<void> {
  if (!vectors) return;
  try {
    await vectors.deleteByIds([id]);
  } catch (err) {
    logVectorizeFailure("vectorize_delete_failed", err, { id });
  }
}

export interface RelatedMatch {
  id: string;
  score: number;
}

// topK nearest neighbors within the given added_at window (most similar
// first — Vectorize itself returns matches score-descending), used by
// both the semantic dedup layer (window = 72h) and semantic search
// (no window — see index.ts, which omits `sinceIso` for an unfiltered
// query). Requires a metadata index on `added_at` for the filter to work
// (see scripts/setup.ts's ensureVectorizeMetadataIndex) — created once at
// setup time, alongside the index itself. Returns [] only when `vectors`
// is undefined; a real query failure THROWS (see the module doc comment
// above for why this one doesn't swallow) — every caller must catch it.
export async function queryRelatedEmbeddings(
  vectors: VectorizeIndex | undefined,
  values: number[],
  opts: { topK: number; sinceIso?: string },
): Promise<RelatedMatch[]> {
  if (!vectors) return [];
  const result = await vectors.query(values, {
    topK: opts.topK,
    returnMetadata: "none",
    filter: opts.sinceIso ? { added_at: { $gte: opts.sinceIso } } : undefined,
  });
  return result.matches.map((m) => ({ id: m.id, score: m.score }));
}
