import type { FaithfulnessJson, FaithfulnessVerdict } from "@clipfeed/shared/types";
import type { Dictionary } from "../i18n.ts";

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

export interface FaithfulnessBadgeInfo {
  badgeText: string;
  tooltipText: string;
}

// Task 34 Part B: the badge (and its tooltip) only ever appear for 'weak'/
// 'fail' — 'pass' and null (check disabled/not run/visitor-stripped) get
// nothing, a normal summary needs no caveat. Pulled out as its own pure
// function (rather than inlined ternaries in ArticleCard.tsx) so "which
// verdicts get a badge at all" is directly unit-testable without rendering
// the component.
export function faithfulnessBadgeInfo(
  dict: Dictionary,
  verdict: FaithfulnessVerdict | null,
): FaithfulnessBadgeInfo | null {
  if (verdict === "weak") {
    return {
      badgeText: dict.faithfulnessBadgeWeak,
      tooltipText: `${dict.faithfulnessTooltipWeak} ${dict.faithfulnessTooltipTrailer}`,
    };
  }
  if (verdict === "fail") {
    return {
      badgeText: dict.faithfulnessBadgeFail,
      tooltipText: `${dict.faithfulnessTooltipFail} ${dict.faithfulnessTooltipTrailer}`,
    };
  }
  return null;
}

// Task 42 Part B: the badge became an internal quality signal, not a
// reader-facing disclaimer — a visitor never sees it, in ANY verdict state,
// including both 'weak' and 'fail'. Owner mode is unaffected (still gated
// by faithfulnessBadgeInfo's own verdict check above). Pulled out as its
// own pure function — same reasoning as faithfulnessBadgeInfo itself: the
// gating logic belongs in a unit-testable helper, not inlined as a ternary
// in ArticleCard.tsx where it can't be exercised without rendering the
// component.
export function visibleFaithfulnessBadgeInfo(
  dict: Dictionary,
  verdict: FaithfulnessVerdict | null,
  isOwner: boolean,
): FaithfulnessBadgeInfo | null {
  if (!isOwner) return null;
  return faithfulnessBadgeInfo(dict, verdict);
}
