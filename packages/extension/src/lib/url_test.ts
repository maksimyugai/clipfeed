import { assertEquals } from "@std/assert";
import { normalizeServerOrigin } from "./url.ts";

Deno.test("normalizeServerOrigin: accepts an https origin and strips path/query", () => {
  const result = normalizeServerOrigin("https://clipfeed.example.com/some/path?x=1");
  assertEquals(result, { ok: true, origin: "https://clipfeed.example.com" });
});

Deno.test("normalizeServerOrigin: preserves a non-default port", () => {
  const result = normalizeServerOrigin("https://clipfeed.example.com:8443");
  assertEquals(result, { ok: true, origin: "https://clipfeed.example.com:8443" });
});

Deno.test("normalizeServerOrigin: allows http for localhost", () => {
  const result = normalizeServerOrigin("http://localhost:8787/");
  assertEquals(result, { ok: true, origin: "http://localhost:8787" });
});

Deno.test("normalizeServerOrigin: allows http for 127.0.0.1", () => {
  const result = normalizeServerOrigin("http://127.0.0.1:8787");
  assertEquals(result, { ok: true, origin: "http://127.0.0.1:8787" });
});

Deno.test("normalizeServerOrigin: rejects http for a non-localhost host", () => {
  const result = normalizeServerOrigin("http://clipfeed.example.com");
  assertEquals(result.ok, false);
});

Deno.test("normalizeServerOrigin: rejects an empty string", () => {
  const result = normalizeServerOrigin("   ");
  assertEquals(result.ok, false);
});

Deno.test("normalizeServerOrigin: rejects a non-URL string", () => {
  const result = normalizeServerOrigin("not a url");
  assertEquals(result.ok, false);
});

Deno.test("normalizeServerOrigin: rejects a non-http(s) scheme", () => {
  const result = normalizeServerOrigin("ftp://example.com");
  assertEquals(result.ok, false);
});
