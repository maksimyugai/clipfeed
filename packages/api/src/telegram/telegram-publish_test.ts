import "../env.d.ts";
import { assertEquals } from "@std/assert";
import {
  DEFAULT_PUBLISH_MAX_PER_DAY,
  isPublishEnabled,
  isWithinPublishWindow,
  MAX_PHOTO_BYTES,
  photoDimensionsWithinLimits,
  publishNextArticle,
  runPublishJob,
  utcDayStartIso,
} from "./telegram-publish.ts";
import type { TelegramConfig } from "./telegram-client.ts";
import { FakeD1 } from "../testing/fake_d1.ts";
import { TELEGRAM_SKIPPED_STALE_MARKER } from "../articles/db.ts";

// --- isWithinPublishWindow ---

Deno.test("isWithinPublishWindow: inside the default 4-18 window", () => {
  assertEquals(isWithinPublishWindow(4, undefined, undefined), true);
  assertEquals(isWithinPublishWindow(10, undefined, undefined), true);
  assertEquals(isWithinPublishWindow(17, undefined, undefined), true);
});

Deno.test("isWithinPublishWindow: outside the default window (end is exclusive)", () => {
  assertEquals(isWithinPublishWindow(3, undefined, undefined), false);
  assertEquals(isWithinPublishWindow(18, undefined, undefined), false);
  assertEquals(isWithinPublishWindow(23, undefined, undefined), false);
});

Deno.test("isWithinPublishWindow: a custom window is respected", () => {
  assertEquals(isWithinPublishWindow(1, "0", "6"), true);
  assertEquals(isWithinPublishWindow(6, "0", "6"), false);
  assertEquals(isWithinPublishWindow(23, "0", "6"), false);
});

Deno.test("isWithinPublishWindow: invalid/out-of-range hour values fall back to the documented default", () => {
  assertEquals(isWithinPublishWindow(4, "not-a-number", "18"), true);
  assertEquals(isWithinPublishWindow(3, "not-a-number", "18"), false);
  assertEquals(isWithinPublishWindow(17, "4", "25"), true); // end falls back to default 18
  assertEquals(isWithinPublishWindow(18, "4", "25"), false); // 18 excluded, same as the default
});

// --- isPublishEnabled ---

Deno.test("isPublishEnabled: defaults to true when unset/empty", () => {
  assertEquals(isPublishEnabled(undefined), true);
  assertEquals(isPublishEnabled(""), true);
});

Deno.test("isPublishEnabled: only the literal 'false' disables it", () => {
  assertEquals(isPublishEnabled("false"), false);
  assertEquals(isPublishEnabled("FALSE"), false);
  assertEquals(isPublishEnabled(" false "), false);
  assertEquals(isPublishEnabled("true"), true);
  assertEquals(isPublishEnabled("nope"), true);
});

// --- utcDayStartIso ---

Deno.test("utcDayStartIso: returns midnight UTC of the given instant's own calendar day", () => {
  assertEquals(
    utcDayStartIso(new Date("2026-01-02T10:30:00.000Z").getTime()),
    "2026-01-02T00:00:00.000Z",
  );
  assertEquals(
    utcDayStartIso(new Date("2026-01-02T00:00:00.001Z").getTime()),
    "2026-01-02T00:00:00.000Z",
  );
});

// --- publishNextArticle / runPublishJob ---

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: "test-secret",
  ownerChatId: "999",
};

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
  // Present only for a multipart (sendPhoto) call — the JSON `body` above
  // stays an empty object in that case, since there is no JSON payload.
  form?: { fields: Record<string, string>; photo: { name: string; type: string } | null };
}

function formToCall(form: FormData): TelegramCall["form"] {
  const fields: Record<string, string> = {};
  let photo: { name: string; type: string } | null = null;
  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      photo = { name: value.name, type: value.type };
    } else {
      fields[key] = value as string;
    }
  }
  return { fields, photo };
}

