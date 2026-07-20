// Idempotent one-time setup for a fork: creates or reuses D1 + KV resources
// in the caller's own Cloudflare account, patches the wrangler.toml
// placeholders, applies migrations remotely, and reports which secrets still
// need setting. Deno.* APIs are fine here — this is a local dev-tooling
// script, not code that ships to the Worker.

const WRANGLER_TOML_PATH = "wrangler.toml";
const D1_DB_NAME = "clipfeed";
const KV_BINDING = "CACHE";
const QUEUE_NAME = "clipfeed-jobs";
const DLQ_NAME = "clipfeed-dlq";

interface WranglerResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runWrangler(args: string[]): Promise<WranglerResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "npm:wrangler", ...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// --- Pure, testable wrangler.toml patching logic ---
// Kept separate from the wrangler shell-outs above so it can be unit tested
// against fixture strings without ever invoking wrangler for real.

export function readD1DatabaseId(toml: string): string | null {
  return toml.match(/database_id\s*=\s*"([^"]*)"/)?.[1] ?? null;
}

export function patchD1DatabaseId(toml: string, databaseId: string): string {
  return toml.replace(/database_id\s*=\s*"PLACEHOLDER"/, `database_id = "${databaseId}"`);
}

export function readKvNamespaceId(toml: string): string | null {
  return toml.match(/\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]*)"/)?.[1] ?? null;
}

export function patchKvNamespaceId(toml: string, kvId: string): string {
  // Scoped to the [[kv_namespaces]] block so this never touches D1's
  // similarly-shaped `database_id = "PLACEHOLDER"` line.
  return toml.replace(
    /(\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*)"PLACEHOLDER"/,
    `$1"${kvId}"`,
  );
}

export function extractDatabaseId(wranglerOutput: string): string | null {
  return wranglerOutput.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1] ?? null;
}

export function extractKvId(wranglerOutput: string): string | null {
  return wranglerOutput.match(/\bid\s*=\s*"([0-9a-f]{32})"/)?.[1] ?? null;
}

export function findExistingD1Id(
  databases: { name: string; uuid: string }[],
  dbName: string,
): string | null {
  return databases.find((db) => db.name === dbName)?.uuid ?? null;
}

// `wrangler kv namespace create <binding>` titles the namespace exactly
// <binding> (no project-name prefix, at least on wrangler 4.x) — matched
// this way after a real setup run produced a namespace titled plain "CACHE",
// not "clipfeed-CACHE" as an earlier version of this function assumed.
export function findExistingKvId(
  namespaces: { id: string; title: string }[],
  binding: string,
): string | null {
  return namespaces.find((ns) => ns.title === binding)?.id ?? null;
}

// Unlike D1's database_id / KV's namespace id, a queue's name is not
// account-scoped — it's the literal string already committed in
// wrangler.toml ("clipfeed-jobs"), so there's no placeholder to patch here,
// just an idempotent existence check against `wrangler queues list`'s
// output. That command has no --json flag (unlike `d1 list`), so this
// parses its box-drawing ASCII table instead: every real data/header row
// uses "│" as the cell separator, so splitting on it and checking the
// second column (the name) works; border rows (drawn with ─/┌/├/└, no "│")
// naturally fail the length check below and are skipped.
export function queueExistsInList(listOutput: string, name: string): boolean {
  return listOutput.split("\n").some((line) => {
    const cells = line.split("│").map((c) => c.trim()).filter((c) => c.length > 0);
    return cells.length >= 2 && cells[1] === name;
  });
}

// --- Orchestration ---

async function ensureAuthenticated(): Promise<void> {
  const result = await runWrangler(["whoami"]);
  if (!/you are logged in/i.test(result.stdout)) {
    console.error("Not logged in to Cloudflare. Run this, then re-run `deno task setup`:\n");
    console.error("  deno run -A npm:wrangler login\n");
    Deno.exit(1);
  }
  console.log("✓ Authenticated with Cloudflare\n");
}

async function ensureD1(toml: string, created: string[], reused: string[]): Promise<string> {
  if (readD1DatabaseId(toml) !== "PLACEHOLDER") {
    reused.push(`D1 database_id already set in wrangler.toml (${readD1DatabaseId(toml)})`);
    return toml;
  }

  const list = await runWrangler(["d1", "list", "--json"]);
  let existingId: string | null = null;
  if (list.code === 0) {
    try {
      const databases = JSON.parse(list.stdout) as { name: string; uuid: string }[];
      existingId = findExistingD1Id(databases, D1_DB_NAME);
    } catch {
      // Unparseable list output — fall through to create.
    }
  }

  if (existingId) {
    reused.push(`D1 database "${D1_DB_NAME}" (${existingId})`);
    return patchD1DatabaseId(toml, existingId);
  }

  const create = await runWrangler(["d1", "create", D1_DB_NAME]);
  const newId = extractDatabaseId(create.stdout);
  if (!newId) {
    console.error("Could not parse a database_id from `wrangler d1 create` output:\n");
    console.error(create.stdout || create.stderr);
    Deno.exit(1);
  }
  created.push(`D1 database "${D1_DB_NAME}" (${newId})`);
  return patchD1DatabaseId(toml, newId);
}

