import { assertEquals } from "@std/assert";
import {
  agentBatchPhrase,
  computeAgentBatchIndicator,
  computeTodayIsEmpty,
  isSectionVisiblyEmpty,
  pendingCardVariant,
  shouldShowEmptyCountdown,
} from "./agentBatch.ts";

function item(
  added_via: "agent" | "manual" | "extension" | "telegram",
  status: "pending" | "ready" | "failed",
) {
  return { added_via, status } as const;
}

// --- computeAgentBatchIndicator ---

Deno.test("computeAgentBatchIndicator - all agent-pending: visible, 0 ready, total = pending count", () => {
  const items = [item("agent", "pending"), item("agent", "pending"), item("agent", "pending")];
  assertEquals(computeAgentBatchIndicator(items), { visible: true, ready: 0, total: 3 });
});

Deno.test("computeAgentBatchIndicator - partial ready: visible stays true, ready/total reflect the mix", () => {
  const items = [
    item("agent", "ready"),
    item("agent", "ready"),
    item("agent", "pending"),
  ];
  assertEquals(computeAgentBatchIndicator(items), { visible: true, ready: 2, total: 3 });
});

Deno.test("computeAgentBatchIndicator - all ready, none pending: indicator hidden", () => {
  const items = [item("agent", "ready"), item("agent", "ready")];
  assertEquals(computeAgentBatchIndicator(items), { visible: false, ready: 2, total: 2 });
});

Deno.test("computeAgentBatchIndicator - a failed agent-pending is excluded from ready AND total (never counted as 'coming')", () => {
  const items = [item("agent", "ready"), item("agent", "failed"), item("agent", "pending")];
  assertEquals(computeAgentBatchIndicator(items), { visible: true, ready: 1, total: 2 });
});

Deno.test("computeAgentBatchIndicator - non-agent items never contribute to ready/total/visible", () => {
  const items = [item("manual", "pending"), item("extension", "ready"), item("telegram", "failed")];
  assertEquals(computeAgentBatchIndicator(items), { visible: false, ready: 0, total: 0 });
});

Deno.test("computeAgentBatchIndicator - empty section: hidden, zero/zero", () => {
  assertEquals(computeAgentBatchIndicator([]), { visible: false, ready: 0, total: 0 });
});

// --- agentBatchPhrase: Task 40 Part C wording states ---

Deno.test("agentBatchPhrase - M = 0 -> preparing", () => {
  assertEquals(agentBatchPhrase(0, 29), "preparing");
});

Deno.test("agentBatchPhrase - 0 < M < N -> partial", () => {
  assertEquals(agentBatchPhrase(19, 29), "partial");
});

Deno.test("agentBatchPhrase - M = N (all ready) -> done", () => {
  assertEquals(agentBatchPhrase(29, 29), "done");
});

Deno.test("agentBatchPhrase - N = 0 (nothing at all) -> done, not preparing", () => {
  assertEquals(agentBatchPhrase(0, 0), "done");
});

// --- isSectionVisiblyEmpty ---

Deno.test("isSectionVisiblyEmpty - empty array is vacuously empty", () => {
  assertEquals(isSectionVisiblyEmpty([]), true);
});

Deno.test("isSectionVisiblyEmpty - all agent-pending is visibly empty (nothing renders as a card)", () => {
  assertEquals(isSectionVisiblyEmpty([item("agent", "pending"), item("agent", "pending")]), true);
});

Deno.test("isSectionVisiblyEmpty - a single owner-pending item makes the section NOT visibly empty", () => {
  assertEquals(isSectionVisiblyEmpty([item("agent", "pending"), item("manual", "pending")]), false);
});

Deno.test("isSectionVisiblyEmpty - a ready agent article makes the section NOT visibly empty", () => {
  assertEquals(isSectionVisiblyEmpty([item("agent", "ready")]), false);
});

// --- shouldShowEmptyCountdown: Task 24/25 precedence ---

Deno.test("shouldShowEmptyCountdown - nothing at all (agent hasn't run) -> show countdown", () => {
  assertEquals(shouldShowEmptyCountdown([]), true);
});

Deno.test("shouldShowEmptyCountdown - agent batch just started, all pending -> indicator wins, no countdown", () => {
  assertEquals(
    shouldShowEmptyCountdown([item("agent", "pending"), item("agent", "pending")]),
    false,
  );
});

Deno.test("shouldShowEmptyCountdown - agent batch mid-progress (some ready, some pending) -> no countdown (real cards + indicator already visible)", () => {
  assertEquals(shouldShowEmptyCountdown([item("agent", "ready"), item("agent", "pending")]), false);
});

Deno.test("shouldShowEmptyCountdown - agent batch fully done (all ready) -> no countdown, real content", () => {
  assertEquals(shouldShowEmptyCountdown([item("agent", "ready")]), false);
});

Deno.test("shouldShowEmptyCountdown - an owner-pending item present -> no countdown (skeleton is content)", () => {
  assertEquals(shouldShowEmptyCountdown([item("manual", "pending")]), false);
});

// --- pendingCardVariant: added_via routing ---

Deno.test("pendingCardVariant - agent -> hidden (represented by the batch indicator instead)", () => {
  assertEquals(pendingCardVariant({ added_via: "agent" }), "hidden");
});

Deno.test("pendingCardVariant - manual/extension/telegram -> skeleton", () => {
  assertEquals(pendingCardVariant({ added_via: "manual" }), "skeleton");
  assertEquals(pendingCardVariant({ added_via: "extension" }), "skeleton");
  assertEquals(pendingCardVariant({ added_via: "telegram" }), "skeleton");
});

// --- computeTodayIsEmpty: Task 29 Part C visibility matrix (filtered x
// today-empty x archived) ---

Deno.test("computeTodayIsEmpty - default view, Today genuinely empty -> countdown shows", () => {
  assertEquals(computeTodayIsEmpty(false, false, []), true);
});

Deno.test("computeTodayIsEmpty - default view, Today has content -> no countdown", () => {
  assertEquals(computeTodayIsEmpty(false, false, [item("manual", "ready")]), false);
});

Deno.test("computeTodayIsEmpty - filtered view, Today empty -> no countdown (filter excludes, nothing is 'coming')", () => {
  assertEquals(computeTodayIsEmpty(false, true, []), false);
});

Deno.test("computeTodayIsEmpty - filtered view, Today has content -> no countdown either way", () => {
  assertEquals(computeTodayIsEmpty(false, true, [item("manual", "ready")]), false);
});

Deno.test("computeTodayIsEmpty - archived view, Today empty, unfiltered -> no countdown (archived overrides)", () => {
  assertEquals(computeTodayIsEmpty(true, false, []), false);
});

Deno.test("computeTodayIsEmpty - archived AND filtered, Today empty -> still no countdown", () => {
  assertEquals(computeTodayIsEmpty(true, true, []), false);
});

Deno.test("computeTodayIsEmpty - default view, agent batch in flight -> no countdown (existing precedence unaffected)", () => {
  assertEquals(computeTodayIsEmpty(false, false, [item("agent", "pending")]), false);
});
