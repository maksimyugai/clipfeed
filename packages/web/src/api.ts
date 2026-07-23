import type {
  AddedVia,
  AdminSearchResponse,
  Article,
  ArticleListItem,
  ArticleListResponse,
  CreateArticleRequest,
  CreateArticleResponse,
  PatchArticleRequest,
  PublicArticle,
  PublicArticleListResponse,
  SearchResponse,
} from "@clipfeed/shared/types";

export class ApiError extends Error {
  // `body` carries the full parsed JSON error response (when the response
  // was JSON) beyond just its `error` string — e.g. the 409 duplicate-add
  // response's `reason: "similar_title"` field, which errorMessages.ts
  // needs to tell a plain duplicate URL apart from a similar-title match.
  // Undefined when the response wasn't JSON at all.
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

export interface ArticlesQueryParams {
  cursor?: string;
  limit?: number;
  tag?: string;
  source?: string;
  q?: string;
  archived?: boolean;
}

// Pure — no fetch — so filter/cursor combinations are unit-testable without
// a network layer. `base` lets the owner-mode list reuse the exact same
// filter-building logic against /api/admin/articles instead of the public
// /api/articles (see listAdminArticles below).
export function buildArticlesUrl(params: ArticlesQueryParams, base = "/api/articles"): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.tag) search.set("tag", params.tag);
  if (params.source) search.set("source", params.source);
  if (params.q) search.set("q", params.q);
  if (params.archived !== undefined) search.set("archived", params.archived ? "1" : "0");

  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

async function readErrorBody(res: Response): Promise<{ message: string; body?: unknown }> {
  try {
    const body = await res.json() as { error?: string };
    if (body.error) return { message: body.error, body };
  } catch {
    // response wasn't JSON — fall through to a generic message
  }
  return { message: `request failed with status ${res.status}` };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const { message, body } = await readErrorBody(res);
    throw new ApiError(message, res.status, body);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return await res.json() as T;
}

// Public — every row is redacted the same way as getArticle() below (no
// raw `error` field, only has_error/fail_class). Used for the visitor-mode
// feed; the owner-mode feed uses listAdminArticles instead (see App.tsx's
// owner/visitor branch).
export function listArticles(params: ArticlesQueryParams = {}): Promise<PublicArticleListResponse> {
  return request<PublicArticleListResponse>(buildArticlesUrl(params));
}

// Owner-only — full rows, including the real `error` field (full_text
// still excluded, same as GET /api/admin/articles/:id minus full_text).
export function listAdminArticles(params: ArticlesQueryParams = {}): Promise<ArticleListResponse> {
  return request<ArticleListResponse>(buildArticlesUrl(params, "/api/admin/articles"));
}

// Pure, same reasoning as buildArticlesUrl above — unit-testable without a
// fetch mock. `base` lets the owner-mode search reuse it against
// /api/admin/search (see searchAdminArticles below).
export function buildSearchUrl(q: string, limit: number, base = "/api/search"): string {
  const search = new URLSearchParams({ q, limit: String(limit) });
  return `${base}?${search}`;
}

// Semantic search ("ask your feed" — see README "Semantic dedup & search").
// Public, same redaction as listArticles above (no raw `error`). Unlike
// listArticles/listAdminArticles, this isn't cursor-paginated — a single
// bounded top-K list, ranked by similarity (never shown, see the empty
// `score` handling in App.tsx). Falls back server-side to keyword search
// when Vectorize isn't configured, so this never needs its own fallback.
export function searchArticles(q: string, limit = 20): Promise<SearchResponse> {
  return request<SearchResponse>(buildSearchUrl(q, limit));
}

// Owner-only equivalent — real `error` field, same as listAdminArticles vs.
// listArticles.
export function searchAdminArticles(q: string, limit = 20): Promise<AdminSearchResponse> {
  return request<AdminSearchResponse>(buildSearchUrl(q, limit, "/api/admin/search"));
}

// Owner-only single-row refetch — used to sync one stale card against the
// server without a full list reload: after a 409-on-ready retry (the
// client's view was stale) and by the periodic failed-card refresh (see
// lib/failedRefresh.ts). Strips full_text the same way listAdminArticles'
// rows already lack it, so a refreshed row is drop-in compatible with
// ArticleListItem.
export async function getAdminArticle(id: string): Promise<ArticleListItem> {
  const article = await request<Article>(`/api/admin/articles/${encodeURIComponent(id)}`);
  const { full_text: _fullText, ...rest } = article;
  return rest;
}

// Public — excludes full_text/error (see PublicArticle). Used by the
// pending-status poll, which runs for any visitor watching a fresh save.
export function getArticle(id: string): Promise<PublicArticle> {
  return request<PublicArticle>(`/api/articles/${encodeURIComponent(id)}`);
}

export interface AdminMe {
  sub: string;
  email: string | null;
}

// 200 -> owner mode; throws ApiError(401) for a visitor (no/invalid Access
// identity) or when Access isn't configured on the server at all.
export function getAdminMe(): Promise<AdminMe> {
  return request<AdminMe>("/api/admin/me");
}

export function createArticle(
  input: { url: string; tags?: string[]; added_via?: AddedVia },
): Promise<CreateArticleResponse> {
  const body: CreateArticleRequest = input;
  return request<CreateArticleResponse>("/api/admin/articles", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function patchArticle(
  id: string,
  patch: PatchArticleRequest,
): Promise<Omit<Article, "full_text">> {
  return request(`/api/admin/articles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteArticle(id: string): Promise<void> {
  return request<void>(`/api/admin/articles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function retryArticle(id: string): Promise<CreateArticleResponse> {
  return request<CreateArticleResponse>(`/api/admin/articles/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });
}

// Re-runs only the summarization step against the stored full_text (or the
// full pipeline if there isn't one) — see the API's
// POST /api/admin/articles/:id/resummarize for the distinction from retry.
export function resummarizeArticle(id: string): Promise<CreateArticleResponse> {
  return request<CreateArticleResponse>(
    `/api/admin/articles/${encodeURIComponent(id)}/resummarize`,
    { method: "POST" },
  );
}

// Task 35 Part A §3/§4: enqueues (or, if already done, no-ops on) lazy EN
// generation for one article — the owner-only EN toggle triggers this per
// visible card that's missing an English edition (see
// lib/translateQueue.ts for the concurrency cap this is called under).
export interface TranslateResponse {
  id: string;
  status: "pending" | "already-translated";
}

export function translateArticle(id: string): Promise<TranslateResponse> {
  return request<TranslateResponse>(
    `/api/admin/articles/${encodeURIComponent(id)}/translate`,
    { method: "POST" },
  );
}