function stubTelegramFetch(): { restore: () => void; calls: TelegramCall[] } {
  const original = globalThis.fetch;
  const calls: TelegramCall[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const match = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
    if (match) {
      if (init?.body instanceof FormData) {
        calls.push({ method: match[1], body: {}, form: formToCall(init.body) });
      } else {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        calls.push({ method: match[1], body });
      }
      return Promise.resolve(Response.json({ ok: true, result: { message_id: 1 } }));
    }
    return Promise.resolve(new Response("not used", { status: 404 }));
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

// Same shape/convention as agent-run-tracker_test.ts's FakeKV — the only
// variant among this codebase's several hand-rolled KV test doubles that
// supports the `expirationTtl` option telegram-publish.ts's cap counter
// relies on.
class FakeKV {
  store = new Map<string, { value: string; expirationTtl?: number }>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key)?.value ?? null);
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

// Matches telegram-publish.ts's (private) publishCountKey convention,
// documented in the README ("Daily post cap") — re-derived here rather than
// imported since the function itself is intentionally not exported.
function publishCountKey(dateIso: string): string {
  return `published:${dateIso.slice(0, 10)}`;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new FakeD1() as unknown as D1Database,
    CACHE: new FakeKV() as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    AI: { run: () => Promise.reject(new Error("AI.run should not be called")) },
    SUMMARY_MODEL: "test-model",
    WORKERS_AI_MODEL: "test-workers-ai-model",
    DAILY_SUMMARY_LIMIT: 50,
    PENDING_TIMEOUT_MIN: 10,
    QUEUE_WAIT_TIMEOUT_MIN: 30,
    PUBLIC_BASE_URL: "https://clipfeed.example.com",
    INTEREST_TOPICS: "testing",
    AGENT_HOUR_UTC: "",
    AGENT_DAILY_PICKS: "10",
    SUMMARY_BODY_TARGET_CHARS: "1200",
    ...overrides,
  };
}

const VALID_SUMMARY = {
  title_ru: "Заголовок",
  title_en: "Title",
  tldr_ru: "Краткое содержание.",
  tldr_en: "Short summary.",
  body_ru: ["Абзац."],
  body_en: ["Paragraph."],
  bullets_ru: ["Пункт один.", "Пункт два."],
  bullets_en: ["Point one.", "Point two."],
  tags: ["tech"],
  lang_original: "en",
};

function insertReadyArticle(
  db: FakeD1,
  overrides: {
    id: string;
    added_at: string;
    faithfulness_verdict?: string | null;
    telegram_published_at?: string | null;
    archived?: number;
    image_key?: string | null;
    image_width?: number | null;
    image_height?: number | null;
  },
) {
  db.rows.push({
    id: overrides.id,
    url: `https://example.com/${overrides.id}`,
    canonical_url: null,
    title: "Some title",
    source: "example.com",
    author: null,
    published_at: null,
    added_at: overrides.added_at,
    added_via: "agent",
    lang_original: "en",
    full_text: "full text",
    summary_ru: "summary",
    summary_en: "summary",
    summary_json: JSON.stringify(VALID_SUMMARY),
    tags: "[]",
    status: "ready",
    archived: overrides.archived ?? 0,
    error: null,
    fail_class: null,
    heal_attempts: 0,
    faithfulness_verdict: overrides.faithfulness_verdict ?? null,
    faithfulness_json: null,
    faithfulness_checked_at: null,
    embedded_at: null,
    telegram_published_at: overrides.telegram_published_at ?? null,
    image_key: overrides.image_key ?? null,
    image_width: overrides.image_width ?? null,
    image_height: overrides.image_height ?? null,
  });
}

