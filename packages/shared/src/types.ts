export type ArticleStatus = "pending" | "ready" | "failed";
export type AddedVia = "extension" | "manual" | "agent" | "telegram";

// Verdict from the independent faithfulness judge (always Workers AI Llama —
// see packages/api/src/faithfulness.ts), run as a separate pipeline stage
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

// body_ru/body_en: 2-4 self-contained prose paragraphs (what happened,
// how/why, key context, implications) — the readable digest a reader can
// stop at instead of opening the source. Required for every NEW summary
// (see validateSummary in summarize.ts), but rows saved before this field
// existed have no body_ru/body_en in their stored JSON at all — callers
// reading summary_json back out of D1 must not assume these arrays are
// present (see selectSummaryFields in packages/web/src/lib/summaryFields.ts
// for the defensive read); there's no migration backfilling old rows.
export interface SummaryJson {
  title_ru: string;
  title_en: string;
  tldr_ru: string;
  tldr_en: string;
  body_ru: string[];
  body_en: string[];
  bullets_ru: string[];
  bullets_en: string[];
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
// pending article; 'resummarize' re-runs only the summarize step. Kept
// intentionally small (well under the 128KB Queues message-size limit) —
// large payloads like extension-submitted HTML are handed off via KV
// instead (see queue.ts's stashPendingHtml/takePendingHtml), and everything
// else the consumer needs is re-read from the D1 row by articleId.
export interface QueueMessage {
  kind: "process" | "resummarize";
  articleId: string;
  notify?: QueueNotify;
}
