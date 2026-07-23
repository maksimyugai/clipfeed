import "../env.d.ts";
import { assertEquals } from "@std/assert";
import { fetchHackerNewsCandidates } from "./hackernews.ts";

function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((input: string | URL | Request) => Promise.resolve(handler(input.toString()))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

Deno.test("fetchHackerNewsCandidates: keeps only type 'story' items with a url, skips Ask/Show HN text posts", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("topstories.json")) return jsonResponse([1, 2, 3]);
    if (url.includes("/item/1.json")) {
      return jsonResponse({
        id: 1,
        type: "story",
        title: "A real story",
        url: "https://example.com/a",
        time: 1_700_000_000,
      });
    }
    if (url.includes("/item/2.json")) {
      // Ask HN: text post, no url.
      return jsonResponse({
        id: 2,
        type: "story",
        title: "Ask HN: something",
        time: 1_700_000_100,
      });
    }
    if (url.includes("/item/3.json")) {
      return jsonResponse({ id: 3, type: "comment", url: "https://example.com/c" });
    }
    return jsonResponse(null, 404);
  });

  try {
    const candidates = await fetchHackerNewsCandidates("hn");
    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].id, "hn-1");
    assertEquals(candidates[0].sourceId, "hn");
    assertEquals(candidates[0].discoverySource, "news.ycombinator.com");
    assertEquals(candidates[0].title, "A real story");
    assertEquals(candidates[0].url, "https://example.com/a");
    assertEquals(candidates[0].snippet, "");
    assertEquals(candidates[0].publishedAt, new Date(1_700_000_000 * 1000).toISOString());
  } finally {
    restore();
  }
});

Deno.test("fetchHackerNewsCandidates: only fetches the first 30 ids even if the list is longer", async () => {
  const requestedItemIds: number[] = [];
  const restore = stubFetch((url) => {
    if (url.includes("topstories.json")) {
      return jsonResponse(Array.from({ length: 100 }, (_, i) => i + 1));
    }
    const match = url.match(/\/item\/(\d+)\.json/);
    if (match) {
      requestedItemIds.push(Number(match[1]));
      return jsonResponse({
        id: Number(match[1]),
        type: "story",
        url: `https://example.com/${match[1]}`,
      });
    }
    return jsonResponse(null, 404);
  });

  try {
    await fetchHackerNewsCandidates("hn");
    assertEquals(requestedItemIds.length, 30);
    assertEquals(Math.max(...requestedItemIds), 30);
  } finally {
    restore();
  }
});

Deno.test("fetchHackerNewsCandidates: a single item fetch failure doesn't drop the rest of the batch", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("topstories.json")) return jsonResponse([1, 2]);
    if (url.includes("/item/1.json")) {
      throw new Error("network blip");
    }
    if (url.includes("/item/2.json")) {
      return jsonResponse({
        id: 2,
        type: "story",
        title: "Survives",
        url: "https://example.com/2",
      });
    }
    return jsonResponse(null, 404);
  });

  try {
    const candidates = await fetchHackerNewsCandidates("hn");
    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].title, "Survives");
  } finally {
    restore();
  }
});

Deno.test("fetchHackerNewsCandidates: topstories list failure throws (caller's job to catch)", async () => {
  const restore = stubFetch(() => new Response("nope", { status: 500 }));
  try {
    let threw = false;
    try {
      await fetchHackerNewsCandidates("hn");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    restore();
  }
});

Deno.test("fetchHackerNewsCandidates: uses the given sourceId, not a hardcoded 'hn'", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("topstories.json")) return jsonResponse([1]);
    return jsonResponse({ id: 1, type: "story", title: "T", url: "https://example.com/1" });
  });
  try {
    const candidates = await fetchHackerNewsCandidates("news-renamed");
    assertEquals(candidates[0].id, "news-renamed-1");
    assertEquals(candidates[0].sourceId, "news-renamed");
  } finally {
    restore();
  }
});
