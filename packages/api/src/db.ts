import "./env.d.ts";
import type {
  AddedVia,
  Article,
  ArticleListItem,
  ArticleStatus,
  FailureClass,
  FaithfulnessJson,
  FaithfulnessVerdict,
  PublicArticle,
  SummaryJson,
} from "@clipfeed/shared/types";
import { classifyFailure } from "../../shared/src/classify-failure.ts";
import { normalizeTags } from "./tags.ts";

// Raw D1 row shape — matches migrations/0001_init.sql through 0003_*.sql
// exactly. `tags` and `summary_json` are stored as JSON text; `archived` as
// 0/1.
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
  fail_class: string | null;
  heal_attempts: number;
  faithfulness_verdict: string | null;
  faithfulness_json: string | null;
  faithfulness_checked_at: string | null;
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

function parseFaithfulnessJsonColumn(raw: string | null): FaithfulnessJson | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FaithfulnessJson;
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
// comment in @clipfeed/shared/types for why full_text/error/
// faithfulness_json are dropped (faithfulness_verdict is NOT dropped — the
// caution badge is meant to be visible to every reader, not just the
// owner).
export function toPublicArticle(article: Article): PublicArticle {
  const { full_text: _fullText, error, faithfulness_json: _faithfulnessJson, ...rest } = article;
  return { ...rest, has_error: error !== null };
}

// Same redaction as toPublicArticle, applied to a list row (which never
// had full_text to begin with) — used by GET /api/articles (public) so the
// list endpoint doesn't leak raw error strings the way GET /api/articles/:id
// already avoided (see toPublicArticle above). GET /api/admin/articles
// (owner-only) returns ArticleListItem rows unmodified, error included.
export function toPublicListItem(item: ArticleListItem): PublicArticle {
  const { error, faithfulness_json: _faithfulnessJson, ...rest } = item;
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
    fail_class: row.fail_class as FailureClass | null,
    heal_attempts: row.heal_attempts,
    faithfulness_verdict: row.faithfulness_verdict as FaithfulnessVerdict | null,
    faithfulness_json: parseFaithfulnessJsonColumn(row.faithfulness_json),
    faithfulness_checked_at: row.faithfulness_checked_at,
  };
}

export async function findArticleIdByUrl(db: D1Database, url: string): Promise<string | null> {
  const row = await db.prepare("SELECT id FROM articles WHERE url = ?").bind(url).first<
    { id: string }
  >();
  return row?.id ?? null;
}

// Batch existence check used by the scraper agent's pool-building step to
// drop candidates that are already saved — exact url match, same lookup
// shape as findArticleIdByUrl above, just for many URLs in one query.
export async function findExistingUrls(db: D1Database, urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const placeholders = urls.map(() => "?").join(", ");
  const result = await db.prepare(`SELECT url FROM articles WHERE url IN (${placeholders})`)
    .bind(...urls)
    .all<{ url: string }>();
  return new Set((result.results ?? []).map((row) => row.url));
}

// Used by the ranking step's story-level dedup (see ranking.ts) so the
// agent doesn't re-pick yesterday's story just because a different outlet
// covered it too — different URL, so findExistingUrls above wouldn't catch
// it. Includes every row regardless of status/archived: even a failed or
// archived row means this story was already covered, which is exactly what
// this check is for. `idx_articles_added_at` (see migrations/0001_init.sql)
// keeps this cheap regardless of table size.
export async function findRecentTitles(db: D1Database, sinceIso: string): Promise<string[]> {
  const result = await db.prepare("SELECT title FROM articles WHERE added_at >= ?")
    .bind(sinceIso)
    .all<{ title: string }>();
  return (result.results ?? []).map((row) => row.title);
}

export interface RecentTitleRow {
  id: string;
  title: string;
  added_at: string;
}

// Shared 72h lookback used by every title-based dedup check introduced in
// Task 24: the scraper agent's pre-scrape pool dedup (agent-pool.ts) AND the
// manual/extension/telegram add paths' similar-title 409 (index.ts,
// telegram-webhook.ts) — one constant so the two "what counts as recent"
// definitions can never quietly drift apart. Wider than findRecentTitles'
// 48h window above (used by ranking.ts's post-pick story dedup), which
// intentionally stays narrower/independent.
export const RECENT_TITLES_DEDUP_WINDOW_MS = 72 * 60 * 60 * 1000;

// Used by the scraper agent's pre-scrape pool dedup (see agent-pool.ts,
// Task 24 Part B) and the manual/extension/telegram similar-title 409 check
// (index.ts, telegram-webhook.ts) — unlike findRecentTitles, returns `id`
// too so a dropped/blocked candidate's log line or 409 body can name which
// existing article it matched. Ordered newest-first and capped (default
// 300) for cost: a busy instance could otherwise hand the pool-dedup
// comparison loop an unbounded row count on every single agent run.
const DEFAULT_RECENT_TITLES_LIMIT = 300;