// Fixed reference instant used throughout — "today" per every test below is
// 2026-01-02, "yesterday" is 2026-01-01. Using injected nowMs (rather than
// hoursAgo()-style real-clock-relative helpers, which the old 48h-window
// tests used) is required now that selection is scoped to a UTC calendar
// day: whether a timestamp counts as "today" depends on the wall clock at
// test-run time under a relative helper, which is exactly the kind of
// flakiness a fixed instant avoids.
const NOW_MS = new Date("2026-01-02T10:00:00.000Z").getTime();
const TODAY_EARLY = "2026-01-02T01:00:00.000Z";
const TODAY_LATE = "2026-01-02T05:00:00.000Z";
const YESTERDAY = "2026-01-01T23:00:00.000Z";

Deno.test("publishNextArticle: empty queue -> 'empty', no Telegram call", async () => {
  const stub = stubTelegramFetch();
  try {
    const env = makeEnv();
    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "empty" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: publishes the oldest ready/unpublished/non-archived article added today, sends HTML to the owner chat when no channel is set", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "older", added_at: TODAY_EARLY });
    insertReadyArticle(db, { id: "newer", added_at: TODAY_LATE });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "published", articleId: "older" });

    assertEquals(stub.calls.length, 1);
    assertEquals(stub.calls[0].method, "sendMessage");
    assertEquals(stub.calls[0].body.chat_id, "999");
    assertEquals(stub.calls[0].body.parse_mode, "HTML");
    assertEquals((stub.calls[0].body.text as string).includes("Заголовок"), true);

    const row = db.rows.find((r) => r.id === "older")!;
    assertEquals(typeof row.telegram_published_at, "string");
    const untouched = db.rows.find((r) => r.id === "newer")!;
    assertEquals(untouched.telegram_published_at, null);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: orders candidates oldest-first within the same day (reads the day in agent-pick order)", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "third", added_at: "2026-01-02T09:00:00.000Z" });
    insertReadyArticle(db, { id: "first", added_at: "2026-01-02T01:00:00.000Z" });
    insertReadyArticle(db, { id: "second", added_at: "2026-01-02T05:00:00.000Z" });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "published", articleId: "first" });
  } finally {
    stub.restore();
  }
});

// --- link_preview_options (Task 46 Part B) ---

Deno.test("publishNextArticle: sends link_preview_options pinned to the card URL with prefer_large_media and show_above_text, no disable_web_page_preview", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({ DB: db as unknown as D1Database });

    await publishNextArticle(env, CONFIG, NOW_MS);

    assertEquals(stub.calls.length, 1);
    const body = stub.calls[0].body;
    assertEquals(body.disable_web_page_preview, undefined);
    assertEquals(body.link_preview_options, {
      url: "https://clipfeed.example.com/a/a1",
      prefer_large_media: true,
      show_above_text: true,
    });
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: link_preview_options is omitted entirely when PUBLIC_BASE_URL is unset (no link exists to pin)", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({ DB: db as unknown as D1Database, PUBLIC_BASE_URL: "" });

    await publishNextArticle(env, CONFIG, NOW_MS);

    assertEquals(stub.calls.length, 1);
    assertEquals(stub.calls[0].body.link_preview_options, undefined);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: sends to TELEGRAM_CHANNEL_ID when set, not the owner chat", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({ DB: db as unknown as D1Database, TELEGRAM_CHANNEL_ID: "@my_channel" });

    await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(stub.calls[0].body.chat_id, "@my_channel");
  } finally {
    stub.restore();
  }
});

// --- photoDimensionsWithinLimits (Task 47 Part B §4, pure) ---

Deno.test("photoDimensionsWithinLimits: unknown dimensions (either null) are never disqualified — can't check what we don't know", () => {
  assertEquals(photoDimensionsWithinLimits(null, null), true);
  assertEquals(photoDimensionsWithinLimits(1200, null), true);
  assertEquals(photoDimensionsWithinLimits(null, 630), true);
});

Deno.test("photoDimensionsWithinLimits: a normal photo (sum and ratio well inside limits) passes", () => {
  assertEquals(photoDimensionsWithinLimits(1200, 630), true);
  assertEquals(photoDimensionsWithinLimits(1000, 1000), true);
});

