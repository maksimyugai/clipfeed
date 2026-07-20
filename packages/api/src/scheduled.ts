import "./env.d.ts";
import { runAgentJob } from "./agent.ts";
import { sendMorningDigest } from "./telegram-webhook.ts";
import { runHealingJob } from "./healing.ts";

// [vars] strings, not numbers — an empty or invalid value disables that
// job entirely, same "safe default = off" pattern as the rest of this
// app's optional integrations (Access, Turnstile, Telegram).
export function parseHour(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

// Single hourly cron trigger (wrangler.toml [triggers] crons = ["0 * * * *"])
// dispatched by UTC hour to whichever configured jobs match — replaces the
// old fixed-time digest-only cron. AGENT_HOUR_UTC and DIGEST_HOUR_UTC are
// independent; both can fire on the same tick if set to the same hour.
// The healing sweep (see healing.ts) has no hour config at all — it runs
// on every tick, after the two conditional jobs above.
export async function handleScheduled(
  env: Env,
  scheduledTimeMs: number,
  ctx?: ExecutionContext,
): Promise<void> {
  const currentHour = new Date(scheduledTimeMs).getUTCHours();

  if (parseHour(env.AGENT_HOUR_UTC) === currentHour) {
    await runAgentJob(env);
  }
  if (parseHour(env.DIGEST_HOUR_UTC) === currentHour) {
    await sendMorningDigest(env);
  }
  await runHealingJob(env, ctx);
}
