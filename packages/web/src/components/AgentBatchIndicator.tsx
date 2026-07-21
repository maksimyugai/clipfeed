import type { Dictionary, Lang } from "../i18n.ts";
import { usePrefersReducedMotion, withMotionClass } from "../lib/motion.ts";

export interface AgentBatchIndicatorProps {
  dict: Dictionary;
  lang: Lang;
  ready: number;
  total: number;
}

// Task 25 Part A: one aggregate summary replacing individual agent-pending
// cards — see lib/agentBatch.ts for the M/N computation and Feed.tsx for
// where this mounts (top of whichever section the batch's articles bucket
// into, normally "today"). The "M of N" ordering differs by language
// ("готово M из N" vs "M of N ready"), so it's composed per-language here
// rather than forced through a single positional template string.
export function AgentBatchIndicator({ dict, lang, ready, total }: AgentBatchIndicatorProps) {
  const reducedMotion = usePrefersReducedMotion();
  const barClass = withMotionClass("shimmer-bar", "shimmer-bar--animated", reducedMotion);

  const progressText = lang === "ru"
    ? `${dict.agentBatchReadyLabel} ${ready} ${dict.agentBatchOfLabel} ${total}`
    : `${ready} ${dict.agentBatchOfLabel} ${total} ${dict.agentBatchReadyLabel}`;

  return (
    <div class="agent-batch-indicator">
      <div class={barClass} aria-hidden="true" />
      <p class="agent-batch-text">
        {dict.agentBatchPreparingPrefix} {total} {dict.agentBatchPreparingSuffix}{" "}
        <span class="agent-batch-progress">{progressText}</span>
      </p>
    </div>
  );
}
