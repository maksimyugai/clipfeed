import { assertEquals, assertNotEquals } from "@std/assert";
import {
  extractDatabaseId,
  extractKvId,
  patchD1DatabaseId,
  patchKvNamespaceId,
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
