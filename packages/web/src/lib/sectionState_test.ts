import { assertEquals } from "@std/assert";
import {
  DEFAULT_SECTION_STATE,
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

// --- Task 24 Part D: force-open Yesterday when Today has zero articles ---

Deno.test("isSectionOpenTodayEmptyAware - Today empty forces Yesterday open even when persisted closed", () => {
  const state = { today: true, yesterday: false, earlier: false };
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", state, false, true), true);
});

Deno.test("isSectionOpenTodayEmptyAware - Today non-empty leaves Yesterday at its normal (persisted) state", () => {
  const state = { today: true, yesterday: false, earlier: false };
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", state, false, false), false);
});

Deno.test("isSectionOpenTodayEmptyAware - only 'yesterday' is affected; 'today' and 'earlier' behave exactly as isSectionOpen", () => {
  const state = { today: false, yesterday: false, earlier: false };
  assertEquals(
    isSectionOpenTodayEmptyAware("today", state, false, true),
    isSectionOpen("today", state, false),
  );
  assertEquals(
    isSectionOpenTodayEmptyAware("earlier", state, false, true),
    isSectionOpen("earlier", state, false),
  );
});

Deno.test("isSectionOpenTodayEmptyAware - search-active still force-opens everything, same as isSectionOpen, regardless of todayIsEmpty", () => {
  const state = { today: false, yesterday: false, earlier: false };
  assertEquals(isSectionOpenTodayEmptyAware("earlier", state, true, false), true);
});

Deno.test("isSectionOpenTodayEmptyAware - Yesterday already persisted-open stays open when Today is empty (no behavior change needed)", () => {
  const state = { today: true, yesterday: true, earlier: false };
  assertEquals(isSectionOpenTodayEmptyAware("yesterday", state, false, true), true);
});
