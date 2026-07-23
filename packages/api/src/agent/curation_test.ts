import { assertEquals } from "@std/assert";
import {
  loadBlocklistConfig,
  loadCurationConfig,
  validatePrioritySources,
  validateTopicQuotas,
} from "./curation.ts";
import type { SourceConfig } from "./agent-types.ts";

function withCapturedWarnings(fn: () => void): string[] {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

// --- validateTopicQuotas: the 50%-of-pickCount rule (Task 33 §1) ---

Deno.test("validateTopicQuotas: a sum within 50% of pickCount passes through unchanged", () => {
  const quotas = { linux: 1, hardware: 1, security: 1 };
  let result: Record<string, number> = {};
  const warnings = withCapturedWarnings(() => {
    result = validateTopicQuotas(quotas, 10);
  });
  assertEquals(result, quotas);
  assertEquals(warnings.length, 0);
});

Deno.test("validateTopicQuotas: exactly 50% of pickCount is allowed (boundary)", () => {
  const quotas = { a: 2, b: 3 };
  const result = validateTopicQuotas(quotas, 10);
  assertEquals(result, quotas);
});

Deno.test("validateTopicQuotas: a sum exceeding 50% truncates by dropping the LAST-listed quotas and logs a warning", () => {
  const quotas = { linux: 2, hardware: 2, security: 2 }; // sum 6 > 50% of 10 (5)
  let result: Record<string, number> = {};
  const warnings = withCapturedWarnings(() => {
    result = validateTopicQuotas(quotas, 10);
  });
  // Drops "security" (last-listed) first: 6 - 2 = 4 <= 5, so linux+hardware
  // survive.
  assertEquals(result, { linux: 2, hardware: 2 });
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("curation_quota_sum_exceeded"), true);
});

Deno.test("validateTopicQuotas: drops multiple trailing quotas if one drop still isn't enough", () => {
  const quotas = { a: 3, b: 3, c: 3 }; // sum 9, max for pickCount 10 is 5
  const result = validateTopicQuotas(quotas, 10);
  // Drop "c" (9-3=6, still > 5) then "b" (6-3=3, <= 5) -> only "a" survives.
  assertEquals(result, { a: 3 });
});

Deno.test("validateTopicQuotas: an empty quotas object is unaffected (today's behavior)", () => {
  const warnings = withCapturedWarnings(() => {
    const result = validateTopicQuotas({}, 10);
    assertEquals(result, {});
  });
  assertEquals(warnings.length, 0);
});

// --- validatePrioritySources: unknown ids ignored + logged ---

const SOURCES: SourceConfig[] = [
  { id: "phoronix", type: "rss", url: "https://example.com/rss" },
  { id: "lwn", type: "rss", url: "https://example.com/rss2" },
];

Deno.test("validatePrioritySources: known ids pass through unchanged, no warning", () => {
  const warnings = withCapturedWarnings(() => {
    const result = validatePrioritySources(["phoronix", "lwn"], SOURCES);
    assertEquals(result, ["phoronix", "lwn"]);
  });
  assertEquals(warnings.length, 0);
});

Deno.test("validatePrioritySources: an unknown id is dropped and logged, known ids kept", () => {
  let result: string[] = [];
  const warnings = withCapturedWarnings(() => {
    result = validatePrioritySources(["phoronix", "not-a-real-source"], SOURCES);
  });
  assertEquals(result, ["phoronix"]);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("curation_priority_source_unknown"), true);
  assertEquals(warnings[0].includes("not-a-real-source"), true);
});

Deno.test("validatePrioritySources: an empty list is unaffected (today's behavior)", () => {
  const result = validatePrioritySources([], SOURCES);
  assertEquals(result, []);
});

// --- loadCurationConfig / loadBlocklistConfig: the real committed files ---
// (These document the actual shipped config's shape and validation
// behavior — see the config files themselves for the canonical values.)

Deno.test("loadCurationConfig: the real curation.json's quotas fit within 50% of the default pick count (10), unchanged", () => {
  const config = loadCurationConfig(SOURCES, 10);
  assertEquals(config.topicQuotas, { linux: 1, hardware: 1, security: 1 });
});

Deno.test("loadCurationConfig: unknown priority source ids (relative to the `sources` passed in) are dropped", () => {
  // The real curation.json lists "phoronix"/"lwn"/"thehackernews"; passing
  // a `sources` list that only recognizes "phoronix" drops the other two.
  const config = loadCurationConfig(
    [{ id: "phoronix", type: "rss", url: "https://example.com/rss" }],
    10,
  );
  assertEquals(config.prioritySources, ["phoronix"]);
});

Deno.test("loadCurationConfig: topicVocabulary and preferredDomains load straight from the file", () => {
  const config = loadCurationConfig(SOURCES, 10);
  assertEquals(config.topicVocabulary.includes("ai"), true);
  assertEquals(config.topicVocabulary.includes("other"), true);
  assertEquals(config.preferredDomains.includes("phoronix.com"), true);
});

Deno.test("loadBlocklistConfig: the real blocklist.json's blockedDomains load straight from the file", () => {
  const config = loadBlocklistConfig();
  assertEquals(config.blockedDomains.includes("wsj.com"), true);
  assertEquals(config.blockedDomains.includes("medium.com"), true);
});
