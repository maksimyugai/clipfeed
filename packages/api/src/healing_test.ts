import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { runHealingJob } from "./healing.ts";
import { insertPendingArticle, markArticleFailed } from "./db.ts";
import { FakeD1 } from "./testing/fake_d1.ts";
import { FakeKv } from "./testing/fake_kv.ts";
import { FakeQueue } from "./testing/fake_queue.ts";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1(),
    CACHE: new FakeKv(),
    ASSETS: { fetch: () => Promise.resolve(new Response("not used")) },
    AI: { run: () => Promise.reject(new Error("AI.run should not be called in these tests")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    PUBLIC_BASE_URL: "",
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "5",
    DIGEST_HOUR_UTC: "6",
    ANTHROPIC_API_KEY: "test-key",
    ...overrides,
  };
}

async function insertFailed(
  env: Env,
  id: string,
  opts: { url?: string; addedVia?: "agent" | "manual"; error: string; addedAt?: string },
): Promise<void> {
  await insertPendingArticle(env.DB, {
    id,
    url: opts.url ?? `https://example.com/${id}`,
    title: id,
    source: "example.com",
    tags: [],
    added_via: opts.addedVia ?? "manual",
    added_at: opts.addedAt ?? "2026-01-01T00:00:00.000Z",
  });
  await markArticleFailed(env.DB, id, opts.error);
}

function rowsOf(env: Env) {
  return (env.DB as unknown as FakeD1).rows;
}

// --- transient retried up to its cap ---

Deno.test("runHealingJob: a transient failure is retried (re-enqueued, heal_attempts incremented)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "t1", { error: "daily-limit" }); // transient

  await runHealingJob(env);

  assertEquals(jobs.sent, [{ kind: "process", articleId: "t1" }]);
  const row = rowsOf(env).find((r) => r.id === "t1")!;
  assertEquals(row.heal_attempts, 1);
  assertEquals(row.status, "pending"); // markArticlePending before re-enqueue
});

Deno.test("runHealingJob: a transient failure stops being retried once it hits its cap (2)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "t1", { error: "daily-limit" });

  await runHealingJob(env); // attempt 1 -> heal_attempts=1, re-enqueued as pending
  // Simulate the retry failing again.
  await markArticleFailed(env.DB, "t1", "daily-limit");
  await runHealingJob(env); // attempt 2 -> heal_attempts=2, re-enqueued
  await markArticleFailed(env.DB, "t1", "daily-limit");
  await runHealingJob(env); // heal_attempts already at cap (2) -> not retried again

  const row = rowsOf(env).find((r) => r.id === "t1")!;
  assertEquals(row.heal_attempts, 2);
  assertEquals(jobs.sent.length, 2);
});

Deno.test("runHealingJob: an 'unknown' failure gets only 1 attempt (lower cap than transient)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "u1", { error: "internal: summarize: summary validation: too short" });

  await runHealingJob(env); // attempt 1
  await markArticleFailed(env.DB, "u1", "internal: summarize: summary validation: too short");
  await runHealingJob(env); // cap (1) already reached -> no second attempt

  const row = rowsOf(env).find((r) => r.id === "u1")!;
  assertEquals(row.heal_attempts, 1);
  assertEquals(jobs.sent.length, 1);
});

Deno.test("runHealingJob: a permanent failure is never retried (cap is 0)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "p1", {
    addedVia: "manual",
    error: "extraction: insufficient text (3 chars)",
  });

  await runHealingJob(env);

  assertEquals(jobs.sent, []);
  const row = rowsOf(env).find((r) => r.id === "p1")!;
  assertEquals(row.heal_attempts, 0);
  assertEquals(row.status, "failed");
});

// --- permanent + added_via classification/archiving ---

