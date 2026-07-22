import { assertEquals } from "@std/assert";
import {
  defaultSectionOpen,
  isSectionOpen,
  isSectionOpenTodayEmptyAware,
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

Deno.test("readStoredSectionState - empty (no explicit choices) when nothing stored", () => {
  assertEquals(readStoredSectionState(fakeStorage()), {});
});

Deno.test("readStoredSectionState - empty on malformed JSON", () => {
  assertEquals(
    readStoredSectionState(fakeStorage({ "clipfeed-sections": "{not json" })),
    {},
  );
});

Deno.test("readStoredSectionState - empty on wrong shape", () => {
  assertEquals(
    readStoredSectionState(fakeStorage({ "clipfeed-sections": JSON.stringify({ today: "yes" }) })),
    {},
  );
});

Deno.test("readStoredSectionState - accepts a partial object (only some sections explicitly set)", () => {
  assertEquals(
    readStoredSectionState(
      fakeStorage({ "clipfeed-sections": JSON.stringify({ yesterday: false }) }),
    ),
    { yesterday: false },
  );
});

Deno.test("readStoredSectionState - round-trips a written state", () => {
  const storage = fakeStorage();
  const custom = { today: false, yesterday: true };
  writeStoredSectionState(storage, custom);
  assertEquals(readStoredSectionState(storage), custom);
});

// --- defaultSectionOpen ---

Deno.test("defaultSectionOpen - today always defaults open", () => {
  assertEquals(defaultSectionOpen("today", false), true);
  assertEquals(defaultSectionOpen("today", true), true);
});

Deno.test("defaultSectionOpen - earlier always defaults closed", () => {
  assertEquals(defaultSectionOpen("earlier", false), false);
  assertEquals(defaultSectionOpen("earlier", true), false);
});

Deno.test("defaultSectionOpen - yesterday's default tracks todayIsEmpty", () => {
  assertEquals(defaultSectionOpen("yesterday", false), false);
  assertEquals(defaultSectionOpen("yesterday", true), true);
});

// --- isSectionOpen ---

Deno.test("isSectionOpen - search active force-opens every section", () => {
  const state = { today: true, yesterday: false, earlier: false };
  assertEquals(isSectionOpen("yesterday", state, true), true);
  assertEquals(isSectionOpen("earlier", state, true), true);
});

Deno.test("isSectionOpen - not searching, no explicit choice: falls back to the plain default", () => {
  assertEquals(isSectionOpen("today", {}, false), true);
  assertEquals(isSectionOpen("yesterday", {}, false), false);
  assertEquals(isSectionOpen("earlier", {}, false), false);
});

Deno.test("isSectionOpen - not searching, explicit choice present: honors it over the default", () => {
  const state = { today: false, yesterday: true };
  assertEquals(isSectionOpen("today", state, false), false);
  assertEquals(isSectionOpen("yesterday", state, false), true);
});

// --- Task 24 Part D + Task 26 Part 0: force-open Yesterday as a ONE-TIME default ---

Deno.test("isSectionOpenTodayEmptyAware - Today empty, no explicit choice yet: Yesterday defaults open", () => {
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", {}, false, true), true);
});

Deno.test("isSectionOpenTodayEmptyAware - Today non-empty, no explicit choice: Yesterday defaults closed", () => {
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", {}, false, false), false);
});

Deno.test("isSectionOpenTodayEmptyAware - only 'yesterday' has a context-dependent default; 'today'/'earlier' match isSectionOpen", () => {
  assertEquals(
    isSectionOpenTodayEmptyAware("today", {}, false, true),
    isSectionOpen("today", {}, false),
  );
  assertEquals(
    isSectionOpenTodayEmptyAware("earlier", {}, false, true),
    isSectionOpen("earlier", {}, false),
  );
});

Deno.test("isSectionOpenTodayEmptyAware - search-active still force-opens everything, regardless of todayIsEmpty", () => {
  assertEquals(isSectionOpenTodayEmptyAware("earlier", {}, true, false), true);
});

Deno.test("isSectionOpenTodayEmptyAware - Yesterday already explicitly open stays open when Today is empty", () => {
  const state = { yesterday: true };
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", state, false, true), true);
});

// The actual regression (Task 26 Part 0): once the user has explicitly
// collapsed Yesterday, Today staying empty must NOT re-force it open again —
// on any number of subsequent renders/reloads (a fresh state read from
// storage, re-checked here, is the reload case).
Deno.test("isSectionOpenTodayEmptyAware - user explicitly closed Yesterday: stays closed while Today is (still) empty", () => {
  const state = { yesterday: false };
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", state, false, true), false);
  // Simulate re-renders/reloads: re-reading the same persisted state must
  // keep producing the same (closed) result, not flip back to the default.
  for (let i = 0; i < 5; i++) {
    assertEquals(isSectionOpenTodayEmptyAware("yesterday", state, false, true), false);
  }
});

Deno.test("isSectionOpenTodayEmptyAware - user explicitly opened Yesterday while Today has content: stays open, and stays open if Today later becomes empty", () => {
  const state = { yesterday: true };
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", state, false, false), true);
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", state, false, true), true);
});
