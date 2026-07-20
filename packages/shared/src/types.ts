export type ArticleStatus = "pending" | "ready" | "failed";
export type AddedVia = "extension" | "manual" | "agent" | "telegram";

// Healing strategy bucket for a 'failed' row — see classifyFailure() in
// packages/api/src/classify-failure.ts for the mapping from the stored
// `error` string. null until a failure has actually been classified (old
// rows from before this column existed, or a row that isn't 'failed').
export type FailureClass = "transient" | "permanent" | "unknown";

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
}

export type ArticleListItem = Omit<Article, "full_text">;

// GET /api/articles/:id (public) shape: excludes full_text (the article's
// full extracted text — publicly re-serving that would be a reprint, not a
// summary-with-link) and the raw error string (may carry internal detail
// like upstream URLs/stack fragments); has_error is enough for a public
// reader to know a retry is pending. The full row (both fields included)
// is only available to the owner, via GET /api/admin/articles/:id.
export type PublicArticle = Omit<Article, "full_text" | "error"> & { has_error: boolean };

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

export interface ArticleListResponse {
  items: ArticleListItem[];
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