async function ensureKv(toml: string, created: string[], reused: string[]): Promise<string> {
  if (readKvNamespaceId(toml) !== "PLACEHOLDER") {
    reused.push(`KV namespace id already set in wrangler.toml (${readKvNamespaceId(toml)})`);
    return toml;
  }

  const list = await runWrangler(["kv", "namespace", "list"]);
  let existingId: string | null = null;
  if (list.code === 0) {
    try {
      const namespaces = JSON.parse(list.stdout) as { id: string; title: string }[];
      existingId = findExistingKvId(namespaces, KV_BINDING);
    } catch {
      // Unparseable list output — fall through to create.
    }
  }

  if (existingId) {
    reused.push(`KV namespace for ${KV_BINDING} (${existingId})`);
    return patchKvNamespaceId(toml, existingId);
  }

  const create = await runWrangler(["kv", "namespace", "create", KV_BINDING]);
  const newId = extractKvId(create.stdout);
  if (!newId) {
    console.error("Could not parse a namespace id from `wrangler kv namespace create` output:\n");
    console.error(create.stdout || create.stderr);
    Deno.exit(1);
  }
  created.push(`KV namespace for ${KV_BINDING} (${newId})`);
  return patchKvNamespaceId(toml, newId);
}

async function ensureQueue(name: string, created: string[], reused: string[]): Promise<void> {
  const list = await runWrangler(["queues", "list"]);
  if (list.code === 0 && queueExistsInList(list.stdout, name)) {
    reused.push(`Queue "${name}" already exists`);
    return;
  }

  const create = await runWrangler(["queues", "create", name]);
  if (create.code !== 0) {
    console.error(`Could not create queue "${name}":\n`);
    console.error(create.stdout || create.stderr);
    Deno.exit(1);
  }
  created.push(`Queue "${name}"`);
}

async function applyMigrations(): Promise<void> {
  console.log("Applying D1 migrations to the remote database...\n");
  const result = await runWrangler(["d1", "migrations", "apply", "DB", "--remote"]);
  console.log(result.stdout);
  if (result.code !== 0) {
    console.error(result.stderr);
    console.error("Migration failed — fix the above and re-run `deno task setup`.");
    Deno.exit(1);
  }
}

// Only checks which secret NAMES are set (Cloudflare's API never exposes
// values) — this script never reads or prints a secret value.
async function reportSecrets(): Promise<void> {
  const result = await runWrangler(["secret", "list"]);
  let existing = new Set<string>();
  if (result.code === 0) {
    try {
      existing = new Set((JSON.parse(result.stdout) as { name: string }[]).map((s) => s.name));
    } catch {
      // Worker probably hasn't been deployed yet — treat as no secrets set.
    }
  }

  const status = (name: string) => existing.has(name) ? "set" : "NOT SET";
  console.log("Secrets (checked by name only, values are never read or printed):");
  console.log(`  ANTHROPIC_API_KEY (direct mode):  ${status("ANTHROPIC_API_KEY")}`);
  console.log(`  AI_GATEWAY_URL (gateway mode):     ${status("AI_GATEWAY_URL")}`);
  console.log(`  CF_AIG_TOKEN (gateway mode):       ${status("CF_AIG_TOKEN")}\n`);

  console.log("Choose ONE LLM mode and set its secret(s):\n");
  console.log("  Direct mode (simplest):");
  console.log("    deno run -A npm:wrangler secret put ANTHROPIC_API_KEY\n");
  console.log("  AI Gateway mode (recommended — usage/cost visibility, provider-key rotation");
  console.log("  without a redeploy):");
  console.log('    1. Create a Gateway named "clipfeed" in the dashboard (AI > AI Gateway).');
  console.log("    2. Store a provider key (BYOK) or load Unified Billing credits on it.");
  console.log("    deno run -A npm:wrangler secret put AI_GATEWAY_URL");
  console.log(
    "    deno run -A npm:wrangler secret put CF_AIG_TOKEN   (only if the gateway requires auth)",
  );
}

function printChecklist(created: string[], reused: string[]): void {
  console.log("\n──────────────────────────────────────────");
  console.log("Setup summary");
  console.log("──────────────────────────────────────────");
  if (created.length > 0) {
    console.log("Created:");
    for (const item of created) console.log(`  - ${item}`);
  }
  if (reused.length > 0) {
    console.log("Reused / already configured:");
    for (const item of reused) console.log(`  - ${item}`);
  }
  console.log("\nManual steps remaining:");
  console.log(
    "  - wrangler.toml was patched with real IDs — review the diff and commit it yourself.",
  );
  console.log(
    "  - If using AI Gateway: create it in the dashboard and store/load provider credentials.",
  );
  console.log("  - Set the secret(s) printed above for your chosen LLM mode.");
  console.log("  - Set up Cloudflare Access in front of the Worker (a later task automates this).");
  console.log("  - Deploy: deno task deploy");
  console.log("──────────────────────────────────────────");
}

async function main(): Promise<void> {
  console.log("ClipFeed setup\n");

  await ensureAuthenticated();

  let toml = await Deno.readTextFile(WRANGLER_TOML_PATH);
  const created: string[] = [];
  const reused: string[] = [];

  toml = await ensureD1(toml, created, reused);
  toml = await ensureKv(toml, created, reused);

  await Deno.writeTextFile(WRANGLER_TOML_PATH, toml);
  console.log("✓ wrangler.toml updated in place (left uncommitted — review before committing)\n");

  await ensureQueue(QUEUE_NAME, created, reused);
  // The dead-letter queue (see wrangler.toml's dead_letter_queue on the
  // main consumer) — same provisioning story, no id/placeholder to patch,
  // just needs to exist before deploy or `wrangler deploy` fails outright
  // (Cloudflare validates dead_letter_queue references at deploy time).
  await ensureQueue(DLQ_NAME, created, reused);
  await applyMigrations();
  console.log();
  await reportSecrets();
  printChecklist(created, reused);
}

if (import.meta.main) {
  await main();
}
