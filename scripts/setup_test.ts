import { assertEquals, assertNotEquals } from "@std/assert";
import {
  extractDatabaseId,
  extractKvId,
  findExistingD1Id,
  findExistingKvId,
  patchD1DatabaseId,
  patchKvNamespaceId,
  queueExistsInList,
  readD1DatabaseId,
  readKvNamespaceId,
} from "./setup.ts";

const FIXTURE_TOML = `name = "clipfeed"
main = "dist/api/index.js"
compatibility_date = "2026-07-01"

[vars]
SUMMARY_MODEL = "claude-haiku-4-5-20251001"
DAILY_SUMMARY_LIMIT = 50

[assets]
directory = "./dist/web"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "clipfeed"
database_id = "PLACEHOLDER"
migrations_dir = "migrations"

[[kv_namespaces]]
binding = "CACHE"
id = "PLACEHOLDER"
`;

const D1_CREATE_OUTPUT = `✅ Successfully created DB 'clipfeed' in region WNAM
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "clipfeed"
database_id = "11111111-2222-3333-4444-555555555555"
`;

const KV_CREATE_OUTPUT = `🌀 Creating namespace with title "clipfeed-CACHE"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "CACHE", id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
`;

Deno.test("readD1DatabaseId: reads the placeholder", () => {
  assertEquals(readD1DatabaseId(FIXTURE_TOML), "PLACEHOLDER");
});

Deno.test("patchD1DatabaseId: replaces only the database_id placeholder", () => {
  const patched = patchD1DatabaseId(FIXTURE_TOML, "11111111-2222-3333-4444-555555555555");
  assertEquals(readD1DatabaseId(patched), "11111111-2222-3333-4444-555555555555");
  // KV placeholder must be untouched.
  assertEquals(readKvNamespaceId(patched), "PLACEHOLDER");
});

Deno.test("patchD1DatabaseId: is a no-op once already patched (idempotent)", () => {
  const once = patchD1DatabaseId(FIXTURE_TOML, "11111111-2222-3333-4444-555555555555");
  const twice = patchD1DatabaseId(once, "should-not-appear");
  assertEquals(twice, once);
});

Deno.test("readKvNamespaceId: reads the placeholder", () => {
  assertEquals(readKvNamespaceId(FIXTURE_TOML), "PLACEHOLDER");
});

