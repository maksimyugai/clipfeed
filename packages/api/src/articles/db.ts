import "../env.d.ts";
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
import { classifyFailure } from "../../../shared/src/classify-failure.ts";
import { normalizeTags } from "../lib/tags.ts";

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
  embedded_at: string | null;
  telegram_published_at: string | null;
  en_generated_at: string | null;
  image_key: string | null;
  image_source_url: string | null;
  processing_started_at: string | null;
  faithfulness_enforced_at: string | null;
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
  const {
    full_text: _fullText,
    error,
    faithfulness_json: _faithfulnessJson,
    faithfulness_enforced_at: _faithfulnessEnforcedAt,
    ...rest
  } = article;
  return { ...rest, has_error: error !== null };
}

// Same redaction as toPublicArticle, applied to a list row (which never
// had full_text to begin with) — used by GET /api/articles (public) so the
// list endpoint doesn't leak raw error strings the way GET /api/articles/:id
// already avoided (see toPublicArticle above). GET /api/admin/articles
// (owner-only) returns ArticleListItem rows unmodified, error included.
export function toPublicListItem(item: ArticleListItem): PublicArticle {
  const {
    error,
    faithfulness_json: _faithfulnessJson,
    faithfulness_enforced_at: _faithfulnessEnforcedAt,
    ...rest
  } = item;
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
    embedded_at: row.embedded_at,
    telegram_published_at: row.telegram_published_at,
    en_generated_at: row.en_generated_at,
    image_key: row.image_key,
    image_source_url: row.image_source_url,
    processing_started_at: row.processing_started_at,
    faithfulness_enforced_at: row.faithfulness_enforced_at,
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
  // Task 42 Part C: set only when THIS run actually spent the article's
  // one lifetime remediation attempt (see pipeline.ts's
  // runFaithfulnessStage) — omitted (not just null) otherwise, so a run
  // where enforcement never fired (check disabled, verdict not 'fail',
  // already spent) never touches this column at all.
  faithfulnessEnforcedAt?: string;
}

