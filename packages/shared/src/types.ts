export type ArticleStatus = "pending" | "ready" | "failed";
export type AddedVia = "extension" | "manual" | "agent" | "telegram";

// Verdict from the independent faithfulness judge (always Workers AI Llama —
// see packages/api/src/pipeline/faithfulness.ts), run as a separate pipeline stage
// after a summary validates but before the article is marked 'ready'. null
// means the check hasn't run at all (disabled, or a pre-Task-23 row) — this
// is distinct from a judge call that ran but couldn't be parsed, which is
// still recorded (verdict null, but faithfulness_json carries an
// {error: string} shape and faithfulness_checked_at is set) so the two
// "null verdict" cases are distinguishable by checked_at.
export type FaithfulnessVerdict = "pass" | "weak" | "fail";

export interface FaithfulnessClaimResult {
  i: number;
  verdict: "supported" | "unsupported" | "contradicted";
  evidence: string;
}

// The judge's full response — either every claim it verified (plus its free
// -text notes) or a marker that its output couldn't be parsed even after one
// corrective retry (see faithfulness.ts's runFaithfulnessCheck — a judge
// failure never blocks the article, it just leaves this shape behind for
// diagnosis).
export type FaithfulnessJson =
  | { claims: FaithfulnessClaimResult[]; notes: string }
  | { error: string };

// Healing strategy bucket for a 'failed' row — see classifyFailure() in
// packages/api/src/classify-failure.ts for the mapping from the stored
// `error` string. null until a failure has actually been classified (old
// rows from before this column existed, or a row that isn't 'failed').
export type FailureClass = "transient" | "permanent" | "unknown" | "content";

// body_ru: 2-4 self-contained prose paragraphs (what happened, how/why, key
// context, implications) — the readable digest a reader can stop at instead
// of opening the source. Required for every NEW summary (see validateSummary
// in summarize.ts), but rows saved before this field existed have no body_ru
// in their stored JSON at all — callers reading summary_json back out of D1
// must not assume this array is present (see selectSummaryFields in
// packages/web/src/lib/summaryFields.ts for the defensive read); there's no
// migration backfilling old rows.
//
// Task 35 Part A ("Russian-first"): the *_en fields are no longer generated
// by default — a fresh summary carries ONLY the _ru fields (+ tags/
// lang_original), roughly halving output tokens and avoiding max_tokens
// truncation for the owner, who reads Russian only. The _en fields are now
// OPTIONAL, populated lazily and independently (never translated from the
// _ru text — see summarize.ts's generateEnglishFields) via
// POST /api/admin/articles/:id/translate, which also sets
// Article.en_generated_at. Existing rows summarized before this task keep
// whatever _en fields they already have — no backfill, no deletion — so
// this type has to tolerate both shapes at once.
export interface SummaryJson {
  title_ru: string;
  title_en?: string;
  tldr_ru: string;
  tldr_en?: string;
  body_ru: string[];
  body_en?: string[];
  bullets_ru: string[];
  bullets_en?: string[];
  tags: string[];
  lang_original: string;
}

