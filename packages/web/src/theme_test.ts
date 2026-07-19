import { assertEquals } from "@std/assert";
import { isTheme, readStoredTheme, resolveInitialTheme, writeStoredTheme } from "./theme.ts";

function makeFakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

Deno.test("isTheme: accepts only 'light' and 'dark'", () => {
  assertEquals(isTheme("light"), true);
  assertEquals(isTheme("dark"), true);
  assertEquals(isTheme("blue"), false);
  assertEquals(isTheme(null), false);
});

Deno.test("readStoredTheme: null when nothing stored", () => {
  assertEquals(readStoredTheme(makeFakeStorage()), null);
});

Deno.test("readStoredTheme: null when stored value is invalid", () => {
  assertEquals(readStoredTheme(makeFakeStorage({ "clipfeed-theme": "blue" })), null);
});

Deno.test("writeStoredTheme + readStoredTheme round-trip", () => {
  const storage = makeFakeStorage();
  writeStoredTheme(storage, "dark");
  assertEquals(readStoredTheme(storage), "dark");
});

Deno.test("resolveInitialTheme: explicit stored choice wins over system preference", () => {
  const storage = makeFakeStorage({ "clipfeed-theme": "light" });
  assertEquals(resolveInitialTheme(storage, true), "light");
});

Deno.test("resolveInitialTheme: falls back to system preference when nothing stored", () => {
  const storage = makeFakeStorage();
  assertEquals(resolveInitialTheme(storage, true), "dark");
  assertEquals(resolveInitialTheme(storage, false), "light");
});
