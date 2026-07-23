import "../env.d.ts";
import { assertEquals } from "@std/assert";
import {
  autoblockSignalWeight,
  clearAutoBlock,
  DEFAULT_AUTOBLOCK_THRESHOLD,
  DEFAULT_AUTOBLOCK_TTL_DAYS,
  isAutoBlocked,
  listAutoBlocks,
  parseAutoblockThreshold,
  parseAutoblockTtlDays,
  recordAutoBlockSignal,
} from "./autoblock.ts";
import { classifyFailure } from "../../../shared/src/classify-failure.ts";
import { FakeKv } from "../testing/fake_kv.ts";

// --- parseAutoblockThreshold / parseAutoblockTtlDays: defensive [vars] parsing ---

Deno.test("parseAutoblockThreshold: undefined/empty falls back to the default, no warning", () => {
  const original = console.warn;
  let warned = false;
  console.warn = () => {
    warned = true;
  };
  try {
    assertEquals(parseAutoblockThreshold(undefined), DEFAULT_AUTOBLOCK_THRESHOLD);
    assertEquals(parseAutoblockThreshold("  "), DEFAULT_AUTOBLOCK_THRESHOLD);
    assertEquals(warned, false);
  } finally {
    console.warn = original;
  }
});

Deno.test("parseAutoblockThreshold: a valid value is used as-is", () => {
  assertEquals(parseAutoblockThreshold("5"), 5);
});

Deno.test("parseAutoblockThreshold: non-numeric or below-1 falls back WITH a warning", () => {
  const original = console.warn;
  let warnCount = 0;
  console.warn = () => {
    warnCount += 1;
  };
  try {
    assertEquals(parseAutoblockThreshold("not-a-number"), DEFAULT_AUTOBLOCK_THRESHOLD);
    assertEquals(parseAutoblockThreshold("0"), DEFAULT_AUTOBLOCK_THRESHOLD);
    assertEquals(warnCount, 2);
  } finally {
    console.warn = original;
  }
});

Deno.test("parseAutoblockTtlDays: undefined/empty falls back to the default, non-numeric falls back with a warning", () => {
  assertEquals(parseAutoblockTtlDays(undefined), DEFAULT_AUTOBLOCK_TTL_DAYS);
  const original = console.warn;
  let warned = false;
  console.warn = () => {
    warned = true;
  };
  try {
    assertEquals(parseAutoblockTtlDays("nope"), DEFAULT_AUTOBLOCK_TTL_DAYS);
    assertEquals(warned, true);
  } finally {
    console.warn = original;
  }
});

// --- autoblockSignalWeight: the signal-scoring rules (Task 33 §7.1) ---

Deno.test("autoblockSignalWeight: insufficient-text and paywalled both contribute +1", () => {
  assertEquals(
    autoblockSignalWeight(classifyFailure("extraction: insufficient text (10 chars)")),
    1,
  );
  assertEquals(
    autoblockSignalWeight(classifyFailure("internal: fetch: upstream responded 403")),
    1,
  );
  assertEquals(
    autoblockSignalWeight(classifyFailure("internal: fetch: upstream responded 402")),
    1,
  );
});

Deno.test("autoblockSignalWeight: transient (5xx/timeout) failures contribute +0 — never auto-block on infra flakiness", () => {
  assertEquals(
    autoblockSignalWeight(classifyFailure("internal: fetch: upstream responded 503")),
    0,
  );
  assertEquals(autoblockSignalWeight(classifyFailure("llm call timed out")), 0);
});

Deno.test("autoblockSignalWeight: other permanent reasons (not_found/removed/ssrf/unfaithful) contribute +0", () => {
  assertEquals(
    autoblockSignalWeight(classifyFailure("internal: fetch: upstream responded 404")),
    0,
  );
  assertEquals(
    autoblockSignalWeight(classifyFailure("internal: fetch: upstream responded 410")),
    0,
  );
});

Deno.test("autoblockSignalWeight: unknown/content classes contribute +0", () => {
  assertEquals(autoblockSignalWeight(classifyFailure("something entirely unrecognized")), 0);
  assertEquals(autoblockSignalWeight(classifyFailure("summary validation: too short")), 0);
});

// --- recordAutoBlockSignal / isAutoBlocked / listAutoBlocks / clearAutoBlock ---
// --- signal accumulation, threshold, TTL refresh ---

Deno.test("recordAutoBlockSignal: a transient failure never accumulates any score", async () => {
  const kv = new FakeKv();
  await recordAutoBlockSignal(
    kv,
    "https://flaky.example/article",
    classifyFailure("internal: fetch: upstream responded 503"),
    3,
    60,
  );
  assertEquals(await kv.get("autostat:flaky.example"), null);
  assertEquals(await isAutoBlocked(kv, "flaky.example"), false);
});

