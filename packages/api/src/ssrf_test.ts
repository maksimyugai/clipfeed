import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { assertSafeUrl, safeFetchText, SsrfError } from "./ssrf.ts";

Deno.test("assertSafeUrl: allows public https URL", () => {
  assertSafeUrl(new URL("https://example.com/article"));
});

Deno.test("assertSafeUrl: allows public IPv4 literal", () => {
  assertSafeUrl(new URL("http://8.8.8.8/"));
});

const PRIVATE_URLS = [
  "http://127.0.0.1/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.1.1/",
  "http://169.254.1.1/",
  "http://0.0.0.0/",
  "http://localhost/",
  "http://printer.local/",
  "http://service.internal/",
  "http://[::1]/",
  "http://[fc00::1]/",
  "http://[fe80::1]/",
];

for (const url of PRIVATE_URLS) {
  Deno.test(`assertSafeUrl: rejects ${url}`, () => {
    assertThrows(() => assertSafeUrl(new URL(url)), SsrfError);
  });
}

Deno.test("assertSafeUrl: rejects non-http(s) protocols", () => {
  assertThrows(() => assertSafeUrl(new URL("ftp://example.com/")), SsrfError);
  assertThrows(() => assertSafeUrl(new URL("file:///etc/passwd")), SsrfError);
});

Deno.test("assertSafeUrl: does not falsely flag addresses just outside reserved ranges", () => {
  assertSafeUrl(new URL("http://172.32.0.1/")); // just past 172.16.0.0/12
  assertSafeUrl(new URL("http://11.0.0.1/")); // not 10.0.0.0/8
});

Deno.test("safeFetchText: rejects a redirect into a private address", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    )) as typeof fetch;

  try {
    await assertRejects(() => safeFetchText("https://example.com/"), SsrfError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("safeFetchText: follows a safe redirect and returns the body", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    calls += 1;
    const url = input.toString();
    if (url === "https://example.com/") {
      return Promise.resolve(
        new Response(null, { status: 301, headers: { location: "https://example.com/final" } }),
      );
    }
    return Promise.resolve(new Response("hello", { status: 200 }));
  }) as typeof fetch;

  try {
    const text = await safeFetchText("https://example.com/");
    assertEquals(text, "hello");
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("safeFetchText: enforces the max redirect count", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, { status: 302, headers: { location: "https://example.com/next" } }),
    )) as typeof fetch;

  try {
    await assertRejects(() => safeFetchText("https://example.com/"), SsrfError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("safeFetchText: rejects a response body over the 5MB cap", async () => {
  const originalFetch = globalThis.fetch;
  const bigBody = new Uint8Array(5 * 1024 * 1024 + 1);
  globalThis.fetch =
    (() => Promise.resolve(new Response(bigBody, { status: 200 }))) as typeof fetch;

  try {
    await assertRejects(() => safeFetchText("https://example.com/"), SsrfError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
