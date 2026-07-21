import type { FaithfulnessJson } from "@clipfeed/shared/types";

// Pure helper reading the judge's per-claim detail out of the owner-only
// faithfulness_json field (see ArticleCard.tsx's owner-mode footnote under
// the source attribution line) — null for the {error} shape (judge
// unparseable) or when the field itself is null (check disabled/not run/
// visitor mode, where this field is always stripped — see PublicArticle in
// @clipfeed/shared/types).
export function faithfulnessCounts(
  json: FaithfulnessJson | null,
): { unsupported: number; contradicted: number } | null {
  if (!json || !("claims" in json)) return null;
  return {
    unsupported: json.claims.filter((c) => c.verdict === "unsupported").length,
    contradicted: json.claims.filter((c) => c.verdict === "contradicted").length,
  };
}