Deno.test("recordAutoBlockSignal: accumulates score across signals, autoblocks once the threshold is reached", async () => {
  const kv = new FakeKv();
  const url = "https://thin.example/article";
  const classification = classifyFailure("extraction: insufficient text (5 chars)");

  await recordAutoBlockSignal(kv, url, classification, 3, 60);
  assertEquals(await isAutoBlocked(kv, "thin.example"), false);
  assertEquals(await kv.get("autostat:thin.example"), "1");

  await recordAutoBlockSignal(kv, url, classification, 3, 60);
  assertEquals(await isAutoBlocked(kv, "thin.example"), false);

  await recordAutoBlockSignal(kv, url, classification, 3, 60);
  assertEquals(await isAutoBlocked(kv, "thin.example"), true);
});

Deno.test("recordAutoBlockSignal: both insufficient-text and paywalled signals accumulate toward the SAME domain score", async () => {
  const kv = new FakeKv();
  const url = "https://mixed.example/article";
  await recordAutoBlockSignal(
    kv,
    url,
    classifyFailure("extraction: insufficient text (5 chars)"),
    2,
    60,
  );
  await recordAutoBlockSignal(
    kv,
    url,
    classifyFailure("internal: fetch: upstream responded 403"),
    2,
    60,
  );
  assertEquals(await isAutoBlocked(kv, "mixed.example"), true);
});

Deno.test("recordAutoBlockSignal: refreshes the autoblock entry's score/reason and preserves the original firstSeen on repeat signals", async () => {
  const kv = new FakeKv();
  const url = "https://thin.example/article";
  const classification = classifyFailure("extraction: insufficient text (5 chars)");
  const now1 = new Date("2026-01-01T00:00:00.000Z");
  const now2 = new Date("2026-01-05T00:00:00.000Z");

  await recordAutoBlockSignal(kv, url, classification, 1, 60, now1);
  const firstEntry = JSON.parse((await kv.get("autoblock:thin.example"))!);
  assertEquals(firstEntry.firstSeen, now1.toISOString());
  assertEquals(firstEntry.score, 1);

  await recordAutoBlockSignal(kv, url, classification, 1, 60, now2);
  const secondEntry = JSON.parse((await kv.get("autoblock:thin.example"))!);
  assertEquals(secondEntry.firstSeen, now1.toISOString());
  assertEquals(secondEntry.score, 2);
});

Deno.test("listAutoBlocks: enumerates active entries, sorted by score descending", async () => {
  const kv = new FakeKv();
  await recordAutoBlockSignal(
    kv,
    "https://low.example/x",
    classifyFailure("extraction: insufficient text (1 chars)"),
    1,
    60,
  );
  await recordAutoBlockSignal(
    kv,
    "https://high.example/x",
    classifyFailure("extraction: insufficient text (1 chars)"),
    1,
    60,
  );
  await recordAutoBlockSignal(
    kv,
    "https://high.example/y",
    classifyFailure("internal: fetch: upstream responded 403"),
    1,
    60,
  );

  const entries = await listAutoBlocks(kv);
  assertEquals(entries.map((e) => e.domain), ["high.example", "low.example"]);
  assertEquals(entries[0].score, 2);
  assertEquals(entries[1].score, 1);
});

Deno.test("clearAutoBlock: removes both the autoblock entry AND its autostat counter — a single new signal doesn't instantly re-block it", async () => {
  const kv = new FakeKv();
  const url = "https://thin.example/article";
  const classification = classifyFailure("extraction: insufficient text (5 chars)");
  await recordAutoBlockSignal(kv, url, classification, 1, 60);
  assertEquals(await isAutoBlocked(kv, "thin.example"), true);

  await clearAutoBlock(kv, "thin.example");
  assertEquals(await isAutoBlocked(kv, "thin.example"), false);
  assertEquals(await kv.get("autostat:thin.example"), null);

  // One more signal after clearing starts the count over at 1, not
  // instantly re-triggering the (still-cleared) block.
  await recordAutoBlockSignal(kv, url, classification, 3, 60);
  assertEquals(await isAutoBlocked(kv, "thin.example"), false);
});

Deno.test("recordAutoBlockSignal: an unparseable URL is a safe no-op", async () => {
  const kv = new FakeKv();
  await recordAutoBlockSignal(
    kv,
    "not-a-url",
    classifyFailure("extraction: insufficient text (5 chars)"),
    1,
    60,
  );
  assertEquals(kv.store.size, 0);
});