// Field names match the D1 `articles` table and the JSON wire format exactly
// (see migrations/0001_init.sql, 0002_add_error_and_summary_json.sql) — no
// camelCase <-> snake_case mapping layer between DB, API, and clients.
export interface Article {
  id: string;
  url: string;
  canonical_url: string | null;
  title: string;
  source: string | null;
  author: string | null;
  published_at: string | null;
  added_at: string;
  added_via: AddedVia;
  lang_original: string | null;
  full_text: string | null;
  summary_ru: string | null;
  summary_en: string | null;
  summary_json: SummaryJson | null;
  tags: string[];
  status: ArticleStatus;
  archived: boolean;
  error: string | null;
  fail_class: FailureClass | null;
  heal_attempts: number;
  faithfulness_verdict: FaithfulnessVerdict | null;
  faithfulness_json: FaithfulnessJson | null;
  faithfulness_checked_at: string | null;
  // Set once this article's Vectorize embedding has been written (see
  // packages/api/src/search/embeddings.ts) — null means not embedded yet: a fresh
  // 'ready' article whose embed stage hasn't run, one whose embed call
  // failed (embed failures never fail the article itself — see
  // pipeline.ts), or a row saved before this feature existed. The backfill
  // endpoint (POST /api/admin/embeddings/backfill) and idempotent —
  // catches all three by selecting WHERE embedded_at IS NULL.
  embedded_at: string | null;
  // Set once this article has been drip-published to Telegram (see
  // packages/api/src/telegram/telegram-publish.ts) — null means not yet published.
  // Named distinctly from `published_at` above (the SOURCE article's own
  // publish date) to avoid colliding with that unrelated, pre-existing
  // field. A 'fail'-verdict article is marked here WITHOUT ever actually
  // being sent (see telegram-publish.ts's doc comment) so the drip queue
  // advances past it instead of retrying the same skip forever. Task 37:
  // may also hold db.ts's TELEGRAM_SKIPPED_STALE_MARKER sentinel string
  // instead of a real ISO timestamp, for an article that aged out of the
  // drip's today-only window and will never be published — every reader of
  // this field only ever checks NULL vs. NOT NULL, never parses it as a
  // Date, so the sentinel is safe here.
  telegram_published_at: string | null;
  // Task 35 Part A: set once POST /api/admin/articles/:id/translate has
  // successfully generated and merged the _en summary fields (see
  // summarize.ts's generateEnglishFields) — null means "no EN yet" for a
  // RU-only summary. The endpoint is idempotent on this field (already-set
  // means 200 no-op, never a second translate). Distinct from the pre-Task-35
  // rows that already carry _en fields from the old RU+EN-by-default
  // generation — those rows are never backfilled with this field, so a
  // non-null title_en/tldr_en with a null en_generated_at is a normal,
  // expected combination for old rows, not a bug.
  en_generated_at: string | null;
  // Task 35 Part C: R2 object key for this article's thumbnail/preview
  // image (`articles/<id>.<ext>`), scraped from the source page's own
  // og:image/twitter:image meta tag — see packages/api/src/pipeline/images.ts. null
  // means no image (none found, download/validation failed, or the feature
  // is disabled) — images are strictly optional and never fail a summary.
  image_key: string | null;
  // The original (source-page) image URL this was downloaded from — shown
  // as attribution ("Image: <domain>", see ArticleCard.tsx) and re-checked
  // if the image is ever re-fetched; null whenever image_key is null.
  image_source_url: string | null;
  // Task 41 Part C: set as the very first thing a queue consumer invocation
  // does for this row (see index.ts's queue() handler), before fetch/
  // summarize/anything else runs. NULL means the message hasn't reached a
  // consumer yet — still sitting in the queue behind other work (see
  // db.ts's sweepStalePending, which uses this to tell "queue backlog" apart
  // from "the pipeline itself is stuck," rather than measuring both from
  // added_at as it used to. Reset to NULL by markArticlePending so a retry/
  // resummarize's own wait is measured fresh, not against a stale value from
  // a previous attempt.
  processing_started_at: string | null;
}

export type ArticleListItem = Omit<Article, "full_text">;

// GET /api/articles/:id (public) shape: excludes full_text (the article's
// full extracted text — publicly re-serving that would be a reprint, not a
// summary-with-link), the raw error string (may carry internal detail like
// upstream URLs/stack fragments), and faithfulness_json (the judge's
// per-claim detail — owner-only diagnostic, see faithfulness.ts). has_error
// is enough for a public reader to know a retry is pending;
// faithfulness_verdict IS still exposed publicly — the whole point of the
// caution badge (see ArticleCard.tsx) is transparency for every reader, not
// just the owner. The full row (every field included) is only available to
// the owner, via GET /api/admin/articles/:id.
export type PublicArticle =
  & Omit<Article, "full_text" | "error" | "faithfulness_json">
  & { has_error: boolean };

export interface CreateArticleRequest {
  url: string;
  html?: string;
  title?: string;
  tags?: string[];
  added_via?: AddedVia;
}

