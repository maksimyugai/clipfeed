import { assertEquals } from "@std/assert";
import { canMutate, classifyMeOutcome } from "./ownerMode.ts";

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