export async function findRecentTitlesForDedup(
  db: D1Database,
  sinceIso: string,
  limit: number = DEFAULT_RECENT_TITLES_LIMIT,
): Promise<RecentTitleRow[]> {
  const result = await db.prepare(
    "SELECT id, title, added_at FROM articles WHERE added_at >= ? ORDER BY added_at DESC LIMIT ?",
  )
    .bind(sinceIso, limit)
    .all<RecentTitleRow>();
  return result.results ?? [];
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
    JSON.stringify(normalizeTags(input.tags)),
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
  // Omitted entirely (not just null) when the faithfulness check is
  // disabled (see faithfulness.ts) — the pipeline must behave EXACTLY as
  // it did before this feature existed in that case, including not
  // touching these columns at all. When the check DID run, verdict can
  // still be null (the judge's output was unparseable even after a
  // retry) — that's a distinct state from "never ran", disambiguated by
  // checkedAt being set.
  faithfulness?: {
    verdict: FaithfulnessVerdict | null;
    json: FaithfulnessJson | null;
    checkedAt: string;
  };
}

export async function markArticleReady(
  db: D1Database,
  id: string,
  update: PipelineSuccessUpdate,
): Promise<void> {
  const sets = [
    "full_text = ?",
    "title = ?",
    "author = ?",
    "lang_original = ?",
    "summary_ru = ?",
    "summary_en = ?",
    "summary_json = ?",
    "tags = ?",
    "status = 'ready'",
    "error = NULL",
    "fail_class = NULL",
    "heal_attempts = 0",
  ];
  const binds: unknown[] = [
    update.full_text,
    update.title,
    update.author,
    update.lang_original,
    update.summary_ru,
    update.summary_en,
    JSON.stringify(update.summary_json),
    JSON.stringify(normalizeTags(update.tags)),
  ];
  if (update.faithfulness) {
    sets.push("faithfulness_verdict = ?", "faithfulness_json = ?", "faithfulness_checked_at = ?");
    binds.push(
      update.faithfulness.verdict,
      update.faithfulness.json ? JSON.stringify(update.faithfulness.json) : null,
      update.faithfulness.checkedAt,
    );
  }
  binds.push(id);

  await db.prepare(`UPDATE articles SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}

// Standalone write for POST /api/admin/articles/:id/reverify — re-runs
// ONLY the faithfulness stage against an already-'ready' article's stored
// full_text/summary_json, so this touches just the 3 faithfulness columns,
// nothing else (no status change, no summary rewrite).
export async function updateFaithfulnessOnly(
  db: D1Database,
  id: string,
  result: { verdict: FaithfulnessVerdict | null; json: FaithfulnessJson | null; checkedAt: string },
): Promise<void> {
  await db.prepare(
    `UPDATE articles SET faithfulness_verdict = ?, faithfulness_json = ?, faithfulness_checked_at = ?
     WHERE id = ?`,
  ).bind(
    result.verdict,
    result.json ? JSON.stringify(result.json) : null,
    result.checkedAt,
    id,
  ).run();
}

export interface FaithfulnessStats {
  pass: number;
  weak: number;
  fail: number;
  null: number;
}

// Powers GET /api/admin/health-report's faithfulness breakdown — counts
// every row (not just 'ready' ones, though only those should ever have a
// non-null verdict in practice) grouped by verdict, with SQL's NULL group
// bucketed under the string key "null" so a JS consumer doesn't have to
// special-case it.
export async function getFaithfulnessStats(db: D1Database): Promise<FaithfulnessStats> {
  const result = await db.prepare(
    `SELECT faithfulness_verdict, COUNT(*) as count FROM articles GROUP BY faithfulness_verdict`,
  ).all<{ faithfulness_verdict: string | null; count: number }>();

  const stats: FaithfulnessStats = { pass: 0, weak: 0, fail: 0, null: 0 };
  for (const row of result.results ?? []) {
    const key = (row.faithfulness_verdict ?? "null") as keyof FaithfulnessStats;
    if (key in stats) stats[key] = row.count;
  }
  return stats;
}

// Belt-and-braces: every call site today composes a guaranteed-non-empty
// reason (an "internal: <stage>: <message>" prefix, a fixed string like
// "daily-limit", etc.), so this coercion shouldn't currently trigger — but
// a 'failed' row with an empty/whitespace error renders as a silent dash in
// the SPA ("Ошибка: —") with zero diagnostic value, and there's no way to
// recover the real cause after the fact. Coercing here means a FUTURE call
// site that forgets this invariant (a new pipeline stage, a manual fix, a
// regression) fails loudly in logs instead of silently in the UI.
//
// Every 'failed' write is classified here (see classify-failure.ts) so
// fail_class is populated immediately, without waiting for the hourly
// healing sweep to backfill it. A PERMANENT failure on an agent-picked
// article (the system chose it, not the owner) auto-archives in the same
// write — burying the agent's own mistake is safe; the owner's manually
// added/captured articles are never auto-archived, see healing.ts.
export async function markArticleFailed(db: D1Database, id: string, error: string): Promise<void> {
  let reason = error.trim();
  if (reason.length === 0) {
    console.error(JSON.stringify({ event: "empty_failure_reason", id }));
    reason = "unknown: no reason recorded (bug)";
  }
  const { class: failClass } = classifyFailure(reason);

  const existing = await db.prepare("SELECT added_via FROM articles WHERE id = ?").bind(id).first<
    { added_via: string }
  >();
  const shouldAutoArchive = failClass === "permanent" && existing?.added_via === "agent";

  await db.prepare(
    `UPDATE articles SET status = 'failed', error = ?, fail_class = ?${
      shouldAutoArchive ? ", archived = 1" : ""
    } WHERE id = ?`,
  ).bind(reason, failClass, id).run();

  if (shouldAutoArchive) {
    console.log(JSON.stringify({ event: "heal_archived", articleId: id }));
  }
}

// --- Healing (see healing.ts for the hourly sweep orchestration) ---

export interface HealableArticle {
  id: string;
  fail_class: FailureClass;
  heal_attempts: number;
}

export interface HealCaps {
  transient: number;
  unknown: number;
}

// Candidates for an automatic retry — PERMANENT is deliberately excluded
// entirely (its cap is 0, meaning "never"), rather than expressed as
// `heal_attempts < 0` which would just always be false; excluding it from
// the query is clearer and doesn't rely on that always-false trick holding.
// `archived = 0`: healing must never touch an archived row (task
// constraint) — an archived article is considered dealt with, whether that
// was the owner's choice or an earlier auto-archive.
export async function listHealableFailedArticles(
  db: D1Database,
  caps: HealCaps,
  maxRows: number,
): Promise<HealableArticle[]> {
  const result = await db.prepare(
    `SELECT id, fail_class, heal_attempts FROM articles
     WHERE status = 'failed' AND archived = 0
       AND (
         (fail_class = 'transient' AND heal_attempts < ?) OR
         (fail_class = 'unknown' AND heal_attempts < ?)
       )
     ORDER BY added_at ASC
     LIMIT ?`,
  ).bind(caps.transient, caps.unknown, maxRows).all<
    { id: string; fail_class: string; heal_attempts: number }
  >();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    fail_class: row.fail_class as FailureClass,
    heal_attempts: row.heal_attempts,
  }));
}

export async function incrementHealAttempts(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE articles SET heal_attempts = heal_attempts + 1 WHERE id = ?").bind(id)
    .run();
}

export interface UnclassifiedFailure {
  id: string;
  url: string;
  error: string | null;
  added_via: string;
}

// 'failed' rows from before the fail_class column existed (migration
// 0003) — the hourly healing sweep classifies these lazily instead of a
// one-off backfill script, since migrations only alter schema, never run
// application logic.
export async function listUnclassifiedFailures(db: D1Database): Promise<UnclassifiedFailure[]> {
  const result = await db.prepare(
    `SELECT id, url, error, added_via FROM articles
     WHERE status = 'failed' AND fail_class IS NULL AND archived = 0`,
  ).all<UnclassifiedFailure>();
  return result.results ?? [];
}

// Classifies a pre-existing failed row and applies the same
// permanent+agent-picked -> auto-archive rule markArticleFailed applies to
// fresh failures — see that function's doc comment for the reasoning.
export async function classifyAndMaybeArchive(
  db: D1Database,
  id: string,
  error: string | null,
  addedVia: string,
): Promise<FailureClass> {
  const { class: failClass } = classifyFailure(error ?? "");
  const shouldAutoArchive = failClass === "permanent" && addedVia === "agent";

  await db.prepare(
    `UPDATE articles SET fail_class = ?${shouldAutoArchive ? ", archived = 1" : ""} WHERE id = ?`,
  ).bind(failClass, id).run();

  if (shouldAutoArchive) {
    console.log(JSON.stringify({ event: "heal_archived", articleId: id }));
  }
  return failClass;
}

export interface FailureStats {
  failed_by_class: Record<string, number>;
  heal_attempts_totals: Record<string, number>;
}

// Powers GET /api/admin/health-report — counts only, no article content.
export async function getFailureStats(db: D1Database): Promise<FailureStats> {
  const result = await db.prepare(
    `SELECT fail_class, COUNT(*) as count, SUM(heal_attempts) as attempts
     FROM articles WHERE status = 'failed' GROUP BY fail_class`,
  ).all<{ fail_class: string | null; count: number; attempts: number | null }>();

  const failed_by_class: Record<string, number> = {};
  const heal_attempts_totals: Record<string, number> = {};
  for (const row of result.results ?? []) {
    const key = row.fail_class ?? "unclassified";
    failed_by_class[key] = row.count;
    heal_attempts_totals[key] = row.attempts ?? 0;
  }
  return { failed_by_class, heal_attempts_totals };
}

// Cheap proxy for "when did the agent last do anything" — the most recent
// added_at among agent-picked articles — rather than standing up dedicated
// last-run tracking state (KV/D1) just for this health-report field.
export async function getLastAgentActivity(db: D1Database): Promise<string | null> {
  const row = await db.prepare(
    `SELECT MAX(added_at) as last_added_at FROM articles WHERE added_via = 'agent'`,
  ).first<{ last_added_at: string | null }>();
  return row?.last_added_at ?? null;
}

// One-time rescue for the summary-validation backlog left behind by a prompt
// recalibration (see summarize.ts's SummarySpec/deriveSummarySpec) — these
// rows failed against the OLD, now-corrected bounds, so they're worth
// retrying regardless of heal_attempts/cap. `error LIKE` (not `classify
// Failure`) because we want exactly this one failure shape, not every
// 'unknown'-classified row. Excludes archived rows for the same reason the
// hourly healing sweep does — an archived row is considered dealt with.
export async function listSummaryValidationFailures(
  db: D1Database,
): Promise<{ id: string }[]> {
  const result = await db.prepare(
    `SELECT id FROM articles
     WHERE status = 'failed' AND archived = 0
       AND error LIKE 'internal: summarize: summary validation%'`,
  ).all<{ id: string }>();
  return result.results ?? [];
}

export async function resetHealAttempts(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE articles SET heal_attempts = 0 WHERE id = ?").bind(id).run();
}

// One-time backfill for POST /api/admin/tags/normalize — insertPendingArticle
// and markArticleReady already normalize on every NEW write (see
// tags.ts), so this only needs to touch pre-existing rows. Idempotent: a
// row whose tags are already normalized produces an identical JSON string
// and is skipped, so `updated` only ever counts rows that actually
// changed, and a second run always returns 0.
export async function backfillNormalizedTags(db: D1Database): Promise<number> {
  const result = await db.prepare("SELECT id, tags FROM articles").all<
    { id: string; tags: string | null }
  >();

  let updated = 0;
  for (const row of result.results ?? []) {
    const current = parseTags(row.tags);
    const normalized = normalizeTags(current);
    if (JSON.stringify(normalized) === JSON.stringify(current)) continue;

    await db.prepare("UPDATE articles SET tags = ? WHERE id = ?")
      .bind(JSON.stringify(normalized), row.id)
      .run();
    updated += 1;
  }
  return updated;
}

// Backstop for a Workers CPU-time kill, which can terminate the isolate
// mid-pipeline without ever raising a catchable exception — see
// runArticlePipeline() in pipeline.ts, whose own try/catch can't cover that
// case. Lazy: no cron dependency, just one cheap UPDATE run at the start of
// every public list fetch, so a stuck row surfaces (as 'failed', with a
// Retry button) the next time anyone loads the feed.
export async function sweepStalePending(
  db: D1Database,
  timeoutMinutes: number,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000).toISOString();
  await db.prepare(
    `UPDATE articles SET status = 'failed', error = 'timeout: processing did not complete'
     WHERE status = 'pending' AND added_at < ?`,
  ).bind(cutoff).run();
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
  "id, url, canonical_url, title, source, author, published_at, added_at, added_via, lang_original, summary_ru, summary_en, summary_json, tags, status, archived, error, fail_class, heal_attempts";

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

export interface DigestArticleInput {
  title_ru: string;
  tldr_ru: string;
}

// Articles ready within the given window (see the Telegram morning
// digest) — only the two summary fields the digest formatter actually
// uses; a 'ready' row without a parseable summary_json (shouldn't happen
// in practice, since markArticleReady always sets it) is skipped rather
// than surfaced as a broken bullet.
export async function listRecentReadyArticles(
  db: D1Database,
  sinceIso: string,
): Promise<DigestArticleInput[]> {
  const result = await db.prepare(
    "SELECT summary_json FROM articles WHERE status = 'ready' AND added_at >= ? ORDER BY added_at DESC",
  ).bind(sinceIso).all<{ summary_json: string | null }>();

  const articles: DigestArticleInput[] = [];
  for (const row of result.results ?? []) {
    const summary = parseSummaryJsonColumn(row.summary_json);
    if (summary) {
      articles.push({ title_ru: summary.title_ru, tldr_ru: summary.tldr_ru });
    }
  }
  return articles;
}
