import type {
  AddedVia,
  Article,
  ArticleListResponse,
  CreateArticleRequest,
  CreateArticleResponse,
  PatchArticleRequest,
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

const TURNSTILE_TOKEN_HEADER = "cf-turnstile-response";

// Pure — attaches the Turnstile header only when a token was actually
// acquired (i.e. Turnstile is active per /api/config). When inactive,
// `token` is always null/undefined and mutating requests go out exactly as
// before this feature — no header, no behavior change.
export function buildMutationHeaders(token?: string | null): Record<string, string> {
  return token ? { [TURNSTILE_TOKEN_HEADER]: token } : {};
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

export function getArticle(id: string): Promise<Article> {
  return request<Article>(`/api/articles/${encodeURIComponent(id)}`);
}

export function createArticle(
  input: { url: string; tags?: string[]; added_via?: AddedVia },
  turnstileToken?: string | null,
): Promise<CreateArticleResponse> {
  const body: CreateArticleRequest = input;
  return request<CreateArticleResponse>("/api/articles", {
    method: "POST",
    body: JSON.stringify(body),
    headers: buildMutationHeaders(turnstileToken),
  });
}

export function patchArticle(
  id: string,
  patch: PatchArticleRequest,
  turnstileToken?: string | null,
): Promise<Omit<Article, "full_text">> {
  return request(`/api/articles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    headers: buildMutationHeaders(turnstileToken),
  });
}

export function deleteArticle(id: string, turnstileToken?: string | null): Promise<void> {
  return request<void>(`/api/articles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: buildMutationHeaders(turnstileToken),
  });
}

export function retryArticle(
  id: string,
  turnstileToken?: string | null,
): Promise<CreateArticleResponse> {
  return request<CreateArticleResponse>(`/api/articles/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    headers: buildMutationHeaders(turnstileToken),
  });
}
