import { assertEquals } from "@std/assert";
import { canMutate, classifyMeOutcome, resolveEffectiveLang } from "./ownerMode.ts";

Deno.test("classifyMeOutcome: pending -> loading", () => {
  assertEquals(classifyMeOutcome("pending"), "loading");
});

Deno.test("classifyMeOutcome: success -> owner", () => {
  assertEquals(classifyMeOutcome("success"), "owner");
});

Deno.test("classifyMeOutcome: error (401 or any other failure) -> visitor", () => {
  assertEquals(classifyMeOutcome("error"), "visitor");
});

Deno.test("canMutate: true only in owner mode", () => {
  assertEquals(canMutate("owner"), true);
  assertEquals(canMutate("visitor"), false);
  assertEquals(canMutate("loading"), false);
});

// Task 35 Part A §4/§6: visitors always get the Russian feed, regardless of
// their stored lang preference — only the owner's own choice ever applies.
Deno.test("resolveEffectiveLang: owner's stored preference passes through unchanged, ru", () => {
  assertEquals(resolveEffectiveLang("ru", true), "ru");
});

Deno.test("resolveEffectiveLang: owner's stored preference passes through unchanged, en", () => {
  assertEquals(resolveEffectiveLang("en", true), "en");
});

Deno.test("resolveEffectiveLang: a non-owner is forced to ru even with 'en' stored", () => {
  assertEquals(resolveEffectiveLang("en", false), "ru");
});

Deno.test("resolveEffectiveLang: a non-owner with 'ru' stored stays ru (no-op, but exercises the same path)", () => {
  assertEquals(resolveEffectiveLang("ru", false), "ru");
});
