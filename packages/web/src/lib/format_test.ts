import { assertEquals } from "@std/assert";
import { hostnameFromUrl } from "./format.ts";

Deno.test("hostnameFromUrl: extracts and lowercases the hostname", () => {
  assertEquals(hostnameFromUrl("https://Example.com/path/to/image.jpg"), "example.com");
});

Deno.test("hostnameFromUrl: strips a leading www.", () => {
  assertEquals(hostnameFromUrl("https://www.example.com/image.jpg"), "example.com");
});

Deno.test("hostnameFromUrl: an unparseable URL returns null", () => {
  assertEquals(hostnameFromUrl("not a url"), null);
});
