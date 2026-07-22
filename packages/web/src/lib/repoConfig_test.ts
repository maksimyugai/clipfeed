import { assertEquals } from "@std/assert";
import { isValidRepoUrl } from "./repoConfig.ts";

Deno.test("isValidRepoUrl - a well-formed https URL is valid", () => {
  assertEquals(isValidRepoUrl("https://github.com/example/clipfeed-fork"), true);
});

Deno.test("isValidRepoUrl - empty string is invalid (the default, unset REPO_URL)", () => {
  assertEquals(isValidRepoUrl(""), false);
});

Deno.test("isValidRepoUrl - null/undefined are invalid", () => {
  assertEquals(isValidRepoUrl(null), false);
  assertEquals(isValidRepoUrl(undefined), false);
});

Deno.test("isValidRepoUrl - an http:// (non-https) URL is invalid", () => {
  assertEquals(isValidRepoUrl("http://github.com/example/clipfeed-fork"), false);
});

Deno.test("isValidRepoUrl - a bare domain with no scheme is invalid", () => {
  assertEquals(isValidRepoUrl("github.com/example/clipfeed-fork"), false);
});

Deno.test("isValidRepoUrl - unparseable garbage is invalid, not a throw", () => {
  assertEquals(isValidRepoUrl("not a url at all"), false);
});
