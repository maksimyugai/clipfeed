import { assertEquals } from "@std/assert";
import {
  domainMatchesAny,
  hostMatchesDomain,
  normalizeDomainInput,
  resolveDomainPrecedence,
} from "./domain-block.ts";

// --- hostMatchesDomain: exact + suffix, and the two near-miss cases from ---
// --- Task 33 §2's spec ---

Deno.test("hostMatchesDomain: exact match", () => {
  assertEquals(hostMatchesDomain("example.com", "example.com"), true);
});

Deno.test("hostMatchesDomain: a subdomain matches (www already stripped by url-host.ts upstream, but blog. etc. still matches)", () => {
  assertEquals(hostMatchesDomain("www.example.com", "example.com"), true);
  assertEquals(hostMatchesDomain("blog.example.com", "example.com"), true);
  assertEquals(hostMatchesDomain("a.b.example.com", "example.com"), true);
});

Deno.test("hostMatchesDomain: a near-miss host that merely CONTAINS the domain as a substring does not match", () => {
  assertEquals(hostMatchesDomain("notexample.com", "example.com"), false);
});

Deno.test("hostMatchesDomain: the blocked domain appearing as a suffix-of-a-different-domain does not match", () => {
  assertEquals(hostMatchesDomain("example.com.evil.net", "example.com"), false);
});

Deno.test("hostMatchesDomain: unrelated domains never match", () => {
  assertEquals(hostMatchesDomain("example.org", "example.com"), false);
});

Deno.test("hostMatchesDomain: case-insensitive on both sides", () => {
  assertEquals(hostMatchesDomain("EXAMPLE.COM", "example.com"), true);
  assertEquals(hostMatchesDomain("example.com", "EXAMPLE.COM"), true);
});

Deno.test("domainMatchesAny: true if any listed domain matches, false for an empty list or no match", () => {
  assertEquals(domainMatchesAny("blog.example.com", ["other.com", "example.com"]), true);
  assertEquals(domainMatchesAny("example.com", []), false);
  assertEquals(domainMatchesAny("example.com", ["other.com"]), false);
});

// --- resolveDomainPrecedence: the precedence matrix (config x auto x preferred) ---

Deno.test("resolveDomainPrecedence: not in any list -> allowed, not preferred, no conflict", () => {
  const result = resolveDomainPrecedence("example.com", [], new Set(), []);
  assertEquals(result, { blocked: false, layer: null, preferred: false, conflict: false });
});

Deno.test("resolveDomainPrecedence: config blocklist match -> blocked, layer 'config'", () => {
  const result = resolveDomainPrecedence("wsj.com", ["wsj.com"], new Set(), []);
  assertEquals(result.blocked, true);
  assertEquals(result.layer, "config");
  assertEquals(result.conflict, false);
});

Deno.test("resolveDomainPrecedence: KV autoblock match -> blocked, layer 'auto'", () => {
  const result = resolveDomainPrecedence("flaky.example", [], new Set(["flaky.example"]), []);
  assertEquals(result.blocked, true);
  assertEquals(result.layer, "auto");
});

Deno.test("resolveDomainPrecedence: config blocklist takes precedence over autoblock when both would match", () => {
  const result = resolveDomainPrecedence(
    "wsj.com",
    ["wsj.com"],
    new Set(["wsj.com"]),
    [],
  );
  assertEquals(result.layer, "config");
});

Deno.test("resolveDomainPrecedence: preferredDomains alone (not blocked anywhere) -> allowed, preferred true, no conflict", () => {
  const result = resolveDomainPrecedence("phoronix.com", [], new Set(), ["phoronix.com"]);
  assertEquals(result, { blocked: false, layer: null, preferred: true, conflict: false });
});

Deno.test("resolveDomainPrecedence: preferred-but-config-blocked -> stays blocked, conflict true — whitelist NEVER unblocks", () => {
  const result = resolveDomainPrecedence(
    "phoronix.com",
    ["phoronix.com"],
    new Set(),
    ["phoronix.com"],
  );
  assertEquals(result.blocked, true);
  assertEquals(result.layer, "config");
  assertEquals(result.preferred, true);
  assertEquals(result.conflict, true);
});

Deno.test("resolveDomainPrecedence: preferred-but-auto-blocked -> stays blocked, conflict true", () => {
  const result = resolveDomainPrecedence(
    "phoronix.com",
    [],
    new Set(["phoronix.com"]),
    ["phoronix.com"],
  );
  assertEquals(result.blocked, true);
  assertEquals(result.layer, "auto");
  assertEquals(result.conflict, true);
});

Deno.test("resolveDomainPrecedence: a preferred domain that ISN'T blocked has no conflict even though other domains are blocked", () => {
  const result = resolveDomainPrecedence(
    "phoronix.com",
    ["wsj.com"],
    new Set(["other-flaky.example"]),
    ["phoronix.com"],
  );
  assertEquals(result.blocked, false);
  assertEquals(result.conflict, false);
});

// --- normalizeDomainInput: admin DELETE endpoint input hardening ---

Deno.test("normalizeDomainInput: a bare hostname passes through lowercased", () => {
  assertEquals(normalizeDomainInput("Example.COM"), "example.com");
});

Deno.test("normalizeDomainInput: strips scheme, path/query, and a leading www.", () => {
  assertEquals(normalizeDomainInput("https://www.Example.com/some/path?x=1"), "example.com");
  assertEquals(normalizeDomainInput("http://example.com"), "example.com");
});

Deno.test("normalizeDomainInput: rejects non-string, empty, and invalid hostnames", () => {
  assertEquals(normalizeDomainInput(undefined), null);
  assertEquals(normalizeDomainInput(123), null);
  assertEquals(normalizeDomainInput(""), null);
  assertEquals(normalizeDomainInput("   "), null);
  assertEquals(normalizeDomainInput("not a hostname"), null);
  assertEquals(normalizeDomainInput("no-dot-at-all"), null);
});

Deno.test("normalizeDomainInput: rejects invalid characters even with a dot present", () => {
  assertEquals(normalizeDomainInput("exa mple.com"), null);
  assertEquals(normalizeDomainInput("<script>.com"), null);
});
