// Task 44 Part B: reads the `articles` table's schema straight out of
// `migrations/*.sql` — the single source of truth this repo already
// maintains — instead of duplicating it as a second hand-written list that
// can drift (exactly how a nullable column went missing from FakeD1's
// default-row literal, and how `LIST_COLUMNS` drifted separately in
// db.ts, before Task 34 caught it). Used by FakeD1 for NOT NULL
// enforcement and by its own test suite to assert the default row stays
// complete as new migrations land — a lightweight regex parser is
// reasonable here since the schema itself is simple: one base
// `CREATE TABLE` plus a sequence of single-column
// `ALTER TABLE articles ADD COLUMN` statements, never a multi-column
// constraint beyond NOT NULL/DEFAULT/PRIMARY KEY.

export interface ArticleColumnDef {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
}

const MIGRATIONS_DIR = new URL("../../../../migrations/", import.meta.url);

// Strips `-- ...` line comments BEFORE any comma-splitting — stripping per
// original line matters here, since a trailing comment on a column's own
// line (e.g. `tags TEXT, -- JSON array of strings`) sits right before a
// comma-split boundary; stripping after splitting can merge that comment
// with the following column's text instead (no comma between them, only a
// newline), silently dropping that column.
function stripSqlComments(text: string): string {
  return text.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
}

function parseCreateTable(sql: string): ArticleColumnDef[] {
  const match = stripSqlComments(sql).match(/CREATE TABLE articles \(([\s\S]*?)\)\s*;/);
  if (!match) return [];
  const columns: ArticleColumnDef[] = [];
  for (const rawLine of match[1].split(",")) {
    const line = rawLine.trim();
    if (!line) continue;
    const columnMatch = line.match(/^(\w+)\s+(TEXT|INTEGER)\b(.*)$/i);
    if (!columnMatch) continue; // e.g. a table-level constraint, not a column
    const [, name, , rest] = columnMatch;
    columns.push({
      name,
      notNull: /NOT NULL/i.test(rest) || /PRIMARY KEY/i.test(rest),
      hasDefault: /DEFAULT/i.test(rest),
    });
  }
  return columns;
}

function parseAlterTableAddColumns(sql: string): ArticleColumnDef[] {
  const columns: ArticleColumnDef[] = [];
  for (
    const m of sql.matchAll(
      /ALTER TABLE articles ADD COLUMN (\w+)\s+(TEXT|INTEGER)\b([^;]*);/gi,
    )
  ) {
    const [, name, , rest] = m;
    columns.push({
      name,
      notNull: /NOT NULL/i.test(rest),
      hasDefault: /DEFAULT/i.test(rest),
    });
  }
  return columns;
}

// Reads every migration file in order and accumulates the full current
// `articles` column list. Re-parses from disk on every call (no caching)
// — this only ever runs in tests, where correctness matters far more than
// speed for a handful of small files.
export function parseArticlesSchema(): ArticleColumnDef[] {
  const files = [...Deno.readDirSync(MIGRATIONS_DIR)]
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const columns: ArticleColumnDef[] = [];
  for (const file of files) {
    const text = Deno.readTextFileSync(new URL(file, MIGRATIONS_DIR));
    columns.push(...parseCreateTable(text));
    columns.push(...parseAlterTableAddColumns(text));
  }
  return columns;
}
