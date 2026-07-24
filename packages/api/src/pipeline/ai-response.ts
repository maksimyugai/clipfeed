// Task 44 Part A: ONE shared normalizer for every Workers AI CHAT-style
// response, replacing five independent re-implementations of the same
// unwrap logic that had accumulated across summarize.ts (x4) and
// faithfulness.ts (x1) — see this module's call sites for the history.
//
// Workers AI's chat models return `{ response: string }`; models that honor
// `response_format: json_schema` may instead return `{ response: <object> }`
// or the parsed object directly, with no wrapper at all. Every caller in
// this codebase has needed to tell these apart, each slightly differently.
// This is deliberately scoped to that one CHAT-response shape family —
// embeddings (`embeddings.ts`'s `extractEmbeddingVector`) are a disjoint
// shape (`{ shape, data: number[][] }`, an embedding vector, not a chat
// message) and stay on their own parser; folding them in here would just
// force an unrelated shape into this one's fields for no benefit.
export interface NormalizedAiResponse {
  // Set when the response unwraps to plain text: either a bare string, or
  // `{ response: "..." }`. Null otherwise.
  text: string | null;
  // Set when the response unwraps to something other than text: either a
  // bare object (no `response` wrapper at all — a documented possible
  // Workers AI shape) or `{ response: <non-string> }`. Null when `text` is
  // set, or when the raw response wasn't an object to begin with.
  parsed: unknown | null;
  // The untouched `env.AI.run` result, for callers that want to log or
  // otherwise inspect it regardless of how it normalized.
  raw: unknown;
}

export function normalizeAiChatResponse(raw: unknown): NormalizedAiResponse {
  if (typeof raw === "string") {
    return { text: raw, parsed: null, raw };
  }
  if (typeof raw !== "object" || raw === null) {
    return { text: null, parsed: null, raw };
  }

  const obj = raw as Record<string, unknown>;
  // Workers AI's own duality: honor an explicit `response` wrapper when
  // present, otherwise the object IS the response (json_schema mode
  // returning the parsed shape directly, no wrapper).
  const inner = "response" in obj ? obj.response : raw;
  if (typeof inner === "string") {
    return { text: inner, parsed: null, raw };
  }
  return { text: null, parsed: inner ?? null, raw };
}
