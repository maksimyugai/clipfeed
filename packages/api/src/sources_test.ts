import "./env.d.ts";
import { assertEquals } from "@std/assert";
import { fetchAllCandidates, SOURCES } from "./sources.ts";
import type { SourceConfig } from "./agent-types.ts";

const RSS_FIXTURE = `<rss><channel>
  <item><title>A</title><link>https://a.example.com/1</link><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

function stubFetch(handler: (url: string) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((input: string | URL | Request) => Promise.resolve(handler(input.toString()))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("SOURCES: loaded from sources.json, matches the documented ten entries", () => {
  assertEquals(SOURCES.length, 10);
  assertEquals(SOURCES.map((s) => s.id), [
    "hn",
    "arstechnica",
    "theverge",
    "simonwillison",
    "cloudflare",
    "mittr",
    "tomshardware",
    "phoronix",
    "lwn",
    "servethehome",
  ]);
  assertEquals(SOURCES[0].type, "hackernews");
  assertEquals(SOURCES[1].type, "rss");
});

Deno.test("fetchAllCandidates: aggregates candidates across rss + hackernews sources", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("topstories.json")) return new Response(JSON.stringify([1]), { status: 200 });
    if (url.includes("/item/1.json")) {
      return new Response(
        JSON.stringify({
          id: 1,
          type: "story",
          title: "HN story",
          url: "https://hn.example.com/1",
        }),
        { status: 200 },
      );
    }
    return new Response(RSS_FIXTURE, { status: 200 });
  });

  const sources: SourceConfig[] = [
    { id: "hn", type: "hackernews" },
    { id: "feed-a", type: "rss", url: "https://feeds.example.com/a" },
  ];

  try {
    const result = await fetchAllCandidates(sources);
    assertEquals(result.fetched.sort(), ["feed-a", "hn"]);
    assertEquals(result.failed, []);
    assertEquals(result.candidates.length, 2);
    assertEquals(result.candidates.some((c) => c.sourceId === "hn"), true);
    assertEquals(result.candidates.some((c) => c.sourceId === "feed-a"), true);
  } finally {
    restore();
  }
});

Deno.test("fetchAllCandidates: one source failing is logged and skipped, others still succeed", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("broken.example.com")) {
      return new Response("server error", { status: 500 });
    }
    return new Response(RSS_FIXTURE, { status: 200 });
  });

  const sources: SourceConfig[] = [
    { id: "broken", type: "rss", url: "https://broken.example.com/feed" },
    { id: "good", type: "rss", url: "https://feeds.example.com/good" },
  ];

  try {
    const result = await fetchAllCandidates(sources);
    assertEquals(result.fetched, ["good"]);
    assertEquals(result.failed.length, 1);
    assertEquals(result.failed[0].id, "broken");
    assertEquals(result.candidates.length, 1);
  } finally {
    restore();
  }
});

Deno.test("fetchAllCandidates: all sources failing still resolves (never throws)", async () => {
  const restore = stubFetch(() => new Response("nope", { status: 500 }));
  const sources: SourceConfig[] = [{
    id: "broken",
    type: "rss",
    url: "https://broken.example.com/feed",
  }];
  try {
    const result = await fetchAllCandidates(sources);
    assertEquals(result.candidates, []);
    assertEquals(result.fetched, []);
    assertEquals(result.failed.length, 1);
  } finally {
    restore();
  }
});
