import "../env.d.ts";
import { runAgentJob } from "../agent/agent.ts";
import { readAgentRunHistory } from "../agent/agent-run-tracker.ts";
import { runHealingJob } from "../pipeline/healing.ts";
import { runPublishJob } from "../telegram/telegram-publish.ts";

// [vars] string, not a number — an empty or invalid value disables the
// agent job entirely, same "safe default = off" pattern as the rest of
// this app's optional integrations (Access, Turnstile, Telegram).
export function parseHour(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

// Single hourly cron trigger (wrangler.toml [triggers] crons = ["0 * * * *"])
// dispatched by UTC hour to the scraping agent (AGENT_HOUR_UTC) — the old
// fixed-time morning digest that used to dispatch here (DIGEST_HOUR_UTC)
// was retired in favor of the Telegram drip publish job (see
// telegram-publish.ts's runPublishJob), which runs on EVERY tick and gates
// itself internally via its own start/end window + PUBLISH_ENABLED, rather
// than a single dispatch hour — one post an hour across a window, not one
// job at one hour. The healing sweep (see healing.ts) also has no hour
// config — it runs on every tick too, last.
export async function handleScheduled(
  env: Env,
  scheduledTimeMs: number,
  ctx?: ExecutionContext,
): Promise<void> {
  const currentHour = new Date(scheduledTimeMs).getUTCHours();

  if (parseHour(env.AGENT_HOUR_UTC) === currentHour) {
    // Task 36 Part B: run-level idempotency — if the agent already ran
    // today (this same scheduled hour on a prior tick, or a manual trigger
    // earlier today — see agent-run-tracker.ts), skip rather than doubling
    // the day's picks. Manual triggers (POST /api/admin/agent/run, /scrape)
    // deliberately do NOT check this: owner intent always wins there, they
    // just get a warning first (see index.ts/telegram-webhook.ts).
    const previousRuns = await readAgentRunHistory(env.CACHE, new Date(scheduledTimeMs));
    if (previousRuns.length > 0) {
      console.log(JSON.stringify({
        event: "agent_run_skipped",
        reason: "already_ran_today",
        previousRuns,
      }));
    } else {
      await runAgentJob(env, undefined, "scheduled");
    }
  }
  await runPublishJob(env, scheduledTimeMs);
  await runHealingJob(env, ctx);
}
