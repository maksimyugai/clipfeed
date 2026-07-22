import { assertEquals } from "@std/assert";
import { computeLogoResetState, DEFAULT_FEED_RESET_STATE } from "./feedReset.ts";

Deno.test("computeLogoResetState: always resets to keyword mode + non-archived", () => {
  assertEquals(computeLogoResetState(), { searchMode: "keyword", archivedView: false });
});

Deno.test("computeLogoResetState: matches DEFAULT_FEED_RESET_STATE", () => {
  assertEquals(computeLogoResetState(), DEFAULT_FEED_RESET_STATE);
});
