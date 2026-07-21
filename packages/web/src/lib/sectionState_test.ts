import { assertEquals } from "@std/assert";
import {
  DEFAULT_SECTION_STATE,
  isSectionOpen,
  readStoredSectionState,
  writeStoredSectionState,
} from "./sectionState.ts";

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  } as Storage;
}

Deno.test("readStoredSectionState - defaults when nothing stored", () => {
  assertEquals(readStoredSectionState(fakeStorage()), DEFAULT_SECTION_STATE);
});

Deno.test("readStoredSectionState - defaults on malformed JSON", () => {
  assertEquals(
    readStoredSectionState(fakeStorage({ "clipfeed-sections": "{not json" })),
    DEFAULT_SECTION_STATE,
  );
});

Deno.test("readStoredSectionState - defaults on wrong shape", () => {
  assertEquals(
    readStoredSectionState(fakeStorage({ "clipfeed-sections": JSON.stringify({ today: "yes" }) })),
    DEFAULT_SECTION_STATE,
  );
});

Deno.test("readStoredSectionState - round-trips a written state", () => {
  const storage = fakeStorage();
  const custom = { today: false, yesterday: true, earlier: true };
  writeStoredSectionState(storage, custom);
  assertEquals(readStoredSectionState(storage), custom);
});

Deno.test("isSectionOpen - search active force-opens every section", () => {
  const state = { today: true, yesterday: false, earlier: false };
  assertEquals(isSectionOpen("yesterday", state, true), true);
  assertEquals(isSectionOpen("earlier", state, true), true);
});

Deno.test("isSectionOpen - not searching falls back to persisted state", () => {
  const state = { today: true, yesterday: false, earlier: false };
  assertEquals(isSectionOpen("today", state, false), true);
  assertEquals(isSectionOpen("yesterday", state, false), false);
});
