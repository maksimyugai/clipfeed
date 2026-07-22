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
        fail_class: null,
        faithfulness_verdict: null,
        faithfulness_json: null,
        faithfulness_checked_at: null,
        embedded_at: null,
        telegram_published_at: null,
      };
      let vi = 0;
      for (const col of cols) {
        row[col] = values[vi++]; // trailing literal columns (status, archived) get undefined here
      }
      row.status = "pending";
      row.archived = 0;
      row.heal_attempts = 0;
      this.rows.push(row);
      return;
    }

    if (sql.startsWith("UPDATE articles SET status = 'failed', error = 'timeout")) {
      const cutoff = values[0] as string;
      for (const row of this.rows) {
        if (row.status === "pending" && (row.added_at as string) < cutoff) {
          row.status = "failed";
          row.error = "timeout: processing did not complete";
        }
      }
      return;
    }

    if (sql.startsWith("UPDATE articles")) {
      const id = values[values.length - 1] as string;
      const row = this.rows.find((r) => r.id === id);
      if (!row) return;

      if (sql.includes("SET full_text = ?")) {
        // markArticleReady's SET clause always starts with these 8
        // `col = ?` assignments, but may append 3 more (faithfulness_*)
        // when the check ran — parse generically instead of a fixed
        // positional destructure so either shape works.
        const setClause = sql.slice("UPDATE articles SET ".length, sql.indexOf(" WHERE"));
        let vi = 0;
        for (const assignment of setClause.split(",")) {
          const m = assignment.trim().match(/^(\w+)\s*=\s*\?$/);
          if (m) row[m[1]] = values[vi++];
        }
        Object.assign(row, { status: "ready", error: null, fail_class: null, heal_attempts: 0 });
        return;
      }
      if (sql.includes("SET status = 'failed'")) {
        row.status = "failed";
        row.error = values[0];
        row.fail_class = values[1];
        if (sql.includes("archived = 1")) row.archived = 1;
        return;
      }
      if (sql.includes("SET status = 'pending'")) {
        // Deliberately leaves error/fail_class untouched — see db.ts's
        // markArticlePending doc comment (Task 26.5's priorViolations
        // plumbing reads them back on the very next processQueueMessage).
        row.status = "pending";
        return;
      }
      if (sql.startsWith("UPDATE articles SET fail_class = ?")) {
        row.fail_class = values[0];
        if (sql.includes("archived = 1")) row.archived = 1;
        return;
      }
      if (sql === "UPDATE articles SET heal_attempts = heal_attempts + 1 WHERE id = ?") {
        row.heal_attempts = (row.heal_attempts as number) + 1;
        return;
      }
      if (sql === "UPDATE articles SET heal_attempts = 0 WHERE id = ?") {
        row.heal_attempts = 0;
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

    if (sql.startsWith("SELECT * FROM articles WHERE id IN")) {
      const idSet = new Set(values as string[]);
      return this.rows.filter((r) => idSet.has(r.id as string));
    }

    if (sql === "SELECT id FROM articles WHERE id = ?") {
      const row = this.rows.find((r) => r.id === values[0]);
      return row ? [{ id: row.id }] : [];
    }

    if (sql === "SELECT id, tags FROM articles") {
      return this.rows.map((r) => ({ id: r.id, tags: r.tags }));
    }

    if (sql === "SELECT added_via FROM articles WHERE id = ?") {
      const row = this.rows.find((r) => r.id === values[0]);
      return row ? [{ added_via: row.added_via }] : [];
    }

    if (
      sql ===
        "SELECT id FROM articles WHERE status = 'failed' AND archived = 0 AND error LIKE 'internal: summarize: summary validation%'"
    ) {
      const test = likeTest("internal: summarize: summary validation%");
      return this.rows
        .filter((r) => r.status === "failed" && r.archived === 0 && test(r.error))
        .map((r) => ({ id: r.id }));
    }

    if (sql.startsWith("SELECT id, fail_class, heal_attempts FROM articles")) {
      const [transientCap, unknownCap, contentCap, maxRows] = values as [
        number,
        number,
        number,
        number,
      ];
      const candidates = this.rows
        .filter((r) =>
          r.status === "failed" && r.archived === 0 &&
          ((r.fail_class === "transient" && (r.heal_attempts as number) < transientCap) ||
            (r.fail_class === "unknown" && (r.heal_attempts as number) < unknownCap) ||
            (r.fail_class === "content" && (r.heal_attempts as number) < contentCap))
        )
        .sort((a, b) => (a.added_at as string).localeCompare(b.added_at as string))
        .slice(0, maxRows);
      return candidates.map((r) => ({
        id: r.id,
        fail_class: r.fail_class,
        heal_attempts: r.heal_attempts,
      }));
    }

    if (sql.startsWith("SELECT id, url, error, added_via FROM articles")) {
      return this.rows
        .filter((r) => r.status === "failed" && r.fail_class === null && r.archived === 0)
        .map((r) => ({ id: r.id, url: r.url, error: r.error, added_via: r.added_via }));
    }

    if (sql === "SELECT MAX(added_at) as last_added_at FROM articles WHERE added_via = 'agent'") {
      const agentRows = this.rows.filter((r) => r.added_via === "agent");
      const lastAddedAt = agentRows.length === 0
        ? null
        : agentRows.map((r) => r.added_at as string).sort().at(-1)!;
      return [{ last_added_at: lastAddedAt }];
    }

    if (sql.startsWith("SELECT fail_class, COUNT(*) as count, SUM(heal_attempts) as attempts")) {
      const groups = new Map<string | null, { count: number; attempts: number }>();
      for (const r of this.rows) {
        if (r.status !== "failed") continue;
        const key = r.fail_class as string | null;
        const entry = groups.get(key) ?? { count: 0, attempts: 0 };
        entry.count += 1;
        entry.attempts += (r.heal_attempts as number) ?? 0;
        groups.set(key, entry);
      }
      return [...groups.entries()].map(([fail_class, { count, attempts }]) => ({
        fail_class,
        count,
        attempts,
      }));
    }

    if (sql.startsWith("SELECT faithfulness_verdict, COUNT(*) as count FROM articles")) {
      const groups = new Map<string | null, number>();
      for (const r of this.rows) {
        const key = r.faithfulness_verdict as string | null;
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      return [...groups.entries()].map(([faithfulness_verdict, count]) => ({
        faithfulness_verdict,
        count,
      }));
    }

    if (sql.startsWith("SELECT url FROM articles WHERE url IN")) {
      const urlSet = new Set(values as string[]);
      return this.rows.filter((r) => urlSet.has(r.url as string)).map((r) => ({ url: r.url }));
    }

    if (sql === "SELECT title FROM articles WHERE added_at >= ?") {
      const since = values[0] as string;
      return this.rows
        .filter((r) => (r.added_at as string) >= since)
        .map((r) => ({ title: r.title }));
    }

    if (
      sql ===
        "SELECT id, title, added_at FROM articles WHERE added_at >= ? ORDER BY added_at DESC LIMIT ?"
    ) {
      const since = values[0] as string;
      const limit = values[1] as number;
      return this.rows
        .filter((r) => (r.added_at as string) >= since)
        .sort((a, b) => (b.added_at as string).localeCompare(a.added_at as string))
        .slice(0, limit)
        .map((r) => ({ id: r.id, title: r.title, added_at: r.added_at }));
    }

    if (sql.startsWith("SELECT id, url, canonical_url")) {
      return this.queryList(sql, values);
    }

    if (
      sql ===
        "SELECT summary_json FROM articles WHERE status = 'ready' AND added_at >= ? ORDER BY added_at DESC"
    ) {
      const since = values[0] as string;
      return this.rows
        .filter((r) => r.status === "ready" && (r.added_at as string) >= since)
        .sort((a, b) => (b.added_at as string).localeCompare(a.added_at as string))
        .map((r) => ({ summary_json: r.summary_json }));
    }

    if (sql.startsWith("SELECT id, summary_json, source, added_via, lang_original, added_at")) {
      const limit = values[0] as number;
      return this.rows
        .filter((r) => r.status === "ready" && r.archived === 0 && r.embedded_at === null)
        .sort((a, b) => (a.added_at as string).localeCompare(b.added_at as string))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          summary_json: r.summary_json,
          source: r.source,
          added_via: r.added_via,
          lang_original: r.lang_original,
          added_at: r.added_at,
        }));
    }

    if (
      sql ===
        "SELECT COUNT(*) as count FROM articles WHERE status = 'ready' AND archived = 0 AND embedded_at IS NULL"
    ) {
      const count = this.rows.filter((r) =>
        r.status === "ready" && r.archived === 0 && r.embedded_at === null
      )
        .length;
      return [{ count }];
    }

    if (
      sql.startsWith("SELECT id, url, source, faithfulness_verdict, summary_json FROM articles")
    ) {
      const since = values[0] as string;
      return this.rows
        .filter((r) =>
          r.status === "ready" && r.archived === 0 && r.telegram_published_at === null &&
          (r.added_at as string) >= since
        )
        .sort((a, b) => (a.added_at as string).localeCompare(b.added_at as string))
        .slice(0, 20)
        .map((r) => ({
          id: r.id,
          url: r.url,
          source: r.source,
          faithfulness_verdict: r.faithfulness_verdict,
          summary_json: r.summary_json,
        }));
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
