import "../env.d.ts";
import { assertEquals } from "@std/assert";
import { fetchRssCandidates, parseFeed } from "./feed-parser.ts";

const RSS2_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Example Feed</title>
    <atom:link href="https://example.com/feed" rel="self" type="application/rss+xml"/>
    <link>https://example.com</link>
    <item>
      <title>Hello &amp; World</title>
      <link>https://example.com/a</link>
      <pubDate>Mon, 01 Jan 2026 12:00:00 GMT</pubDate>
      <description><![CDATA[Some <b>snippet</b> text here.]]></description>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/b</link>
      <comments>https://example.com/b#comments</comments>
      <pubDate>Tue, 02 Jan 2026 08:30:00 GMT</pubDate>
      <description>Plain description without CDATA.</description>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <link href="https://example.com/" rel="alternate"/>
  <link href="https://example.com/atom" rel="self"/>
  <updated>2026-01-01T12:00:00Z</updated>
  <entry>
    <title type="html"><![CDATA[Atom &#8230; Title]]></title>
    <link rel="alternate" type="text/html" href="https://example.com/entry-a"/>
    <updated>2026-01-01T12:00:00Z</updated>
    <published>2026-01-01T11:00:00Z</published>
    <summary>Atom snippet text.</summary>
  </entry>
</feed>`;

const MALFORMED_FIXTURE = `not xml at all <<< this is garbage >>> {}`;

Deno.test("parseFeed: RSS2 — extracts title/link/pubDate/description, decodes entities and CDATA", () => {
  const items = parseFeed(RSS2_FIXTURE);
  assertEquals(items.length, 2);
  assertEquals(items[0].title, "Hello & World");
  assertEquals(items[0].link, "https://example.com/a");
  assertEquals(items[0].publishedAt, new Date("Mon, 01 Jan 2026 12:00:00 GMT").toISOString());
  assertEquals(items[0].snippet, "Some snippet text here.");
});

Deno.test("parseFeed: RSS2 — a plain (non-CDATA) description also decodes correctly", () => {
  const items = parseFeed(RSS2_FIXTURE);
  assertEquals(items[1].title, "Second post");
  assertEquals(items[1].link, "https://example.com/b");
  assertEquals(items[1].snippet, "Plain description without CDATA.");
});

Deno.test("parseFeed: RSS2 — channel-level atom:link and plain <link> never collide", () => {
  const items = parseFeed(RSS2_FIXTURE);
  // If channel-level tags leaked into item parsing, link would be wrong or
  // duplicated items would appear.
  assertEquals(items.map((i) => i.link), ["https://example.com/a", "https://example.com/b"]);
});

Deno.test("parseFeed: Atom — extracts title/link(rel=alternate)/updated/summary, decodes numeric entities", () => {
  const items = parseFeed(ATOM_FIXTURE);
  assertEquals(items.length, 1);
  assertEquals(items[0].title, "Atom … Title");
  assertEquals(items[0].link, "https://example.com/entry-a");
  assertEquals(items[0].publishedAt, "2026-01-01T12:00:00.000Z");
  assertEquals(items[0].snippet, "Atom snippet text.");
});

Deno.test("parseFeed: Atom — picks rel=alternate link, not the first <link> in the entry", () => {
  const withReorderedLinks = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>Title</title>
      <link href="https://example.com/via" rel="via"/>
      <link href="https://example.com/real" rel="alternate"/>
      <updated>2026-01-01T00:00:00Z</updated>
      <summary>x</summary>
    </entry>
  </feed>`;
  const items = parseFeed(withReorderedLinks);
  assertEquals(items[0].link, "https://example.com/real");
});

Deno.test("parseFeed: malformed input never throws — returns an empty list", () => {
  const items = parseFeed(MALFORMED_FIXTURE);
  assertEquals(items, []);
});

Deno.test("parseFeed: items missing a title or link are dropped, not returned as blanks", () => {
  const partial = `<rss><channel>
    <item><title>Has both</title><link>https://example.com/ok</link></item>
    <item><title>No link</title></item>
    <item><link>https://example.com/no-title</link></item>
  </channel></rss>`;
  const items = parseFeed(partial);
  assertEquals(items.length, 1);
  assertEquals(items[0].title, "Has both");
});

Deno.test("parseFeed: snippet is capped at 500 chars", () => {
  const longDesc = "x".repeat(1000);
  const xml =
    `<rss><channel><item><title>T</title><link>https://example.com/x</link><description>${longDesc}</description></item></channel></rss>`;
  const items = parseFeed(xml);
  assertEquals(items[0].snippet.length, 500);
});

// --- fetchRssCandidates: network wrapper ---

Deno.test("fetchRssCandidates: maps parsed items to Candidate shape with sourceId/discoverySource", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(new Response(RSS2_FIXTURE, { status: 200 }))) as typeof fetch;
  try {
    const candidates = await fetchRssCandidates({
      id: "example",
      type: "rss",
      url: "https://feeds.example.com/index",
    });
    assertEquals(candidates.length, 2);
    assertEquals(candidates[0].id, "example-0");
    assertEquals(candidates[0].sourceId, "example");
    assertEquals(candidates[0].discoverySource, "feeds.example.com");
    assertEquals(candidates[0].url, "https://example.com/a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchRssCandidates: non-2xx response throws (caller is responsible for catching)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch;
  try {
    let threw = false;
    try {
      await fetchRssCandidates({ id: "x", type: "rss", url: "https://example.com/feed" });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchRssCandidates: a source with no url returns an empty list", async () => {
  const candidates = await fetchRssCandidates({ id: "x", type: "rss" });
  assertEquals(candidates, []);
});
