import { assertEquals } from "@std/assert";
import { timingSafeEqualStrings } from "./telegram-secret.ts";

Deno.test("timingSafeEqualStrings: true for identical strings", () => {
  assertEquals(timingSafeEqualStrings("my-secret", "my-secret"), true);
});

Deno.test("timingSafeEqualStrings: false for different strings of the same length", () => {
  assertEquals(timingSafeEqualStrings("my-secret", "my-secre1"), false);
});

Deno.test("timingSafeEqualStrings: false for different lengths", () => {
  assertEquals(timingSafeEqualStrings("short", "much-longer-value"), false);
});

Deno.test("timingSafeEqualStrings: false for an empty vs. non-empty string", () => {
  assertEquals(timingSafeEqualStrings("", "non-empty"), false);
});

Deno.test("timingSafeEqualStrings: true for two empty strings", () => {
  assertEquals(timingSafeEqualStrings("", ""), true);
});

Deno.test("timingSafeEqualStrings: case-sensitive", () => {
  assertEquals(timingSafeEqualStrings("Secret", "secret"), false);
});
