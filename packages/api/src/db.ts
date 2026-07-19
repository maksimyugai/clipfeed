import "./env.d.ts";
import type {
  AddedVia,
  Article,
  ArticleListItem,
  ArticleStatus,
  PublicArticle,
  SummaryJson,
} from "@clipfeed/shared/types";

// Raw D1 row shape — matches migrations/0001_init.sql + 0002_*.sql exactly.
// `tags` and `summary_json` are stored as JSON text; `archived` as 0/1.
interface ArticleRow {
  id: string;
  url: string;
  canonical_url: string | null;
  title: string;
  source: string | null;
  author: string | null;
  published_at: string | null;
  added_at: string;
  added_via: string;
  lang_original: string | null;
  full_text: string | null;
  summary_ru: string | null;
  summary_en: string | null;
  summary_json: string | null;
  tags: string | null;
  status: string;
  archived: number;
  error: string | null;
}

type ArticleRowNoText = Omit<ArticleRow, "full_text">;

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function parseSummaryJsonColumn(raw: string | null): SummaryJson | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SummaryJson;
  } catch {
    return null;
  }
}

function rowToArticle(row: ArticleRow): Article {
  return {
    ...rowToListItem(row),
    full_text: row.full_text,
  };
}

// Projects a full (owner-only) Article down to the shape GET
// /api/articles/:id (public) actually returns — see PublicArticle's doc
// comment in @clipfeed/shared/types for why full_text/error are dropped.
export function toPublicArticle(article: Article): PublicArticle {
  const { full_text: _fullText, error, ...rest } = article;
  return { ...rest, has_error: error !== null };
}

function rowToListItem(row: ArticleRowNoText): ArticleListItem {
  return {
    id: row.id,
    url: row.url,
    canonical_url: row.canonical_url,
    title: row.title,
    source: row.source,
    author: row.author,
    published_at: row.published_at,
    added_at: row.added_at,
    added_via: row.added_via as AddedVia,
    lang_original: row.lang_original,
    summary_ru: row.summary_ru,
    summary_en: row.summary_en,
    summary_json: parseSummaryJsonColumn(row.summary_json),
    tags: parseTags(row.tags),
    status: row.status as ArticleStatus,
    archived: row.archived === 1,
    error: row.error,
  };
}

export async function findArticleIdByUrl(db: D1Database, url: string): Promise<string | null> {
  const row = await db.prepare("SELECT id FROM articles WHERE url = ?").bind(url).first<
    { id: string }
  >();
  return row?.id ?? null;
}

export interface InsertArticleInput {
  id: string;
  url: string;
  title: string;
  source: string | null;
  tags: string[];
  added_via: AddedVia;
  added_at: string;
}

export async function insertPendingArticle(
  db: D1Database,
  input: InsertArticleInput,
): Promise<void> {
  await db.prepare(
    `INSERT INTO articles (id, url, title, source, added_at, added_via, tags, status, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
  ).bind(
    input.id,
    input.url,
    input.title,
    input.source,
    input.added_at,
    input.added_via,
    JSON.stringify(input.tags),
  ).run();
}

export interface PipelineSuccessUpdate {
  full_text: string;
  title: string;
  author: string | null;
  lang_original: string | null;
  summary_ru: string;
  summary_en: string;
  summary_json: SummaryJson;
  tags: string[];
}

export async function markArticleReady(
  db: D1Database,
  id: string,
  update: PipelineSuccessUpdate,
): Promise<void> {
  await db.prepare(
    `UPDATE articles
     SET full_text = ?, title = ?, author = ?, lang_original = ?, summary_ru = ?, summary_en = ?,
         summary_json = ?, tags = ?, status = 'ready', error = NULL
     WHERE id = ?`,
  ).bind(
    update.full_text,
    update.title,
    update.author,
    update.lang_original,
    update.summary_ru,
    update.summary_en,
    JSON.stringify(update.summary_json),
    JSON.stringify(update.tags),
    id,
  ).run();
}

export async function markArticleFailed(db: D1Database, id: string, error: string): Promise<void> {
  await db.prepare(`UPDATE articles SET status = 'failed', error = ? WHERE id = ?`).bind(error, id)
    .run();
}

export async function markArticlePending(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE articles SET status = 'pending', error = NULL WHERE id = ?`).bind(id)
    .run();
}

export async function getArticleById(db: D1Database, id: string): Promise<Article | null> {
  const row = await db.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first<ArticleRow>();
  return row ? rowToArticle(row) : null;
}

export interface ListArticlesParams {
  cursor?: string;
  limit: number;
  tag?: string;
  source?: string;
  q?: string;
  archived?: boolean;
}

export interface ListArticlesResult {
  items: ArticleListItem[];
  next_cursor: string | null;
}

const LIST_COLUMNS =
  "id, url, canonical_url, title, source, author, published_at, added_at, added_via, lang_original, summary_ru, summary_en, summary_json, tags, status, archived, error";

export interface ListQuery {
  sql: string;
  binds: unknown[];
}

// Pure query builder, factored out so cursor pagination + filtering can be
// unit tested without a real D1 binding.
export function buildListQuery(params: ListArticlesParams): ListQuery {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (params.cursor) {
    conditions.push("added_at < ?");
    binds.push(params.cursor);
  }
  if (params.tag) {
    conditions.push("tags LIKE ?");
    binds.push(`%"${params.tag}"%`);
  }
  if (params.source) {
    conditions.push("source = ?");
    binds.push(params.source);
  }
  if (params.q) {
    conditions.push("(title LIKE ? OR summary_ru LIKE ? OR summary_en LIKE ?)");
    const like = `%${params.q}%`;
    binds.push(like, like, like);
  }
  if (params.archived !== undefined) {
    conditions.push("archived = ?");
    binds.push(params.archived ? 1 : 0);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // Fetch one extra row to know whether a next page exists.
  const sql = [`SELECT ${LIST_COLUMNS} FROM articles`, where, "ORDER BY added_at DESC LIMIT ?"]
    .filter(Boolean)
    .join(" ");
  binds.push(params.limit + 1);

  return { sql, binds };
}

export async function listArticles(
  db: D1Database,
  params: ListArticlesParams,
): Promise<ListArticlesResult> {
  const { sql, binds } = buildListQuery(params);
  const result = await db.prepare(sql).bind(...binds).all<ArticleRowNoText>();
  const rows = result.results ?? [];
  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;

  return {
    items: pageRows.map(rowToListItem),
    next_cursor: hasMore ? pageRows[pageRows.length - 1].added_at : null,
  };
}

export interface PatchArticleInput {
  archived?: boolean;
  tags?: string[];
}

export async function patchArticle(
  db: D1Database,
  id: string,
  patch: PatchArticleInput,
): Promise<ArticleListItem | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.archived !== undefined) {
    sets.push("archived = ?");
    binds.push(patch.archived ? 1 : 0);
  }
  if (patch.tags !== undefined) {
    sets.push("tags = ?");
    binds.push(JSON.stringify(patch.tags));
  }

  if (sets.length > 0) {
    binds.push(id);
    await db.prepare(`UPDATE articles SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  }

  const updated = await getArticleById(db, id);
  if (!updated) return null;
  const { full_text: _fullText, ...listItem } = updated;
  return listItem;
}

export async function deleteArticle(db: D1Database, id: string): Promise<boolean> {
  const existing = await db.prepare("SELECT id FROM articles WHERE id = ?").bind(id).first<
    { id: string }
  >();
  if (!existing) return false;
  await db.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  return true;
}