Deno.test("photoDimensionsWithinLimits: sum of width+height over 10000 fails", () => {
  assertEquals(photoDimensionsWithinLimits(6000, 5000), false); // sum 11000
  assertEquals(photoDimensionsWithinLimits(5000, 5000), true); // sum exactly 10000
});

Deno.test("photoDimensionsWithinLimits: an aspect ratio steeper than 20:1 fails, regardless of sum", () => {
  assertEquals(photoDimensionsWithinLimits(2000, 90), false); // ratio ~22.2, sum well under 10000
  assertEquals(photoDimensionsWithinLimits(2000, 100), true); // ratio exactly 20
});

Deno.test("photoDimensionsWithinLimits: zero or negative dimensions fail (never a real image)", () => {
  assertEquals(photoDimensionsWithinLimits(0, 100), false);
  assertEquals(photoDimensionsWithinLimits(100, -1), false);
});

// --- sendPhoto path (Task 47 Part B §§1,3,4) ---

function makeFakeImagesBucket(bytes: Uint8Array, contentType: string): R2Bucket {
  return {
    get(_key: string) {
      return Promise.resolve({
        httpMetadata: { contentType },
        arrayBuffer: () => Promise.resolve(bytes.buffer),
      });
    },
    put() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve();
    },
  } as unknown as R2Bucket;
}

Deno.test("publishNextArticle: an article with a stored image within limits publishes via sendPhoto with the bytes as a multipart file and a capped caption", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, {
      id: "a1",
      added_at: TODAY_EARLY,
      image_key: "articles/a1.jpg",
      image_width: 1200,
      image_height: 630,
    });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const env = makeEnv({
      DB: db as unknown as D1Database,
      IMAGES: makeFakeImagesBucket(bytes, "image/jpeg"),
    });

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "published", articleId: "a1" });

    assertEquals(stub.calls.length, 1);
    assertEquals(stub.calls[0].method, "sendPhoto");
    const form = stub.calls[0].form;
    assertEquals(form?.fields.chat_id, "999");
    assertEquals(form?.fields.parse_mode, "HTML");
    assertEquals(form?.photo?.type, "image/jpeg");
    assertEquals((form?.fields.caption ?? "").length <= 1024, true);
    assertEquals(form?.fields.caption?.includes("Заголовок"), true);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: no image_key falls back to sendMessage unchanged", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY, image_key: null });
    const env = makeEnv({ DB: db as unknown as D1Database });

    await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(stub.calls[0].method, "sendMessage");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an image_key set but no IMAGES binding configured falls back to sendMessage", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY, image_key: "articles/a1.jpg" });
    const env = makeEnv({ DB: db as unknown as D1Database }); // no IMAGES

    await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(stub.calls[0].method, "sendMessage");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an R2 get() miss (object gone) falls back to sendMessage, never throws", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY, image_key: "articles/a1.jpg" });
    const bucket = {
      get() {
        return Promise.resolve(null);
      },
    } as unknown as R2Bucket;
    const env = makeEnv({ DB: db as unknown as D1Database, IMAGES: bucket });

    await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(stub.calls[0].method, "sendMessage");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an R2 get() rejection falls back to sendMessage, never throws", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY, image_key: "articles/a1.jpg" });
    const bucket = {
      get() {
        return Promise.reject(new Error("R2 unavailable"));
      },
    } as unknown as R2Bucket;
    const env = makeEnv({ DB: db as unknown as D1Database, IMAGES: bucket });

    await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(stub.calls[0].method, "sendMessage");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: a stored object with a missing/unrecognized content-type falls back to sendMessage", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY, image_key: "articles/a1.jpg" });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      IMAGES: makeFakeImagesBucket(new Uint8Array([1, 2, 3]), "application/octet-stream"),
    });

    await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(stub.calls[0].method, "sendMessage");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an oversized stored image (> 10 MB) falls back to sendMessage", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY, image_key: "articles/a1.jpg" });
    const bytes = new Uint8Array(MAX_PHOTO_BYTES + 1);
    const env = makeEnv({
      DB: db as unknown as D1Database,
      IMAGES: makeFakeImagesBucket(bytes, "image/jpeg"),
    });

    await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(stub.calls[0].method, "sendMessage");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: dimensions violating the sum/ratio limits fall back to sendMessage without ever touching R2", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, {
      id: "a1",
      added_at: TODAY_EARLY,
      image_key: "articles/a1.jpg",
      image_width: 6000,
      image_height: 6000, // sum 12000 > 10000
    });
    let getCalled = false;
    const bucket = {
      get() {
        getCalled = true;
        return Promise.resolve(null);
      },
    } as unknown as R2Bucket;
    const env = makeEnv({ DB: db as unknown as D1Database, IMAGES: bucket });

    await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(stub.calls[0].method, "sendMessage");
    assertEquals(getCalled, false);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: a faithfulness 'fail' verdict is skipped — no Telegram call, but still marked published so the queue advances", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, {
      id: "bad",
      added_at: TODAY_EARLY,
      faithfulness_verdict: "fail",
    });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "skipped-unfaithful", articleId: "bad" });
    assertEquals(stub.calls.length, 0);

    const row = db.rows.find((r) => r.id === "bad")!;
    assertEquals(typeof row.telegram_published_at, "string");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: a faithfulness 'fail' skip is never blocked by, and never counts against, the daily cap", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, {
      id: "bad",
      added_at: TODAY_EARLY,
      faithfulness_verdict: "fail",
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    // Cap already maxed out for today.
    await env.CACHE.put(publishCountKey(utcIso(NOW_MS)), String(DEFAULT_PUBLISH_MAX_PER_DAY));

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "skipped-unfaithful", articleId: "bad" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

