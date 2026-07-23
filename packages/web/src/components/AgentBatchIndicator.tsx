import type { Dictionary, Lang } from "../i18n.ts";
import { usePrefersReducedMotion, withMotionClass } from "../lib/motion.ts";
import { agentBatchPhrase } from "../lib/agentBatch.ts";
import { pluralizeRu } from "../lib/pluralizeRu.ts";

export interface AgentBatchIndicatorProps {
  dict: Dictionary;
  lang: Lang;
  ready: number;
  total: number;
}

// Task 25 Part A: one aggregate summary replacing individual agent-pending
// cards — see lib/agentBatch.ts for the M/N computation and Feed.tsx for
// where this mounts (top of whichever section the batch's articles bucket
// into, normally "today").
//
// Task 40 Part C: the wording used to always read as two contradictory
// clauses — "Preparing N fresh summaries… ready M of N" — because the first
// number is the TOTAL, not an in-progress count. Now a single unambiguous
// line per phase (see agentBatchPhrase): nothing ready yet ("Preparing N
// summaries…"), some ready ("M of N summaries ready"), or all ready (this
// component isn't mounted at all — see Feed.tsx's `agentBatch.visible`
// gate — but returns null here too, defensively, so this phrase is never
// silently rendered as either of the other two).
export function AgentBatchIndicator({ dict, lang, ready, total }: AgentBatchIndicatorProps) {
  const reducedMotion = usePrefersReducedMotion();
  const barClass = withMotionClass("shimmer-bar", "shimmer-bar--animated", reducedMotion);
  const phrase = agentBatchPhrase(ready, total);

  if (phrase === "done") return null;

  const noun = lang === "ru"
    ? pluralizeRu(total, [
      dict.agentBatchSummaryNounOne,
      dict.agentBatchSummaryNounFew,
      dict.agentBatchSummaryNounMany,
    ])
    : (total === 1 ? dict.agentBatchSummaryNounOne : dict.agentBatchSummaryNounMany);

  const text = phrase === "preparing"
    ? `${dict.agentBatchPreparingVerb} ${total} ${noun}…`
    : lang === "ru"
    ? `${dict.agentBatchPartialReadyLabel} ${ready} ${dict.agentBatchOfLabel} ${total} ${noun}`
    : `${ready} ${dict.agentBatchOfLabel} ${total} ${noun} ${dict.agentBatchPartialReadyLabel}`;

  return (
    <div class="agent-batch-indicator">
      <div class={barClass} aria-hidden="true" />
      <p class="agent-batch-text">
        {phrase === "partial" ? <span class="agent-batch-progress">{text}</span> : text}
      </p>
    </div>
  );
}
