export type ArticleStatus = "pending" | "ready" | "failed";
export type AddedVia = "extension" | "manual" | "agent";

export interface SummaryJson {
  title_ru: string;
  title_en: string;
  tldr_ru: string;
  tldr_en: string;
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
