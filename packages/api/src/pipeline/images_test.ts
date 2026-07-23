import "../env.d.ts";
import { assertEquals } from "@std/assert";
import {
  downloadAndStoreImage,
  extensionForContentType,
  extractOgImage,
  parseImagesEnabled,
  r2ImageKey,
} from "./images.ts";
import { SsrfError } from "./ssrf.ts";

// --- parseImagesEnabled ---

Deno.test("parseImagesEnabled: undefined defaults to enabled", () => {
  assertEquals(parseImagesEnabled(undefined), true);
});

Deno.test("parseImagesEnabled: only the literal 'false' disables it", () => {
  assertEquals(parseImagesEnabled("false"), false);
  assertEquals(parseImagesEnabled("FALSE"), false);
  assertEquals(parseImagesEnabled(" false "), false);
});

Deno.test("parseImagesEnabled: any other value (including garbage) stays enabled", () => {
  assertEquals(parseImagesEnabled("true"), true);
  assertEquals(parseImagesEnabled(""), true);
  assertEquals(parseImagesEnabled("nonsense"), true);
});

// --- extractOgImage ---

Deno.test("extractOgImage: og:image present, absolute URL", () => {
  const html =
    `<html><head><meta property="og:image" content="https://example.com/photo.jpg" /></head></html>`;
  assertEquals(
    extractOgImage(html, "https://example.com/article"),
    "https://example.com/photo.jpg",
  );
});

Deno.test("extractOgImage: falls back to twitter:image when og:image is absent", () => {
  const html =
    `<html><head><meta name="twitter:image" content="https://example.com/tw.jpg" /></head></html>`;
  assertEquals(extractOgImage(html, "https://example.com/article"), "https://example.com/tw.jpg");
});

Deno.test("extractOgImage: og:image takes precedence over twitter:image when both are present", () => {
  const html = `<html><head>
    <meta property="og:image" content="https://example.com/og.jpg" />
    <meta name="twitter:image" content="https://example.com/tw.jpg" />
  </head></html>`;
  assertEquals(extractOgImage(html, "https://example.com/article"), "https://example.com/og.jpg");
});

Deno.test("extractOgImage: no image tag at all returns null", () => {
  const html = `<html><head><title>no image here</title></head></html>`;
  assertEquals(extractOgImage(html, "https://example.com/article"), null);
});

Deno.test("extractOgImage: a relative image URL is resolved against the article's own URL", () => {
  const html = `<html><head><meta property="og:image" content="/images/photo.jpg" /></head></html>`;
  assertEquals(
    extractOgImage(html, "https://example.com/blog/article"),
    "https://example.com/images/photo.jpg",
  );
});

Deno.test("extractOgImage: a malformed tag value that doesn't resolve against baseUrl returns null", () => {
  const html = `<html><head><meta property="og:image" content="http://[::1" /></head></html>`;
  assertEquals(extractOgImage(html, "https://example.com/article"), null);
});

Deno.test("extractOgImage: an empty content attribute is treated as absent", () => {
  const html = `<html><head><meta property="og:image" content="" /></head></html>`;
  assertEquals(extractOgImage(html, "https://example.com/article"), null);
});

// --- extensionForContentType ---

Deno.test("extensionForContentType: maps every supported raster type", () => {
  assertEquals(extensionForContentType("image/jpeg"), "jpg");
  assertEquals(extensionForContentType("image/png"), "png");
  assertEquals(extensionForContentType("image/webp"), "webp");
  assertEquals(extensionForContentType("image/gif"), "gif");
});

Deno.test("extensionForContentType: is case-insensitive and ignores a charset parameter", () => {
  assertEquals(extensionForContentType("IMAGE/PNG"), "png");
  assertEquals(extensionForContentType("image/jpeg; charset=binary"), "jpg");
});

Deno.test("extensionForContentType: SVG is explicitly rejected (can carry scripts)", () => {
  assertEquals(extensionForContentType("image/svg+xml"), null);
});

Deno.test("extensionForContentType: any non-image or unrecognized type is rejected", () => {
  assertEquals(extensionForContentType("text/html"), null);
  assertEquals(extensionForContentType("application/octet-stream"), null);
  assertEquals(extensionForContentType(""), null);
});

// --- r2ImageKey ---

Deno.test("r2ImageKey: builds the articles/<id>.<ext> key", () => {
  assertEquals(r2ImageKey("abc-123", "png"), "articles/abc-123.png");
});

// --- downloadAndStoreImage ---

interface FakeR2Put {
  key: string;
  contentType: string | undefined;
}

