import { assertEquals } from "@std/assert";
import { buildOgTags, injectOgTags } from "./og.ts";

Deno.test("buildOgTags: renders all six required tags", () => {
  const tags = buildOgTags(
    { title: "A title", tldr: "A description." },
    "https://example.com/a/id-1",
  );
  assertEquals(tags.includes('<meta property="og:title" content="A title" />'), true);
  assertEquals(tags.includes('<meta property="og:description" content="A description." />'), true);
  assertEquals(
    tags.includes('<meta property="og:url" content="https://example.com/a/id-1" />'),
    true,
  );
  assertEquals(tags.includes('<meta property="og:site_name" content="ClipFeed" />'), true);
  assertEquals(tags.includes('<meta property="og:type" content="article" />'), true);
  assertEquals(tags.includes('<meta name="twitter:card" content="summary" />'), true);
});

Deno.test("buildOgTags: escapes HTML special characters in the title (attribute context)", () => {
  const tags = buildOgTags(
    { title: `Report: <script>alert(1)</script> & "quotes"`, tldr: "fine" },
    "https://example.com/a/id-1",
  );
  assertEquals(tags.includes("<script>"), false);
  assertEquals(
    tags.includes("Report: &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;"),
    true,
  );
});

Deno.test("buildOgTags: escapes HTML special characters in the description", () => {
  const tags = buildOgTags(
    { title: "fine", tldr: `A & B < C > D "E"` },
    "https://example.com/a/id-1",
  );
  assertEquals(tags.includes("A &amp; B &lt; C &gt; D &quot;E&quot;"), true);
});

Deno.test("buildOgTags: escapes the url too (defense in depth, even though it's server-built)", () => {
  const tags = buildOgTags({ title: "t", tldr: "d" }, 'https://example.com/a/"><script>');
  assertEquals(tags.includes("<script>"), false);
});

Deno.test("buildOgTags: truncates a long description to ~200 chars", () => {
  const tldr = "a".repeat(300);
  const tags = buildOgTags({ title: "t", tldr }, "https://example.com/a/id-1");
  const match = tags.match(/og:description" content="([^"]*)"/);
  assertEquals(match !== null, true);
  assertEquals(match![1].length <= 200, true);
  assertEquals(match![1].endsWith("…"), true);
});

Deno.test("buildOgTags: a short description is left untouched, no ellipsis", () => {
  const tags = buildOgTags({ title: "t", tldr: "Short." }, "https://example.com/a/id-1");
  assertEquals(tags.includes('content="Short."'), true);
});

// --- imageUrl (Task 35 Part C §5) ---

Deno.test("buildOgTags: no imageUrl -> no og:image tag, twitter:card is 'summary'", () => {
  const tags = buildOgTags({ title: "t", tldr: "d" }, "https://example.com/a/id-1");
  assertEquals(tags.includes("og:image"), false);
  assertEquals(tags.includes('<meta name="twitter:card" content="summary" />'), true);
});

Deno.test("buildOgTags: imageUrl present -> adds og:image and switches twitter:card to summary_large_image", () => {
  const tags = buildOgTags(
    { title: "t", tldr: "d", imageUrl: "https://example.com/img/id-1" },
    "https://example.com/a/id-1",
  );
  assertEquals(
    tags.includes('<meta property="og:image" content="https://example.com/img/id-1" />'),
    true,
  );
  assertEquals(
    tags.includes('<meta name="twitter:card" content="summary_large_image" />'),
    true,
  );
  assertEquals(tags.includes('<meta name="twitter:card" content="summary" />'), false);
});

Deno.test("buildOgTags: escapes the imageUrl (attribute context)", () => {
  const tags = buildOgTags(
    { title: "t", tldr: "d", imageUrl: 'https://example.com/img/"><script>' },
    "https://example.com/a/id-1",
  );
  assertEquals(tags.includes("<script>"), false);
});

// --- og:image:width / og:image:height (Task 46 Part C) ---

Deno.test("buildOgTags: both dimensions known -> emits og:image:width and og:image:height", () => {
  const tags = buildOgTags(
    {
      title: "t",
      tldr: "d",
      imageUrl: "https://example.com/img/id-1",
      imageWidth: 1200,
      imageHeight: 630,
    },
    "https://example.com/a/id-1",
  );
  assertEquals(tags.includes('<meta property="og:image:width" content="1200" />'), true);
  assertEquals(tags.includes('<meta property="og:image:height" content="630" />'), true);
});

Deno.test("buildOgTags: imageUrl present but dimensions unknown -> no width/height tags", () => {
  const tags = buildOgTags(
    { title: "t", tldr: "d", imageUrl: "https://example.com/img/id-1" },
    "https://example.com/a/id-1",
  );
  assertEquals(tags.includes("og:image:width"), false);
  assertEquals(tags.includes("og:image:height"), false);
});

Deno.test("buildOgTags: no imageUrl at all -> no width/height tags even if somehow passed", () => {
  const tags = buildOgTags(
    { title: "t", tldr: "d", imageWidth: 1200, imageHeight: 630 },
    "https://example.com/a/id-1",
  );
  assertEquals(tags.includes("og:image:width"), false);
  assertEquals(tags.includes("og:image:height"), false);
});

Deno.test("injectOgTags: replaces the <!--OG--> marker with the rendered tags", () => {
  const html = "<head><title>x</title>\n    <!--OG-->\n  </head>";
  const result = injectOgTags(html, '<meta property="og:title" content="t" />');
  assertEquals(result.includes("<!--OG-->"), false);
  assertEquals(result.includes('<meta property="og:title" content="t" />'), true);
});

Deno.test("injectOgTags: a shell with no marker is returned unchanged, never throws", () => {
  const html = "<head><title>x</title></head>";
  assertEquals(injectOgTags(html, "<meta />"), html);
});
