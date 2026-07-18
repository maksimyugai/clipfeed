export type ArticleStatus = "pending" | "ready" | "failed";

// Field names are camelCase; the D1 `articles` table uses snake_case columns
// (see migrations/0001_init.sql). Row <-> Article mapping happens in the API layer.
export interface Article {
  id: string;
  url: string;
  canonicalUrl: string | null;
  title: string;
  source: string | null;
  author: string | null;
  publishedAt: string | null;
  addedAt: string;
  addedVia: string;
  langOriginal: string | null;
  fullText: string | null;
  summaryRu: string | null;
  summaryEn: string | null;
  tags: string[];
  status: ArticleStatus;
  archived: boolean;
}