// Task 35 Part A: a fresh generation is always RU-only (see
// summarize.ts) — this always resets summary_en/en_generated_at to NULL,
// even on a resummarize of a previously-translated article. That's
// deliberate, not a regression of "existing rows keep their EN, no
// backfill, no deletion" (which is about never retroactively stripping EN
// from rows this task doesn't touch): once the RU content is regenerated,
// any EN translation of the OLD content would describe a different summary
// than what's now stored, so it's cleared rather than left stale — the
// owner can re-request POST /api/admin/articles/:id/translate afterward.
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
    "summary_en = NULL",
    "summary_json = ?",
    "tags = ?",
    "status = 'ready'",
    "error = NULL",
    "fail_class = NULL",
    "heal_attempts = 0",
    "en_generated_at = NULL",
  ];
  const binds: unknown[] = [
    update.full_text,
    update.title,
    update.author,
    update.lang_original,
    update.summary_ru,
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
  if (update.faithfulnessEnforcedAt) {
    sets.push("faithfulness_enforced_at = ?");
    binds.push(update.faithfulnessEnforcedAt);
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

// Written after the embed stage successfully upserts into Vectorize (see
// pipeline.ts, embeddings.ts) — a separate write from markArticleReady's
// because embedding runs as a best-effort step AFTER the article is
// already 'ready', never blocking or retrying the pipeline itself.
export async function markEmbedded(db: D1Database, id: string, embeddedAt: string): Promise<void> {
  await db.prepare("UPDATE articles SET embedded_at = ? WHERE id = ?").bind(embeddedAt, id).run();
}

// Task 35 Part A §3: merges a lazily-generated EnglishFields result into an
// already-'ready' article's summary_json and sets both summary_en (the
// rendered markdown, same shape summary_ru already has — see
// renderSummaryMarkdown) and en_generated_at in one write. Called from
// POST /api/admin/articles/:id/translate's queue consumer path (see
// queue.ts) — never touches summary_ru/status/anything else, since the RU
// content is untouched by this operation.
export async function mergeEnglishFields(
  db: D1Database,
  id: string,
  fields: { title_en: string; tldr_en: string; body_en: string[]; bullets_en: string[] },
  summaryEnMarkdown: string,
  generatedAtIso: string,
): Promise<void> {
  const article = await getArticleById(db, id);
  if (!article || !article.summary_json) return;
  const mergedSummaryJson: SummaryJson = { ...article.summary_json, ...fields };
  await db.prepare(
    `UPDATE articles SET summary_json = ?, summary_en = ?, en_generated_at = ? WHERE id = ?`,
  ).bind(JSON.stringify(mergedSummaryJson), summaryEnMarkdown, generatedAtIso, id).run();
}

// Task 35 Part C: records the R2 object key + original source URL for an
// article's optional thumbnail/preview image (see images.ts) — a
// best-effort, standalone write from the pipeline's own image stage, which
// never blocks or fails the article itself (see pipeline.ts). Called only
// on a successful download+store; a failure at any point in that pipeline
// simply leaves both columns null (already their default), so there's no
// separate "clear image" write needed.
export async function markImageStored(
  db: D1Database,
  id: string,
  imageKey: string,
  imageSourceUrl: string,
): Promise<void> {
  await db.prepare(
    "UPDATE articles SET image_key = ?, image_source_url = ? WHERE id = ?",
  ).bind(imageKey, imageSourceUrl, id).run();
}

export interface UnembeddedArticle {
  id: string;
  title_ru: string | null;
  tldr_ru: string | null;
  bullets_ru: string[] | null;
  source: string | null;
  added_via: string;
  lang_original: string | null;
  added_at: string;
}

// Backfill source (POST /api/admin/embeddings/backfill): every 'ready',
// non-archived row with no embedding yet — catches a fresh article whose
// embed stage hasn't run, one whose embed call failed (never fails the
// article itself, see pipeline.ts), and any row saved before this feature
// existed. Archived rows are skipped (same reasoning as the healing sweep:
// an archived article is considered dealt with). `limit` bounds one
// backfill call's batch size; the caller (the endpoint) repeats until
// nothing's left — see buildEmbeddingText in embeddings.ts for how the
// summary fields below become one canonical embedding text.
export async function listUnembeddedArticles(
  db: D1Database,
  limit: number,
): Promise<UnembeddedArticle[]> {
  const result = await db.prepare(
    `SELECT id, summary_json, source, added_via, lang_original, added_at FROM articles
     WHERE status = 'ready' AND archived = 0 AND embedded_at IS NULL
     ORDER BY added_at ASC
     LIMIT ?`,
  ).bind(limit).all<
    {
      id: string;
      summary_json: string | null;
      source: string | null;
      added_via: string;
      lang_original: string | null;
      added_at: string;
    }
  >();
  return (result.results ?? []).map((row) => {
    const summary = parseSummaryJsonColumn(row.summary_json);
    return {
      id: row.id,
      title_ru: summary?.title_ru ?? null,
      tldr_ru: summary?.tldr_ru ?? null,
      bullets_ru: summary?.bullets_ru ?? null,
      source: row.source,
      added_via: row.added_via,
      lang_original: row.lang_original,
      added_at: row.added_at,
    };
  });
}

// Total remaining count for the backfill endpoint's {processed, remaining}
// response — same WHERE clause as listUnembeddedArticles, just COUNT(*)
// instead of a page, so the caller knows whether to call again.
export async function countUnembeddedArticles(db: D1Database): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as count FROM articles WHERE status = 'ready' AND archived = 0 AND embedded_at IS NULL`,
  ).first<{ count: number }>();
  return row?.count ?? 0;
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
  content: number;
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
         (fail_class = 'unknown' AND heal_attempts < ?) OR
         (fail_class = 'content' AND heal_attempts < ?)
       )
     ORDER BY added_at ASC
     LIMIT ?`,
  ).bind(caps.transient, caps.unknown, caps.content, maxRows).all<
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

// Task 34 Part A §3: a 'content'-classified failure (a validateSummary()
// miss — see classify-failure.ts) that has exhausted its heal cap
// (heal_attempts >= HEAL_CAPS.content, see healing.ts) and is STILL
// 'failed' means the model kept producing an invalid summary across every
// informed retry (each one told the exact violation, via
// pipeline.ts's priorViolations) — unlikely to self-resolve without a
// prompt/threshold change, not just another attempt. Owner request: "don't
// show such articles." Scoped to added_via = 'agent' only — the system
// picked this article, so burying its own dead end is safe, same posture
// as the existing permanent+agent-picked rule (markArticleFailed above);
// an owner-added article (manual/extension/telegram) is never auto-archived
// here — the owner chose to save it, so it stays visible as failed for
// them to delete or leave as-is. This supersedes Task 26.5's "do NOT
// auto-archive on 'content'" rule for agent rows specifically; owner rows
// keep that original behavior unchanged.
export async function listExhaustedContentFailures(
  db: D1Database,
  contentCap: number,
): Promise<{ id: string }[]> {
  const result = await db.prepare(
    `SELECT id FROM articles
     WHERE status = 'failed' AND archived = 0 AND added_via = 'agent'
       AND fail_class = 'content' AND heal_attempts >= ?`,
  ).bind(contentCap).all<{ id: string }>();
  return result.results ?? [];
}

export async function archiveContentFailure(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE articles SET archived = ? WHERE id = ?").bind(1, id).run();
  console.log(JSON.stringify({ event: "content_failure_archived", articleId: id }));
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

export interface SourceStats {
  sourceId: string;
  picks: number;
  successes: number;
  failures: number;
}

// Task 33 §8: per-source picks/successes/failures for the health-report's
// curation section. Agent picks are tagged with their source id as the
// first (and only) tag (see agent.ts's insertPendingArticle call), so this
// re-derives per-source counts from `tags` rather than needing a dedicated
// source column — a full scan of agent-added rows, acceptable for an
// occasional admin call, not a hot path.
export async function getSourceStats(db: D1Database): Promise<SourceStats[]> {
  const result = await db.prepare(
    `SELECT tags, status FROM articles WHERE added_via = 'agent'`,
  ).all<{ tags: string | null; status: string }>();

  const bySource = new Map<string, SourceStats>();
  for (const row of result.results ?? []) {
    const sourceId = parseTags(row.tags)[0];
    if (!sourceId) continue;
    const entry = bySource.get(sourceId) ?? { sourceId, picks: 0, successes: 0, failures: 0 };
    entry.picks += 1;
    if (row.status === "ready") entry.successes += 1;
    if (row.status === "failed") entry.failures += 1;
    bySource.set(sourceId, entry);
  }
  return [...bySource.values()].sort((a, b) => b.picks - a.picks);
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
//
// Task 41 Part C: split into two branches that used to be a single
// `added_at`-measured check — that conflated two entirely different failure
// modes. A message can legitimately sit in the queue for a long time under
// backpressure (max_concurrency = 3 in wrangler.toml; a burst of ~30
// same-day enqueues can leave the last few waiting well past what used to
// be a single 10-minute cutoff) — that's not a stuck pipeline, it's a
// row that hasn't started yet, and measuring it from added_at punished it
// for queue wait time it never caused. Now:
//   - PROCESSING branch: processing_started_at IS NOT NULL (a consumer
//     actually picked it up) AND that timestamp is older than
//     pendingTimeoutMinutes -> genuinely stuck mid-pipeline (the CPU-kill
//     case this sweep originally existed for) -> 'timeout: processing did
//     not complete'.
//   - QUEUE-WAIT branch: processing_started_at IS NULL (never reached a
//     consumer) AND added_at is older than queueWaitTimeoutMinutes -> the
//     message itself was lost, or backpressure held it far longer than
//     reasonable -> a distinct error, 'queue: never picked up', so the two
//     modes are never conflated in the stored reason again.
// Both branches re-check `status = 'pending'` at UPDATE time (not from a
// stale read), which is what makes this last-writer-safe against a
// concurrently-completing pipeline: if runArticlePipeline's own
// markArticleReady/markArticleFailed writes land first, status is no longer
// 'pending' and neither branch here matches that row at all; if this sweep
// runs first, the pipeline's own write (unconditional on id) simply lands
// after and wins — either order, the real outcome (ready, or a real error)
// is never clobbered by this generic sweep.
// Task 41 Part C: logs one line per row this sweep is about to flip,
// naming which branch caught it and how long it had actually been waiting —
// the two numbers this whole split exists to stop conflating. Reads the
// candidates just before the UPDATE that acts on them; a row could in
// principle complete (via the real pipeline) in the narrow gap between the
// two, in which case it's logged here but the UPDATE's own `status =
// 'pending'` re-check (see sweepStalePending's doc comment) simply won't
// match it — a harmless, rare over-log, never an incorrect write.
async function logSweepCandidates(
  db: D1Database,
  reason: "processing_timeout" | "queue_wait_timeout",
  processingStarted: boolean,
  column: "processing_started_at" | "added_at",
  cutoff: string,
  now: Date,
): Promise<void> {
  const condition = processingStarted
    ? "status = 'pending' AND processing_started_at IS NOT NULL AND processing_started_at < ?"
    : "status = 'pending' AND processing_started_at IS NULL AND added_at < ?";
  const result = await db.prepare(`SELECT id, ${column} as ts FROM articles WHERE ${condition}`)
    .bind(cutoff)
    .all<{ id: string; ts: string }>();
  for (const row of result.results ?? []) {
    console.warn(JSON.stringify({
      event: "sweep_stale_pending",
      id: row.id,
      reason,
      processingStarted,
      elapsedMs: now.getTime() - Date.parse(row.ts),
    }));
  }
}

export async function sweepStalePending(
  db: D1Database,
  pendingTimeoutMinutes: number,
  queueWaitTimeoutMinutes: number,
  now: Date = new Date(),
): Promise<void> {
  const processingCutoff = new Date(now.getTime() - pendingTimeoutMinutes * 60_000).toISOString();
  const queueWaitCutoff = new Date(now.getTime() - queueWaitTimeoutMinutes * 60_000).toISOString();

  await logSweepCandidates(
    db,
    "processing_timeout",
    true,
    "processing_started_at",
    processingCutoff,
    now,
  );
  await db.prepare(
    `UPDATE articles SET status = 'failed', error = 'timeout: processing did not complete'
     WHERE status = 'pending' AND processing_started_at IS NOT NULL AND processing_started_at < ?`,
  ).bind(processingCutoff).run();

  await logSweepCandidates(db, "queue_wait_timeout", false, "added_at", queueWaitCutoff, now);
  await db.prepare(
    `UPDATE articles SET status = 'failed', error = 'queue: never picked up'
     WHERE status = 'pending' AND processing_started_at IS NULL AND added_at < ?`,
  ).bind(queueWaitCutoff).run();
}

// Deliberately leaves `error`/`fail_class` untouched — a re-run (retry,
// resummarize, or a healing-sweep re-enqueue) reads the row again just
// before its pipeline stage runs (see queue.ts's processQueueMessage), and
// for a 'content'-classified retry that previous error is exactly what
// becomes the informed-retry `priorViolations` text (see pipeline.ts). Both
// columns are always overwritten again once the run reaches a terminal
// state (markArticleReady clears them; markArticleFailed replaces them), so
// leaving the old value visible during the 'pending' window is harmless —
// nothing renders `error` for a pending article.
// Task 41 Part C: also clears processing_started_at back to NULL — a
// retry/resummarize/heal-triggered re-enqueue starts a brand-new "waiting in
// the queue" episode, not a continuation of whatever the previous attempt's
// processing_started_at recorded. Leaving that stale would make the new
// attempt look like it's already been "processing" for as long as the
// entire previous attempt took, which could sweep it to 'failed' again
// almost immediately.
export async function markArticlePending(db: D1Database, id: string): Promise<void> {
  await db.prepare(
    `UPDATE articles SET status = 'pending', processing_started_at = NULL WHERE id = ?`,
  )
    .bind(id).run();
}

// Task 41 Part C: written as the very first action of a queue consumer
// invocation (see index.ts's queue() handler, alongside its queue_received
// log) — before fetch/summarize/anything else runs. This is what lets the
// sweeper (below) tell "still waiting in the queue" apart from "the
// pipeline itself is stuck," instead of measuring both from added_at.
export async function markProcessingStarted(
  db: D1Database,
  id: string,
  startedAtIso: string,
): Promise<void> {
  await db.prepare(`UPDATE articles SET processing_started_at = ? WHERE id = ?`)
    .bind(startedAtIso, id).run();
}

// Task 42 Part C: standalone write for the one branch of
// runFaithfulnessStage that terminates via markArticleFailed (an
// agent-picked article still 'fail' after its one remediation attempt)
// rather than markArticleReady — every other branch persists this same
// column through PipelineSuccessUpdate.faithfulnessEnforcedAt instead, in
// the same write as the rest of the article.
export async function markFaithfulnessEnforced(
  db: D1Database,
  id: string,
  enforcedAtIso: string,
): Promise<void> {
  await db.prepare(`UPDATE articles SET faithfulness_enforced_at = ? WHERE id = ?`)
    .bind(enforcedAtIso, id).run();
}

export async function getArticleById(db: D1Database, id: string): Promise<Article | null> {
  const row = await db.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first<ArticleRow>();
  return row ? rowToArticle(row) : null;
}

// Hydrates a Vectorize search result (a list of article ids, already
// ordered by score) from D1 — see search.ts's searchArticles, which zips
// the returned rows back up with their scores by id. Unordered here on
// purpose (a `WHERE id IN (...)` result has no guaranteed row order); the
// caller reorders. An id with no matching row (the article was deleted
// after being embedded, before the vector was cleaned up, or a race with
// the delete-then-Vectorize-cleanup sequence) is simply absent from the
// result — never an error.
export async function getArticlesByIds(db: D1Database, ids: string[]): Promise<Article[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`).bind(
    ...ids,
  ).all<ArticleRow>();
  return (result.results ?? []).map(rowToArticle);
}

export interface ListArticlesParams {
  cursor?: string;
  limit: number;
  tag?: string;
  source?: string;
  q?: string;
  archived?: boolean;
  // Task 41 Part D: undefined means "all statuses" (the historical default,
  // still used by the owner-only admin list) — the public route always
  // passes 'ready' explicitly, ignoring whatever a caller's own status=
  // query param says (see index.ts's parseArticleListParams).
  status?: ArticleStatus;
}

export interface ListArticlesResult {
  items: ArticleListItem[];
  next_cursor: string | null;
}

// Exported (Task 34) so db_test.ts can assert it stays a superset of every
// ArticleRow column (bar full_text) — this exact list once silently drifted
// out of sync with rowToListItem below, meaning GET /api/articles never
// returned faithfulness_verdict, embedded_at, or telegram_published_at
// against a real D1 despite rowToListItem happily mapping them (undefined
// in production, invisible to FakeD1's tests since it returns whole stored
// rows regardless of the projected column list).
export const LIST_COLUMNS =
  "id, url, canonical_url, title, source, author, published_at, added_at, added_via, lang_original, summary_ru, summary_en, summary_json, tags, status, archived, error, fail_class, heal_attempts, faithfulness_verdict, faithfulness_json, faithfulness_checked_at, embedded_at, telegram_published_at, en_generated_at, image_key, image_source_url, processing_started_at, faithfulness_enforced_at";

export interface ListQuery {
  sql: string;
  binds: unknown[];
}

// Task 32 incident: D1/SQLite's LIKE implementation rejects any pattern
// (including the two wildcard `%` characters) longer than 50 BYTES with
// `D1_ERROR: LIKE or GLOB pattern too complex` — confirmed empirically
// while root-causing a live 500 on multi-word queries: a 48-byte raw `q`
// (-> a 50-byte pattern) succeeded, 49 bytes (-> 51-byte pattern) failed,
// identically for pure-ASCII and Cyrillic input. This is a BYTE limit, not
// a character count — the task spec's "cap at 50 chars" would still
// overflow it for any multi-byte script (a 50-character Cyrillic term is
// ~100 bytes) and silently reintroduce this exact bug for non-Latin
// search terms. MAX_TERM_BYTES is therefore a UTF-8 byte cap, comfortably
// under the 50-byte ceiling once the two wildcard bytes are added back.
const MAX_TERM_BYTES = 45;
const MAX_SEARCH_TERMS = 6;

function truncateToByteLength(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  let end = s.length;
  // Shrink one UTF-16 code unit at a time until the UTF-8 encoding fits —
  // never slices a multi-byte code point in half.
  while (end > 0 && encoder.encode(s.slice(0, end)).length > maxBytes) {
    end--;
  }
  return s.slice(0, end);
}

// Multi-word search semantics (documented in README "Keyword search"):
// AND-of-terms — every whitespace-separated term must appear SOMEWHERE
// across title/summary_ru/summary_en (not necessarily the same field, not
// necessarily as a phrase). Repeated/leading/trailing whitespace collapses
// to nothing (empty tokens dropped); extra terms beyond MAX_SEARCH_TERMS
// are silently dropped rather than erroring — a long query still searches
// meaningfully on its first few words.
export function tokenizeSearchQuery(q: string): string[] {
  return q
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, MAX_SEARCH_TERMS)
    .map((term) => truncateToByteLength(term, MAX_TERM_BYTES));
}

// Escapes SQLite LIKE wildcards so a term containing a literal `%` or `_`
// matches that literal character instead of acting as a wildcard (which
// could otherwise match far more than intended, or — for a pattern built
// entirely from `%`/`_` — degrade toward the pathological-scan case this
// whole length limit exists to guard against). Paired with `ESCAPE '\'` in
// the generated SQL; backslash is escaped first so a literal backslash in
// the term doesn't get misread as introducing one of the other escapes.
export function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
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
    for (const term of tokenizeSearchQuery(params.q)) {
      conditions.push(
        "(title LIKE ? ESCAPE '\\' OR summary_ru LIKE ? ESCAPE '\\' OR summary_en LIKE ? ESCAPE '\\')",
      );
      const like = `%${escapeLikeTerm(term)}%`;
      binds.push(like, like, like);
    }
  }
  if (params.archived !== undefined) {
    conditions.push("archived = ?");
    binds.push(params.archived ? 1 : 0);
  }
  if (params.status) {
    conditions.push("status = ?");
    binds.push(params.status);
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

export interface PublishCandidate {
  id: string;
  url: string;
  source: string | null;
  faithfulness_verdict: FaithfulnessVerdict | null;
  title_ru: string;
  tldr_ru: string;
  bullets_ru: string[];
}

// Oldest un-drip-published 'ready' article, non-archived, added within the
// given window (see telegram-publish.ts's 48h lookback — keeps a
// freshly-enabled drip from working through months of backlog). ORDER BY
// added_at ASC with a small LIMIT rather than a bare LIMIT 1: a row with
// unparseable summary_json (shouldn't happen, see listRecentReadyArticles)
// is skipped in favor of the next-oldest instead of stalling the whole
// drip queue behind one bad row.
export async function getNextPublishCandidate(
  db: D1Database,
  sinceIso: string,
): Promise<PublishCandidate | null> {
  const result = await db.prepare(
    `SELECT id, url, source, faithfulness_verdict, summary_json FROM articles
     WHERE status = 'ready' AND archived = 0 AND telegram_published_at IS NULL AND added_at >= ?
     ORDER BY added_at ASC
     LIMIT 20`,
  ).bind(sinceIso).all<
    {
      id: string;
      url: string;
      source: string | null;
      faithfulness_verdict: string | null;
      summary_json: string | null;
    }
  >();

  for (const row of result.results ?? []) {
    const summary = parseSummaryJsonColumn(row.summary_json);
    if (!summary) continue;
    return {
      id: row.id,
      url: row.url,
      source: row.source,
      faithfulness_verdict: row.faithfulness_verdict as FaithfulnessVerdict | null,
      title_ru: summary.title_ru,
      tldr_ru: summary.tldr_ru,
      bullets_ru: summary.bullets_ru,
    };
  }
  return null;
}

// Marks an article as handled by the drip queue — either a real publish, or
// a faithfulness-'fail' skip (see telegram-publish.ts) that still needs to
// advance the queue past it. Separate from markEmbedded's column for the
// same reason `embedded_at` is separate from `status`: this is a
// best-effort side effect on an already-'ready' article, not a status
// transition.
export async function markTelegramPublished(
  db: D1Database,
  id: string,
  publishedAtIso: string,
): Promise<void> {
  await db.prepare("UPDATE articles SET telegram_published_at = ? WHERE id = ?").bind(
    publishedAtIso,
    id,
  ).run();
}

// Task 37 §2: sentinel value for `telegram_published_at` meaning "this
// article aged out of the drip's today-only window and will never be
// published" — distinct from a real ISO publish timestamp (see
// markTelegramPublished above) but stored in the SAME column rather than a
// new one, since both represent the identical underlying fact as far as
// every query in this codebase cares: "the drip queue is done considering
// this row" (every read of the column only ever checks NULL vs. NOT NULL —
// see getNextPublishCandidate's WHERE clause below and the public/list
// endpoints, none of which parse it as a Date). A dedicated column would
// have needed its own migration and its own NULL-check everywhere this one
// already is checked, for zero behavioral difference.
export const TELEGRAM_SKIPPED_STALE_MARKER = "skipped-stale";

// Sweeps 'ready', non-archived, still-unhandled (telegram_published_at IS
// NULL) rows added before `cutoffIso` into the skipped-stale state — called
// once per enabled tick by telegram-publish.ts's runPublishJob, with "start
// of the current UTC day" as the cutoff (Task 37: publish today's articles
// only, never a growing backlog of yesterday's leftovers). Idempotent and
// loop-safe by construction: once a row's telegram_published_at is set (to
// either this marker or a real publish timestamp), it can never match this
// query's `IS NULL` clause again, so repeating the call with the same or a
// later cutoff always converges toward 0 further rows — there is no
// recursive or self-scheduling step here for a bug to loop on. Returns the
// count actually marked, for the 'publish_skipped_stale' observability log.
export async function markStaleArticlesSkipped(
  db: D1Database,
  cutoffIso: string,
): Promise<number> {
  const result = await db.prepare(
    `SELECT id FROM articles
     WHERE status = 'ready' AND archived = 0 AND telegram_published_at IS NULL AND added_at < ?`,
  ).bind(cutoffIso).all<{ id: string }>();

  const rows = result.results ?? [];
  for (const row of rows) {
    await db.prepare("UPDATE articles SET telegram_published_at = ? WHERE id = ?").bind(
      TELEGRAM_SKIPPED_STALE_MARKER,
      row.id,
    ).run();
  }
  return rows.length;
}