Deno.test("patchKvNamespaceId: replaces only the kv_namespaces id, not database_id", () => {
  const patched = patchKvNamespaceId(FIXTURE_TOML, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assertEquals(readKvNamespaceId(patched), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  // D1 placeholder must be untouched — both blocks use the literal string
  // "PLACEHOLDER", so this guards against a regex that's too greedy.
  assertEquals(readD1DatabaseId(patched), "PLACEHOLDER");
});

Deno.test("patchKvNamespaceId: is a no-op once already patched (idempotent)", () => {
  const once = patchKvNamespaceId(FIXTURE_TOML, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const twice = patchKvNamespaceId(once, "should-not-appear");
  assertEquals(twice, once);
});

Deno.test("patching both D1 and KV placeholders together leaves the rest of the file untouched", () => {
  let patched = patchD1DatabaseId(FIXTURE_TOML, "11111111-2222-3333-4444-555555555555");
  patched = patchKvNamespaceId(patched, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assertEquals(readD1DatabaseId(patched), "11111111-2222-3333-4444-555555555555");
  assertEquals(readKvNamespaceId(patched), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assertEquals(patched.includes('name = "clipfeed"'), true);
  assertEquals(patched.includes('SUMMARY_MODEL = "claude-haiku-4-5-20251001"'), true);
  assertNotEquals(patched, FIXTURE_TOML);
});

Deno.test("extractDatabaseId: parses the UUID from `wrangler d1 create` output", () => {
  assertEquals(extractDatabaseId(D1_CREATE_OUTPUT), "11111111-2222-3333-4444-555555555555");
});

Deno.test("extractDatabaseId: returns null when there is no database_id line", () => {
  assertEquals(extractDatabaseId("some unrelated wrangler output"), null);
});

Deno.test("extractKvId: parses the id from `wrangler kv namespace create` output", () => {
  assertEquals(extractKvId(KV_CREATE_OUTPUT), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

Deno.test("extractKvId: returns null when there is no id field", () => {
  assertEquals(extractKvId("some unrelated wrangler output"), null);
});

Deno.test("findExistingD1Id: matches by exact database name", () => {
  const databases = [
    { name: "other-db", uuid: "00000000-0000-0000-0000-000000000000" },
    { name: "clipfeed", uuid: "11111111-2222-3333-4444-555555555555" },
  ];
  assertEquals(findExistingD1Id(databases, "clipfeed"), "11111111-2222-3333-4444-555555555555");
});

Deno.test("findExistingD1Id: returns null when no database matches", () => {
  const databases = [{ name: "other-db", uuid: "00000000-0000-0000-0000-000000000000" }];
  assertEquals(findExistingD1Id(databases, "clipfeed"), null);
});

Deno.test("findExistingKvId: matches the exact binding title, e.g. plain 'CACHE'", () => {
  // Regression test: `wrangler kv namespace create CACHE` titles the
  // namespace exactly "CACHE" (no "clipfeed-" prefix) on wrangler 4.x —
  // an earlier version of this lookup assumed a "<project>-CACHE" prefix
  // and silently never found an existing namespace, causing setup to try
  // (and fail) to create a duplicate every run.
  const namespaces = [
    { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "CACHE" },
    { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", title: "some-other-kv" },
  ];
  assertEquals(findExistingKvId(namespaces, "CACHE"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

Deno.test("findExistingKvId: does not match on a prefixed title", () => {
  const namespaces = [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "clipfeed-CACHE" }];
  assertEquals(findExistingKvId(namespaces, "CACHE"), null);
});

Deno.test("findExistingKvId: returns null when no namespace matches", () => {
  assertEquals(findExistingKvId([], "CACHE"), null);
});

// Real `wrangler queues list` output (4.x) — an ASCII box-drawing table,
// not JSON (unlike `d1 list --json`).
const QUEUES_LIST_OUTPUT =
  `┌──────────────────────────────────┬────────────────────────────┬─────────────────────────────┬─────────────────────────────┬───────────┬───────────┐
│ id                               │ name                       │ created_on                  │ modified_on                 │ producers │ consumers │
├──────────────────────────────────┼────────────────────────────┼─────────────────────────────┼─────────────────────────────┼───────────┼───────────┤
│ e6d2bd58cdf642ebaca5c577685b1654 │ some-other-queue           │ 2026-07-09T15:13:20.561696Z │ 2026-07-09T15:13:20.561696Z │ 1         │ 1         │
├──────────────────────────────────┼────────────────────────────┼─────────────────────────────┼─────────────────────────────┼───────────┼───────────┤
│ 15ef7250faea4132b1a3814d27569438 │ clipfeed-jobs              │ 2026-07-09T15:36:59.050027Z │ 2026-07-09T15:36:59.050027Z │ 1         │ 1         │
└──────────────────────────────────┴────────────────────────────┴─────────────────────────────┴─────────────────────────────┴───────────┴───────────┘
`;

Deno.test("queueExistsInList: finds the queue by exact name in a real `wrangler queues list` table", () => {
  assertEquals(queueExistsInList(QUEUES_LIST_OUTPUT, "clipfeed-jobs"), true);
});

Deno.test("queueExistsInList: returns false when no row's name matches", () => {
  assertEquals(queueExistsInList(QUEUES_LIST_OUTPUT, "some-unrelated-queue"), false);
});

Deno.test("queueExistsInList: does not match a substring of the id or another column", () => {
  assertEquals(queueExistsInList(QUEUES_LIST_OUTPUT, "e6d2bd58cdf642ebaca5c577685b1654"), false);
});

Deno.test("queueExistsInList: returns false for empty/unparseable output", () => {
  assertEquals(queueExistsInList("", "clipfeed-jobs"), false);
  assertEquals(queueExistsInList("some unrelated wrangler output", "clipfeed-jobs"), false);
});
