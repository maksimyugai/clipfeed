import "./env.d.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  assertEmbeddingDimensions,
  buildEmbeddingText,
  cosineSimilarity,
  DEFAULT_EMBEDDING_MODEL,
  deleteArticleEmbedding,
  EMBEDDING_DIMENSIONS,
  embedText,
  extractEmbeddingVector,
  queryRelatedEmbeddings,
  resolveEmbeddingModel,
  upsertArticleEmbedding,
} from "./embeddings.ts";

// --- resolveEmbeddingModel ---

Deno.test("resolveEmbeddingModel: empty/undefined falls back to the default", () => {
  assertEquals(resolveEmbeddingModel(undefined), DEFAULT_EMBEDDING_MODEL);
  assertEquals(resolveEmbeddingModel(""), DEFAULT_EMBEDDING_MODEL);
  assertEquals(resolveEmbeddingModel("   "), DEFAULT_EMBEDDING_MODEL);
});

Deno.test("resolveEmbeddingModel: a real override is used as-is, trimmed", () => {
  assertEquals(resolveEmbeddingModel("  @cf/some/other-model  "), "@cf/some/other-model");
});

// --- buildEmbeddingText: the canonical embedding text builder ---

Deno.test("buildEmbeddingText: title, tldr, and bullets joined with newlines, in order", () => {
  const text = buildEmbeddingText({
    title_en: "Title",
    tldr_en: "TLDR sentence.",
    bullets_en: ["Bullet one.", "Bullet two."],
  });
  assertEquals(text, "Title\nTLDR sentence.\nBullet one.\nBullet two.");
});

Deno.test("buildEmbeddingText: missing/empty fields are simply omitted, not blank lines", () => {
  assertEquals(
    buildEmbeddingText({ title_en: "Title only", tldr_en: null, bullets_en: null }),
    "Title only",
  );
  assertEquals(
    buildEmbeddingText({ title_en: "", tldr_en: "  ", bullets_en: [] }),
    "",
  );
});

Deno.test("buildEmbeddingText: every part is trimmed", () => {
  assertEquals(
    buildEmbeddingText({ title_en: "  Title  ", tldr_en: "  TLDR  ", bullets_en: ["  B  "] }),
    "Title\nTLDR\nB",
  );
});

Deno.test("buildEmbeddingText: an all-empty input yields an empty string, no throw", () => {
  assertEquals(buildEmbeddingText({ title_en: null, tldr_en: null, bullets_en: null }), "");
  assertEquals(buildEmbeddingText({ title_en: null, tldr_en: null, bullets_en: [] }), "");
});

Deno.test("buildEmbeddingText: truncates to the model's conservative input cap (1800 chars)", () => {
  const longBullet = "x".repeat(3000);
  const text = buildEmbeddingText({ title_en: "T", tldr_en: null, bullets_en: [longBullet] });
  assertEquals(text.length, 1800);
});

// --- extractEmbeddingVector: defensive parsing of the Workers AI response ---

Deno.test("extractEmbeddingVector: the standard { shape, data: number[][] } shape", () => {
  const vector = extractEmbeddingVector({ shape: [1, 3], data: [[0.1, 0.2, 0.3]] });
  assertEquals(vector, [0.1, 0.2, 0.3]);
});

