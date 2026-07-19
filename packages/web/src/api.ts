import type {
  AddedVia,
  Article,
  ArticleListResponse,
  CreateArticleRequest,
  CreateArticleResponse,
  PatchArticleRequest,
  PublicArticle,
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
// a network layer.
export function buildArticlesUrl(params: ArticlesQueryParams): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.tag) search.set("tag", params.tag);
  if (params.source) search.set("source", params.source);
  if (params.q) search.set("q", params.q);
  if (params.archived !== undefined) search.set("archived", params.archived ? "1" : "0");

  const qs = search.toString();
  return qs ? `/api/articles?${qs}` : "/api/articles";
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

export function listArticles(params: ArticlesQueryParams = {}): Promise<ArticleListResponse> {
  return request<ArticleListResponse>(buildArticlesUrl(params));
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
