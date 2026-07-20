import "./env.d.ts";
import { assertEquals } from "@std/assert";
import {
  isLearnedThinHost,
  recordThinHostFailure,
  THIN_HOST_LEARN_THRESHOLD,
} from "./thin-host-learning.ts";
import { FakeKv } from "./testing/fake_kv.ts";

Deno.test("recordThinHostFailure: a single failure does not yet cross the threshold", async () => {
  const kv = new FakeKv();
  await recordThinHostFailure(kv, "https://example.com/thin-post");
  assertEquals(await isLearnedThinHost(kv, "example.com"), false);
});

Deno.test("recordThinHostFailure: a second failure on the same host crosses the threshold", async () => {
  const kv = new FakeKv();
  await recordThinHostFailure(kv, "https://example.com/thin-post-1");
  await recordThinHostFailure(kv, "https://example.com/thin-post-2");
  assertEquals(await isLearnedThinHost(kv, "example.com"), true);
});

Deno.test("recordThinHostFailure: increments a stored numeric count", async () => {
  const kv = new FakeKv();
  await recordThinHostFailure(kv, "https://example.com/a");
  assertEquals(await kv.get("thinhost:example.com"), "1");
  await recordThinHostFailure(kv, "https://example.com/b");
  assertEquals(await kv.get("thinhost:example.com"), "2");
});

Deno.test("recordThinHostFailure: normalizes hostname (lowercase, strips www)", async () => {
  const kv = new FakeKv();
  await recordThinHostFailure(kv, "https://WWW.Example.com/a");
  await recordThinHostFailure(kv, "https://example.com/b");
  assertEquals(await kv.get("thinhost:example.com"), "2");
});

Deno.test("recordThinHostFailure: sets a 30-day TTL", async () => {
  const kv = new FakeKv();
  await recordThinHostFailure(kv, "https://example.com/a");
  assertEquals(kv.ttls.get("thinhost:example.com"), 30 * 24 * 60 * 60);
});

Deno.test("recordThinHostFailure: an unparseable url is a no-op, never throws", async () => {
  const kv = new FakeKv();
  await recordThinHostFailure(kv, "not a url");
  assertEquals(kv.store.size, 0);
});

Deno.test("recordThinHostFailure: different hosts are tracked independently", async () => {
  const kv = new FakeKv();
  await recordThinHostFailure(kv, "https://a.example.com/x");
  await recordThinHostFailure(kv, "https://b.example.com/x");
  assertEquals(await kv.get("thinhost:a.example.com"), "1");
  assertEquals(await kv.get("thinhost:b.example.com"), "1");
});

Deno.test("isLearnedThinHost: false for a host with no recorded failures", async () => {
  const kv = new FakeKv();
  assertEquals(await isLearnedThinHost(kv, "never-seen.com"), false);
});

Deno.test(`isLearnedThinHost: exactly at the threshold (${THIN_HOST_LEARN_THRESHOLD}) is learned`, async () => {
  const kv = new FakeKv();
  await kv.put("thinhost:example.com", String(THIN_HOST_LEARN_THRESHOLD));
  assertEquals(await isLearnedThinHost(kv, "example.com"), true);
});

Deno.test("isLearnedThinHost: one below the threshold is not yet learned", async () => {
  const kv = new FakeKv();
  await kv.put("thinhost:example.com", String(THIN_HOST_LEARN_THRESHOLD - 1));
  assertEquals(await isLearnedThinHost(kv, "example.com"), false);
});