function utcIso(ms: number): string {
  return new Date(ms).toISOString();
}

Deno.test("publishNextArticle: an already-published article is never picked again", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, {
      id: "done",
      added_at: TODAY_EARLY,
      telegram_published_at: TODAY_LATE,
    });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "empty" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an archived article is never picked", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "archived", added_at: TODAY_EARLY, archived: 1 });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "empty" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: an article added on a previous UTC day is never picked (today-only selection, Task 37)", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "yesterday", added_at: YESTERDAY });
    const env = makeEnv({ DB: db as unknown as D1Database });

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "empty" });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

// --- Daily post cap (PUBLISH_MAX_PER_DAY) ---

Deno.test("publishNextArticle: increments the KV count only on a real send", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({ DB: db as unknown as D1Database });

    await publishNextArticle(env, CONFIG, NOW_MS);
    const count = await env.CACHE.get(publishCountKey(utcIso(NOW_MS)));
    assertEquals(count, "1");
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: at the default cap (10), the job no-ops with 'cap-reached' — article stays queued, no Telegram call", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({ DB: db as unknown as D1Database });
    await env.CACHE.put(publishCountKey(utcIso(NOW_MS)), String(DEFAULT_PUBLISH_MAX_PER_DAY));

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "cap-reached", maxPerDay: DEFAULT_PUBLISH_MAX_PER_DAY });
    assertEquals(stub.calls.length, 0);

    const row = db.rows.find((r) => r.id === "a1")!;
    assertEquals(row.telegram_published_at, null);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: a custom PUBLISH_MAX_PER_DAY is honored", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({ DB: db as unknown as D1Database, PUBLISH_MAX_PER_DAY: "2" });
    await env.CACHE.put(publishCountKey(utcIso(NOW_MS)), "2");

    const outcome = await publishNextArticle(env, CONFIG, NOW_MS);
    assertEquals(outcome, { kind: "cap-reached", maxPerDay: 2 });
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("publishNextArticle: the cap resets across a UTC day boundary", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    const nextDayMs = new Date("2026-01-03T05:00:00.000Z").getTime();
    insertReadyArticle(db, { id: "a1", added_at: "2026-01-03T01:00:00.000Z" });
    const env = makeEnv({ DB: db as unknown as D1Database });
    // Yesterday's counter was maxed out — must not affect today's.
    await env.CACHE.put(publishCountKey(utcIso(NOW_MS)), String(DEFAULT_PUBLISH_MAX_PER_DAY));

    const outcome = await publishNextArticle(env, CONFIG, nextDayMs);
    assertEquals(outcome, { kind: "published", articleId: "a1" });
  } finally {
    stub.restore();
  }
});

