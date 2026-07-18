import "../env.d.ts";

// A hand-rolled D1 test double — not a SQL engine, just enough pattern
// matching to execute the exact statements packages/api/src/db.ts issues.
// Kept in sync with db.ts by hand; if db.ts's queries change shape, extend
// the branches below rather than generalizing this into a real parser.

type FakeRow = Record<string, unknown>;

function likeTest(pattern: string): (value: unknown) => boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
  const re = new RegExp(`^${escaped}$`, "is");
  return (value) => typeof value === "string" && re.test(value);
}

export class FakeD1 implements D1Database {
  rows: FakeRow[] = [];

  prepare(sql: string): D1PreparedStatement {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const execute = (values: unknown[]) => this.execute(normalized, values);
    const query = (values: unknown[]) => this.query(normalized, values);

    function makeStatement(values: unknown[]): D1PreparedStatement {
      return {
        bind(...newValues: unknown[]): D1PreparedStatement {
          return makeStatement(newValues);
        },
        run<T = unknown>(): Promise<D1Result<T>> {
          execute(values);
          return Promise.resolve({ results: [] as T[], success: true, meta: {} });
        },
        all<T = unknown>(): Promise<D1Result<T>> {
          return Promise.resolve({
            results: query(values) as unknown as T[],
            success: true,
            meta: {},
          });
        },
        first<T = unknown>(): Promise<T | null> {
          const results = query(values);
          return Promise.resolve((results[0] as unknown as T) ?? null);
        },
      };
    }

    return makeStatement([]);
  }

  private execute(sql: string, values: unknown[]): void {
    if (sql.startsWith("INSERT INTO articles")) {
      const cols = sql.match(/\(([^)]+)\)\s+VALUES/)![1].split(",").map((c) => c.trim());
      const row: FakeRow = {
        canonical_url: null,
        author: null,
        published_at: null,
        lang_original: null,
        full_text: null,
        summary_ru: null,
        summary_en: null,
        summary_json: null,
        error: null,
      };
      let vi = 0;
      for (const col of cols) {
        row[col] = values[vi++]; // trailing literal columns (status, archived) get undefined here
      }
      row.status = "pending";
      row.archived = 0;
      this.rows.push(row);
      return;
    }

    if (sql.startsWith("UPDATE articles")) {
      const id = values[values.length - 1] as string;
      const row = this.rows.find((r) => r.id === id);
      if (!row) return;

      if (sql.includes("SET full_text = ?")) {
        const [
          full_text,
          title,
          author,
          lang_original,
          summary_ru,
          summary_en,
          summary_json,
          tags,
        ] = values;
        Object.assign(row, {
          full_text,
          title,
          author,
          lang_original,
          summary_ru,
          summary_en,
          summary_json,
          tags,
          status: "ready",
          error: null,
        });
        return;
      }
      if (sql.includes("SET status = 'failed'")) {
        row.status = "failed";
        row.error = values[0];
        return;
      }
      if (sql.includes("SET status = 'pending'")) {
        row.status = "pending";
        row.error = null;
        return;
      }

      // Dynamic PATCH: SET col = ?[, col = ?...] WHERE id = ?
      const setClause = sql.slice("UPDATE articles SET ".length, sql.indexOf(" WHERE"));
      let vi = 0;
      for (const assignment of setClause.split(",")) {
        const m = assignment.trim().match(/^(\w+)\s*=\s*\?$/);
        if (m) row[m[1]] = values[vi++];
      }
      return;
    }

    if (sql.startsWith("DELETE FROM articles")) {
      const id = values[0] as string;
      this.rows = this.rows.filter((r) => r.id !== id);
      return;
    }

    throw new Error(`FakeD1: unsupported statement: ${sql}`);
  }

  private query(sql: string, values: unknown[]): FakeRow[] {
    if (sql === "SELECT id FROM articles WHERE url = ?") {
      const row = this.rows.find((r) => r.url === values[0]);
      return row ? [{ id: row.id }] : [];
    }

    if (sql === "SELECT * FROM articles WHERE id = ?") {
      const row = this.rows.find((r) => r.id === values[0]);
      return row ? [row] : [];
    }

    if (sql === "SELECT id FROM articles WHERE id = ?") {
      const row = this.rows.find((r) => r.id === values[0]);
      return row ? [{ id: row.id }] : [];
    }

    if (sql.startsWith("SELECT id, url, canonical_url")) {
      return this.queryList(sql, values);
    }

    throw new Error(`FakeD1: unsupported query: ${sql}`);
  }

  private queryList(sql: string, values: unknown[]): FakeRow[] {
    const limit = values[values.length - 1] as number;
    let candidates = [...this.rows];

    const whereMatch = sql.match(/WHERE (.+?) ORDER BY/);
    if (whereMatch) {
      let vi = 0;
      for (const clause of whereMatch[1].split(/\s+AND\s+/i)) {
        const trimmed = clause.trim();

        if (trimmed.startsWith("(")) {
          const conds = trimmed.slice(1, -1).split(/\s+OR\s+/i).map((part) => {
            const col = part.trim().match(/^(\w+)/)![1];
            const value = values[vi++] as string;
            return { col, value };
          });
          candidates = candidates.filter((row) =>
            conds.some(({ col, value }) => likeTest(value)(row[col]))
          );
          continue;
        }

        const eq = trimmed.match(/^(\w+)\s*=\s*\?$/);
        const lt = trimmed.match(/^(\w+)\s*<\s*\?$/);
        const like = trimmed.match(/^(\w+)\s+LIKE\s+\?$/i);
        const value = values[vi++];

        if (eq) {
          candidates = candidates.filter((row) => row[eq[1]] === value);
        } else if (lt) {
          candidates = candidates.filter((row) => {
            const rowValue = row[lt[1]];
            return typeof rowValue === "string" && typeof value === "string" && rowValue < value;
          });
        } else if (like) {
          candidates = candidates.filter((row) => likeTest(value as string)(row[like[1]]));
        }
      }
    }

    candidates.sort((a, b) => (b.added_at as string).localeCompare(a.added_at as string));
    return candidates.slice(0, limit);
  }
}