Deno.test("extractEmbeddingVector: throws on missing/malformed data", () => {
  const bad: unknown[] = [
    null,
    undefined,
    "a string",
    {},
    { data: [] },
    { data: [[]] },
    { data: [["not", "numbers"]] },
  ];
  for (const input of bad) {
    let threw = false;
    try {
      extractEmbeddingVector(input);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected extractEmbeddingVector(${JSON.stringify(input)}) to throw`);
  }
});

// --- assertEmbeddingDimensions: the dimension-mismatch guard ---

Deno.test("assertEmbeddingDimensions: passes silently when the vector matches", () => {
  assertEmbeddingDimensions(new Array(1024).fill(0), 1024);
});

Deno.test("assertEmbeddingDimensions: throws loudly on a mismatch, naming both numbers", () => {
  let message = "";
  try {
    assertEmbeddingDimensions(new Array(768).fill(0), 1024);
  } catch (err) {
    message = (err as Error).message;
  }
  assertEquals(message.includes("768"), true);
  assertEquals(message.includes("1024"), true);
});

// --- cosineSimilarity ---

Deno.test("cosineSimilarity: identical vectors score 1", () => {
  assertEquals(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

Deno.test("cosineSimilarity: orthogonal vectors score 0", () => {
  assertEquals(cosineSimilarity([1, 0], [0, 1]), 0);
});

Deno.test("cosineSimilarity: opposite vectors score -1", () => {
  assertEquals(cosineSimilarity([1, 0], [-1, 0]), -1);
});

Deno.test("cosineSimilarity: a zero vector scores 0 (never divides by zero / NaN)", () => {
  assertEquals(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  assertEquals(cosineSimilarity([0, 0], [0, 0]), 0);
});

Deno.test("cosineSimilarity: throws on mismatched vector lengths", () => {
  let threw = false;
  try {
    cosineSimilarity([1, 2], [1, 2, 3]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("cosineSimilarity: is symmetric", () => {
  const a = [0.5, -0.2, 0.9, 0.1];
  const b = [0.1, 0.3, -0.4, 0.8];
  assertEquals(cosineSimilarity(a, b), cosineSimilarity(b, a));
});

// --- embedText: end-to-end (stubbed Ai) ---

function makeStubAi(handler: (model: string, input: unknown) => unknown): Ai {
  return { run: (model, input) => Promise.resolve(handler(model, input)) };
}

Deno.test("embedText: happy path returns the validated vector", async () => {
  const ai = makeStubAi((_model, input) => {
    assertEquals(input, { text: "some article text" });
    return { shape: [1, EMBEDDING_DIMENSIONS], data: [new Array(EMBEDDING_DIMENSIONS).fill(0.1)] };
  });
  const vector = await embedText(ai, DEFAULT_EMBEDDING_MODEL, "some article text");
  assertEquals(vector.length, EMBEDDING_DIMENSIONS);
});

Deno.test("embedText: throws (does not silently truncate/pad) on a dimension mismatch", async () => {
  const ai = makeStubAi(() => ({ shape: [1, 768], data: [new Array(768).fill(0.1)] }));
  await assertRejects(
    () => embedText(ai, DEFAULT_EMBEDDING_MODEL, "text"),
    Error,
    "dimension mismatch",
  );
});

Deno.test("embedText: throws on a malformed response instead of returning garbage", async () => {
  const ai = makeStubAi(() => ({ unexpected: "shape" }));
  await assertRejects(() => embedText(ai, DEFAULT_EMBEDDING_MODEL, "text"));
});

// --- Vectorize wrappers: graceful degradation when VECTORS is absent ---

Deno.test("upsertArticleEmbedding: no-op, never throws, when vectors is undefined", async () => {
  await upsertArticleEmbedding(undefined, "id-1", [0.1, 0.2], {
    added_at: "2026-01-01T00:00:00.000Z",
    source: "example.com",
    added_via: "manual",
    lang_original: "en",
  });
});

Deno.test("upsertArticleEmbedding: calls vectors.upsert with the id/values/metadata, null fields coerced to ''", async () => {
  let captured: VectorizeVector[] | undefined;
  const vectors: VectorizeIndex = {
    upsert: (v) => {
      captured = v;
      return Promise.resolve({ count: v.length, ids: v.map((x) => x.id) });
    },
    query: () => Promise.reject(new Error("not used")),
    deleteByIds: () => Promise.reject(new Error("not used")),
  };
  await upsertArticleEmbedding(vectors, "id-1", [0.1, 0.2], {
    added_at: "2026-01-01T00:00:00.000Z",
    source: null,
    added_via: "agent",
    lang_original: null,
  });
  assertEquals(captured, [
    {
      id: "id-1",
      values: [0.1, 0.2],
      metadata: {
        added_at: "2026-01-01T00:00:00.000Z",
        source: "",
        added_via: "agent",
        lang_original: "",
      },
    },
  ]);
});

Deno.test("deleteArticleEmbedding: no-op, never throws, when vectors is undefined", async () => {
  await deleteArticleEmbedding(undefined, "id-1");
});

Deno.test("deleteArticleEmbedding: calls vectors.deleteByIds with the id", async () => {
  let captured: string[] | undefined;
  const vectors: VectorizeIndex = {
    upsert: () => Promise.reject(new Error("not used")),
    query: () => Promise.reject(new Error("not used")),
    deleteByIds: (ids) => {
      captured = ids;
      return Promise.resolve({ count: ids.length, ids });
    },
  };
  await deleteArticleEmbedding(vectors, "id-1");
  assertEquals(captured, ["id-1"]);
});

Deno.test("queryRelatedEmbeddings: returns [] (not an error) when vectors is undefined", async () => {
  const matches = await queryRelatedEmbeddings(undefined, [0.1, 0.2], { topK: 3 });
  assertEquals(matches, []);
});

Deno.test("queryRelatedEmbeddings: passes topK + added_at filter through, maps matches to {id, score}", async () => {
  let capturedOptions: VectorizeQueryOptions | undefined;
  const vectors: VectorizeIndex = {
    upsert: () => Promise.reject(new Error("not used")),
    deleteByIds: () => Promise.reject(new Error("not used")),
    query: (_vector, options) => {
      capturedOptions = options;
      return Promise.resolve({
        count: 2,
        matches: [{ id: "a", score: 0.95 }, { id: "b", score: 0.87 }],
      });
    },
  };
  const matches = await queryRelatedEmbeddings(vectors, [0.1, 0.2], {
    topK: 3,
    sinceIso: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(matches, [{ id: "a", score: 0.95 }, { id: "b", score: 0.87 }]);
  assertEquals(capturedOptions?.topK, 3);
  assertEquals(capturedOptions?.filter, { added_at: { $gte: "2026-01-01T00:00:00.000Z" } });
});

Deno.test("queryRelatedEmbeddings: omits the filter entirely when no sinceIso is given (unfiltered search)", async () => {
  let capturedOptions: VectorizeQueryOptions | undefined;
  const vectors: VectorizeIndex = {
    upsert: () => Promise.reject(new Error("not used")),
    deleteByIds: () => Promise.reject(new Error("not used")),
    query: (_vector, options) => {
      capturedOptions = options;
      return Promise.resolve({ count: 0, matches: [] });
    },
  };
  await queryRelatedEmbeddings(vectors, [0.1, 0.2], { topK: 20 });
  assertEquals(capturedOptions?.filter, undefined);
});

// --- A VECTORS binding that THROWS on use (not merely absent) — the
// documented `wrangler dev` reality: Vectorize has no local emulation, so
// `env.VECTORS` is a truthy proxy there whose every method rejects with
// "needs to be run remotely." upsert/delete swallow this the same way they
// swallow `vectors === undefined` (no meaningful fallback exists for either
// write); queryRelatedEmbeddings deliberately does NOT (see its own test
// below) — its callers have a real fallback and need to know a query
// genuinely failed. ---

function makeThrowingVectors(): VectorizeIndex {
  const fail = () => Promise.reject(new Error("Binding VECTORS needs to be run remotely"));
  return { upsert: fail, deleteByIds: fail, query: fail };
}

Deno.test("upsertArticleEmbedding: a throwing vectors binding is swallowed, not rethrown", async () => {
  await upsertArticleEmbedding(makeThrowingVectors(), "id-1", [0.1, 0.2], {
    added_at: "2026-01-01T00:00:00.000Z",
    source: null,
    added_via: "manual",
    lang_original: null,
  });
});

Deno.test("deleteArticleEmbedding: a throwing vectors binding is swallowed, not rethrown", async () => {
  await deleteArticleEmbedding(makeThrowingVectors(), "id-1");
});

Deno.test("queryRelatedEmbeddings: a throwing vectors binding rethrows — this one has a real fallback (see search.ts/agent-pool.ts), so its caller must know a query genuinely failed", async () => {
  await assertRejects(() => queryRelatedEmbeddings(makeThrowingVectors(), [0.1, 0.2], { topK: 3 }));
});