// --- runPublishJob ---

Deno.test("runPublishJob: no-op when Telegram isn't configured", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({ DB: db as unknown as D1Database });
    await runPublishJob(env, NOW_MS);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: no-op when PUBLISH_ENABLED is 'false'", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "false",
    });
    await runPublishJob(env, NOW_MS);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: publishes when Telegram is configured, enabled, and the current hour is inside the window", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "true",
    });
    await runPublishJob(env, NOW_MS);
    assertEquals(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: does nothing outside the publish window, even with a ready article waiting", async () => {
  const stub = stubTelegramFetch();
  try {
    const nowMs = new Date("2026-01-02T02:00:00.000Z").getTime(); // before default 4am start
    const db = new FakeD1();
    insertReadyArticle(db, { id: "a1", added_at: "2026-01-02T00:30:00.000Z" });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "true",
    });
    await runPublishJob(env, nowMs);
    assertEquals(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: a Telegram send failure is swallowed (never throws), and does not mark the article published", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const db = new FakeD1();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 500 }),
      )) as typeof fetch;

    insertReadyArticle(db, { id: "a1", added_at: TODAY_EARLY });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "true",
    });

    await runPublishJob(env, NOW_MS); // must not throw

    const row = db.rows.find((r) => r.id === "a1")!;
    assertEquals(row.telegram_published_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Stale-article sweep (Task 37 §2) ---

Deno.test("runPublishJob: sweeps yesterday-and-older unpublished articles into skipped-stale on every enabled tick, even outside the publish window", async () => {
  const stub = stubTelegramFetch();
  try {
    const nowMs = new Date("2026-01-02T02:00:00.000Z").getTime(); // before default 4am start
    const db = new FakeD1();
    insertReadyArticle(db, { id: "stale", added_at: YESTERDAY });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "true",
    });

    await runPublishJob(env, nowMs);
    assertEquals(stub.calls.length, 0); // still outside the publish window

    const row = db.rows.find((r) => r.id === "stale")!;
    assertEquals(row.telegram_published_at, TELEGRAM_SKIPPED_STALE_MARKER);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: the stale sweep does not run when PUBLISH_ENABLED is 'false'", async () => {
  const stub = stubTelegramFetch();
  try {
    const db = new FakeD1();
    insertReadyArticle(db, { id: "stale", added_at: YESTERDAY });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "false",
    });

    await runPublishJob(env, NOW_MS);

    const row = db.rows.find((r) => r.id === "stale")!;
    assertEquals(row.telegram_published_at, null);
  } finally {
    stub.restore();
  }
});

Deno.test("runPublishJob: sweeping twice is idempotent — the second tick doesn't re-loop or re-mark", async () => {
  const stub = stubTelegramFetch();
  try {
    const nowMs = new Date("2026-01-02T02:00:00.000Z").getTime();
    const db = new FakeD1();
    insertReadyArticle(db, { id: "stale", added_at: YESTERDAY });
    const env = makeEnv({
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_WEBHOOK_SECRET: "s",
      TELEGRAM_OWNER_CHAT_ID: "999",
      PUBLISH_ENABLED: "true",
    });

    await runPublishJob(env, nowMs);
    await runPublishJob(env, nowMs); // must not throw or change anything further

    const row = db.rows.find((r) => r.id === "stale")!;
    assertEquals(row.telegram_published_at, TELEGRAM_SKIPPED_STALE_MARKER);
  } finally {
    stub.restore();
  }
});