Deno.test("runHealingJob: classifies pre-existing (fail_class IS NULL) failed rows and auto-archives a permanent agent pick", async () => {
  const env = makeEnv();
  // Bypass markArticleFailed's immediate classification, simulating a row
  // that predates migration 0003 (fail_class was never set).
  await insertPendingArticle(env.DB, {
    id: "legacy-agent",
    url: "https://xcancel.com/x/status/1",
    title: "legacy-agent",
    source: "xcancel.com",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const row = rowsOf(env).find((r) => r.id === "legacy-agent")!;
  row.status = "failed";
  row.error = "extraction: insufficient text (0 chars)";
  row.fail_class = null;

  await runHealingJob(env);

  const updated = rowsOf(env).find((r) => r.id === "legacy-agent")!;
  assertEquals(updated.fail_class, "permanent");
  assertEquals(updated.archived, 1);
});

Deno.test("runHealingJob: classifies a pre-existing permanent failure on an owner-added row WITHOUT auto-archiving it", async () => {
  const env = makeEnv();
  await insertPendingArticle(env.DB, {
    id: "legacy-manual",
    url: "https://example.com/gone",
    title: "legacy-manual",
    source: "example.com",
    tags: [],
    added_via: "manual",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const row = rowsOf(env).find((r) => r.id === "legacy-manual")!;
  row.status = "failed";
  row.error = "internal: fetch: upstream responded 404";
  row.fail_class = null;

  await runHealingJob(env);

  const updated = rowsOf(env).find((r) => r.id === "legacy-manual")!;
  assertEquals(updated.fail_class, "permanent");
  assertEquals(updated.archived, 0); // owner's article — surfaced honestly, not buried
});

Deno.test("runHealingJob: classifying a pre-existing insufficient-text failure also teaches the thin-host learned list", async () => {
  const env = makeEnv();
  await insertPendingArticle(env.DB, {
    id: "legacy-thin",
    url: "https://mirror.example/post/1",
    title: "legacy-thin",
    source: "mirror.example",
    tags: [],
    added_via: "agent",
    added_at: "2026-01-01T00:00:00.000Z",
  });
  const row = rowsOf(env).find((r) => r.id === "legacy-thin")!;
  row.status = "failed";
  row.error = "extraction: insufficient text (1 chars)";
  row.fail_class = null;
  // Already had one prior (fresh, already-classified) failure on this host.
  await env.CACHE.put("thinhost:mirror.example", "1");

  await runHealingJob(env);

  assertEquals(await env.CACHE.get("thinhost:mirror.example"), "2");
});

// --- budget / safety limits ---

Deno.test("runHealingJob: never touches an archived row, even if otherwise eligible", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "archived-1", { error: "daily-limit" });
  const row = rowsOf(env).find((r) => r.id === "archived-1")!;
  row.archived = 1;

  await runHealingJob(env);

  assertEquals(jobs.sent, []);
  assertEquals(row.heal_attempts, 0);
});

Deno.test("runHealingJob: re-enqueues through the normal queue path (JOBS), not a direct pipeline bypass", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  await insertFailed(env, "t1", { error: "daily-limit" });

  await runHealingJob(env);

  // The message went through env.JOBS exactly like any other enqueue —
  // the daily summary budget (cost-guard.ts) is enforced later, inside the
  // normal pipeline run this message eventually triggers, not bypassed here.
  assertEquals(jobs.sent.length, 1);
  assertEquals(jobs.sent[0], { kind: "process", articleId: "t1" });
});

Deno.test("runHealingJob: caps at 5 retries per tick even with more eligible articles", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });
  for (let i = 0; i < 7; i++) {
    await insertFailed(env, `many-${i}`, {
      error: "daily-limit",
      addedAt: `2026-01-01T00:0${i}:00.000Z`,
    });
  }

  await runHealingJob(env);

  assertEquals(jobs.sent.length, 5);
});

Deno.test("runHealingJob: with nothing to heal, does nothing (cheap no-op)", async () => {
  const jobs = new FakeQueue();
  const env = makeEnv({ JOBS: jobs });

  await runHealingJob(env);

  assertEquals(jobs.sent, []);
});
