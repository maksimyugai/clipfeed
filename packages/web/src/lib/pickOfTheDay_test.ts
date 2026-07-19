import { assertEquals } from "@std/assert";
import { isPickOfTheDay, type PickCandidate } from "./pickOfTheDay.ts";

const NOW = new Date("2026-07-19T15:00:00.000Z");

Deno.test("isPickOfTheDay: false for a manually-added article", () => {
  const article: PickCandidate = {
    id: "a",
    added_via: "manual",
    added_at: "2026-07-19T10:00:00.000Z",
  };
  assertEquals(isPickOfTheDay(article, [article], NOW), false);
});

Deno.test("isPickOfTheDay: false for an agent article added on a previous day", () => {
  const article: PickCandidate = {
    id: "a",
    added_via: "agent",
    added_at: "2026-07-18T23:59:00.000Z",
  };
  assertEquals(isPickOfTheDay(article, [article], NOW), false);
});

Deno.test("isPickOfTheDay: true for the only agent article added today", () => {
  const article: PickCandidate = {
    id: "a",
    added_via: "agent",
    added_at: "2026-07-19T09:00:00.000Z",
  };
  assertEquals(isPickOfTheDay(article, [article], NOW), true);
});

Deno.test("isPickOfTheDay: true only for the newest of several agent articles today", () => {
  const older: PickCandidate = {
    id: "a",
    added_via: "agent",
    added_at: "2026-07-19T08:00:00.000Z",
  };
  const newer: PickCandidate = {
    id: "b",
    added_via: "agent",
    added_at: "2026-07-19T12:00:00.000Z",
  };
  assertEquals(isPickOfTheDay(older, [older, newer], NOW), false);
  assertEquals(isPickOfTheDay(newer, [older, newer], NOW), true);
});

Deno.test("isPickOfTheDay: a manual article added today does not steal the pick from today's agent article", () => {
  const agentArticle: PickCandidate = {
    id: "a",
    added_via: "agent",
    added_at: "2026-07-19T08:00:00.000Z",
  };
  const manualArticle: PickCandidate = {
    id: "b",
    added_via: "manual",
    added_at: "2026-07-19T12:00:00.000Z",
  };
  assertEquals(isPickOfTheDay(agentArticle, [agentArticle, manualArticle], NOW), true);
});

Deno.test("isPickOfTheDay: false when the candidate list doesn't include any agent article today", () => {
  const article: PickCandidate = {
    id: "a",
    added_via: "agent",
    added_at: "2026-07-19T08:00:00.000Z",
  };
  assertEquals(isPickOfTheDay(article, [], NOW), false);
});
