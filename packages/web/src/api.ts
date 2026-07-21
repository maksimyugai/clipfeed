import type {
  AddedVia,
  Article,
  ArticleListResponse,
  CreateArticleRequest,
  CreateArticleResponse,
  PatchArticleRequest,
  PublicArticle,
  PublicArticleListResponse,
} from "@clipfeed/shared/types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
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

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    if (body.error) return body.error;
  } catch {
    // response wasn't JSON — fall through to a generic message
  }
  return `request failed with status ${res.status}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    throw new ApiError(await readErrorMessage(res), res.status);
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
