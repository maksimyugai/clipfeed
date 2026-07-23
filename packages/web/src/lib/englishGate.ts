import type { ArticleListItem } from "@clipfeed/shared/types";

// Task 40: whether this article already has an English edition to render —
// either the lazy translate endpoint has completed (en_generated_at set) or
// it's one of the pre-Task-35 rows that already carries _en fields from the
// old RU+EN-by-default generation (en_generated_at stays null for those
// forever — see Article.en_generated_at's own doc comment in
// packages/shared/src/types.ts). A card must never enqueue a translate
// request when this is true: checking en_generated_at alone (the pre-Task-40
// behavior) misclassified every such old row as "needs English" and enqueued
// a pointless translate call for it on every EN-mode viewport pass.
export function hasEnglish(
  article: Pick<ArticleListItem, "en_generated_at" | "summary_json">,
): boolean {
  if (article.en_generated_at !== null) return true;
  const json = article.summary_json;
  if (!json) return false;
  return Boolean(json.title_en?.trim()) || Boolean(json.tldr_en?.trim());
}

// Task 40: a card's "have I already asked for a translation" memory must
// survive a lang-mode toggle away from "en" and back (RU -> EN -> RU -> EN)
// — only actually acquiring English content should clear that memory, never
// merely needsEnglish becoming false because the reader is looking at RU
// right now. Keying the reset on needsEnglish itself (the pre-Task-40
// behavior) wiped the memory on every toggle, which is what let the same id
// fire a second POST /translate: its first request had already left
// translateQueue's in-flight/queued bookkeeping (queue.ts's dedupe only
// protects while a request is actually outstanding) but en_generated_at
// hadn't been confirmed yet, so the second, post-toggle attempt looked like a
// fresh, undeduped request to the queue.
export function shouldForgetTranslationRequest(articleHasEnglish: boolean): boolean {
  return articleHasEnglish;
}

// Pure decision backing both triggers in ArticleCard's useEnglishTranslation
// (the IntersectionObserver and the expanded-priority effect): a translate
// request should fire only once per card for as long as it needs English —
// repeated intersections (scroll up/down) or the expanded-effect re-running
// must not enqueue a second time.
export function shouldRequestTranslation(
  needsEnglish: boolean,
  alreadyRequested: boolean,
): boolean {
  return needsEnglish && !alreadyRequested;
}