function makeFakeR2(): { bucket: R2Bucket; puts: FakeR2Put[] } {
  const puts: FakeR2Put[] = [];
  const bucket = {
    put(key: string, _value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
      puts.push({ key, contentType: options?.httpMetadata?.contentType });
      return Promise.resolve();
    },
    get() {
      return Promise.resolve(null);
    },
    delete() {
      return Promise.resolve();
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

function stubImageFetch(status: number, headers: Record<string, string>, body: Uint8Array) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(new Response(body as BodyInit, { status, headers }))) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

Deno.test("downloadAndStoreImage: feature disabled (IMAGES_ENABLED=false) writes nothing, even with a binding present", async () => {
  const { bucket, puts } = makeFakeR2();
  const restore = stubImageFetch(200, { "content-type": "image/png" }, new Uint8Array([1]));
  try {
    const result = await downloadAndStoreImage(
      { IMAGES: bucket, IMAGES_ENABLED: "false" } as unknown as Env,
      "article-1",
      "https://example.com/photo.png",
    );
    assertEquals(result, null);
    assertEquals(puts.length, 0);
  } finally {
    restore();
  }
});

Deno.test("downloadAndStoreImage: no IMAGES binding (fork hasn't run setup yet) is a no-op, not a throw", async () => {
  const restore = stubImageFetch(200, { "content-type": "image/png" }, new Uint8Array([1]));
  try {
    const result = await downloadAndStoreImage(
      {} as unknown as Env,
      "article-1",
      "https://example.com/photo.png",
    );
    assertEquals(result, null);
  } finally {
    restore();
  }
});

Deno.test("downloadAndStoreImage: a successful fetch stores the bytes under articles/<id>.<ext> with the content-type", async () => {
  const { bucket, puts } = makeFakeR2();
  const bytes = new Uint8Array([1, 2, 3]);
  const restore = stubImageFetch(200, { "content-type": "image/jpeg" }, bytes);
  try {
    const result = await downloadAndStoreImage(
      { IMAGES: bucket } as unknown as Env,
      "article-1",
      "https://example.com/photo.jpg",
    );
    assertEquals(result, {
      key: "articles/article-1.jpg",
      sourceUrl: "https://example.com/photo.jpg",
    });
    assertEquals(puts.length, 1);
    assertEquals(puts[0].key, "articles/article-1.jpg");
    assertEquals(puts[0].contentType, "image/jpeg");
  } finally {
    restore();
  }
});

Deno.test("downloadAndStoreImage: SVG content-type is rejected, nothing written", async () => {
  const { bucket, puts } = makeFakeR2();
  const restore = stubImageFetch(200, { "content-type": "image/svg+xml" }, new Uint8Array([1]));
  try {
    const result = await downloadAndStoreImage(
      { IMAGES: bucket } as unknown as Env,
      "article-1",
      "https://example.com/evil.svg",
    );
    assertEquals(result, null);
    assertEquals(puts.length, 0);
  } finally {
    restore();
  }
});

Deno.test("downloadAndStoreImage: an SSRF-blocked URL (private redirect) is caught, returns null, never throws", async () => {
  const { bucket, puts } = makeFakeR2();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x" } }),
    )) as typeof fetch;
  try {
    const result = await downloadAndStoreImage(
      { IMAGES: bucket } as unknown as Env,
      "article-1",
      "https://example.com/redirect",
    );
    assertEquals(result, null);
    assertEquals(puts.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("downloadAndStoreImage: an oversized image is rejected via the same SsrfError path, returns null", async () => {
  const { bucket, puts } = makeFakeR2();
  const bigBody = new Uint8Array(5 * 1024 * 1024 + 1);
  const restore = stubImageFetch(200, { "content-type": "image/png" }, bigBody);
  try {
    const result = await downloadAndStoreImage(
      { IMAGES: bucket } as unknown as Env,
      "article-1",
      "https://example.com/huge.png",
    );
    assertEquals(result, null);
    assertEquals(puts.length, 0);
  } finally {
    restore();
  }
});

Deno.test("downloadAndStoreImage: a raw R2 error (put() rejects) is caught, returns null, never throws", async () => {
  const bucket = {
    put() {
      return Promise.reject(new Error("R2 unavailable"));
    },
    get() {
      return Promise.resolve(null);
    },
    delete() {
      return Promise.resolve();
    },
  } as unknown as R2Bucket;
  const restore = stubImageFetch(200, { "content-type": "image/png" }, new Uint8Array([1]));
  try {
    const result = await downloadAndStoreImage(
      { IMAGES: bucket } as unknown as Env,
      "article-1",
      "https://example.com/photo.png",
    );
    assertEquals(result, null);
  } finally {
    restore();
  }
});

Deno.test("downloadAndStoreImage: error reasons are SsrfError-labeled distinctly from generic errors (sanity check on the catch branch)", async () => {
  // Not a behavioral assertion beyond null-return (already covered above) —
  // just confirms SsrfError is the type thrown by the guard this function
  // catches, so a future refactor that stops catching it would be caught by
  // the private-redirect test above turning into an uncaught rejection.
  const { bucket } = makeFakeR2();
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.reject(new SsrfError("blocked host: localhost"))) as typeof fetch;
  try {
    const result = await downloadAndStoreImage(
      { IMAGES: bucket } as unknown as Env,
      "article-1",
      "https://example.com/photo.png",
    );
    assertEquals(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