export interface CreateArticleResponse {
  id: string;
  status: ArticleStatus;
}

// 409 body for POST /api/admin/articles (manual/extension adds) and the
// Telegram save flow — reason distinguishes an exact URL re-add (already
// this exact article) from a normalized-title match against a DIFFERENT
// URL within the last 72h (Task 24 Part C: likely the same story, but not
// certain — the client/bot decides how to phrase that, this API only
// signals which case it is). `reason` is omitted for the exact-URL case to
// stay backward compatible with existing 409 consumers that only look at
// `id`.
export interface DuplicateArticleResponse {
  id: string;
  error: "duplicate";
  reason?: "similar_title";
}

export interface ArticleListResponse {
  items: ArticleListItem[];
  next_cursor: string | null;
}

// GET /api/articles (public) shape — same redaction as PublicArticle,
// applied per row: a failed article's raw `error` string carries internal
// pipeline detail (upstream URLs, stack fragments) that a public list must
// never leak to an anonymous visitor. See GET /api/admin/articles for the
// owner-only equivalent that includes the real `error` field.
export interface PublicArticleListResponse {
  items: PublicArticle[];
  next_cursor: string | null;
}

export interface PatchArticleRequest {
  archived?: boolean;
  tags?: string[];
}

export interface RetryArticleRequest {
  html?: string;
}

// Telegram edit-on-finish target, carried through a queue message so the
// consumer (which may run in a completely different invocation than the
// producer) can still update the "Сохраняю…" placeholder once the pipeline
// finishes — see queue.ts.
export interface QueueNotify {
  chatId: string;
  messageId: number;
}

// Body of a message on the "clipfeed-jobs" queue (see wrangler.toml
// [[queues.producers/consumers]], queue.ts, index.ts's `queue` export).
// 'process' runs the full fetch -> extract -> summarize pipeline for a
// pending article; 'resummarize' re-runs only the summarize step.
// 'translate' (Task 35 Part A) generates ONLY the _en summary fields from
// the article's stored full_text (never a translation of the _ru text —
// see summarize.ts's generateEnglishFields) and merges them into
// summary_json, setting en_generated_at — see
// POST /api/admin/articles/:id/translate. Kept intentionally small (well
// under the 128KB Queues message-size limit) — large payloads like
// extension-submitted HTML are handed off via KV instead (see queue.ts's
// stashPendingHtml/takePendingHtml), and everything else the consumer needs
// is re-read from the D1 row by articleId.
export interface QueueMessage {
  kind: "process" | "resummarize" | "translate";
  articleId: string;
  notify?: QueueNotify;
  // Task 41 Part C: generated once per enqueue (see enqueueArticleJob in
  // queue.ts), logged by both the producer (queue_started) and the consumer
  // (queue_received/queue_done) so an operator can correlate the two sides
  // in `wrangler tail` without guessing from articleId+kind alone — the
  // same article can legitimately be enqueued more than once in quick
  // succession (e.g. a process job, then an almost-immediate manual retry).
  queueMessageId: string;
}

// GET /api/search (public, semantic mode only — keyword search reuses the
// existing `q` param on GET /api/articles) — each row carries its cosine
// score so a caller COULD show it, though this repo's own SPA deliberately
// doesn't (score-driven ordering only, no visible number — see README).
// Score is a plain top-level field, not nested, so both the public and
// admin search responses share this one shape (the row type is the only
// difference — see AdminSearchResponse below).
export interface SearchResultItem {
  article: PublicArticle;
  score: number;
}

export interface SearchResponse {
  items: SearchResultItem[];
}

export interface AdminSearchResultItem {
  article: ArticleListItem;
  score: number;
}

export interface AdminSearchResponse {
  items: AdminSearchResultItem[];
}

// POST /api/admin/embeddings/backfill's response — the caller (owner
// tooling, or a future SPA button) repeats the call until `remaining` is 0,
// same synchronous-paginated pattern as other one-shot admin jobs in this
// repo (e.g. the tag-normalization backfill).
export interface EmbeddingsBackfillResponse {
  processed: number;
  remaining: number;
}
