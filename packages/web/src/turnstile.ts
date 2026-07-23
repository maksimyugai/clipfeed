import { loadRawConfig } from "./lib/config.ts";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Thrown for any client-side failure to acquire a token (script failed to
// load, widget errored, etc.) — a distinct sentinel so the caller can show
// the same human message it shows for the server's turnstile_* error codes.
export const TURNSTILE_CLIENT_ERROR = "turnstile_client_error";

interface TurnstileWidgetOptions {
  sitekey: string;
  appearance?: "always" | "execute" | "interaction-only";
  callback?: (token: string) => void;
  "error-callback"?: () => void;
}

interface TurnstileGlobal {
  render(container: HTMLElement, options: TurnstileWidgetOptions): string;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
}

declare global {
  var turnstile: TurnstileGlobal | undefined;
}

// Reads its slice of the single shared GET /api/config fetch (see
// lib/config.ts). A fetch failure is treated the same as "inactive" — this
// must never block the app from working; if Turnstile is really active, the
// server's own check on the next mutation attempt is the source of truth and
// surfaces the error.
export async function loadTurnstileSiteKey(): Promise<string | null> {
  const body = await loadRawConfig();
  return body.turnstile_site_key ?? null;
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (globalThis.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(TURNSTILE_CLIENT_ERROR));
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

let widgetId: string | null = null;
let pendingResolve: ((token: string) => void) | null = null;
let pendingReject: ((err: Error) => void) | null = null;

// Renders the widget once, off-screen — "interaction-only" appearance means
// it stays invisible unless Cloudflare itself decides a visible challenge is
// needed, matching the "must never visibly pop except Cloudflare's own
// interstitial" requirement.
function ensureWidget(siteKey: string): string {
  if (widgetId) return widgetId;

  const turnstileGlobal = globalThis.turnstile;
  if (!turnstileGlobal) throw new Error(TURNSTILE_CLIENT_ERROR);

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = "-9999px";
  container.style.left = "-9999px";
  container.style.pointerEvents = "none";
  document.body.appendChild(container);

  widgetId = turnstileGlobal.render(container, {
    sitekey: siteKey,
    appearance: "interaction-only",
    callback: (token) => {
      pendingResolve?.(token);
      pendingResolve = null;
      pendingReject = null;
    },
    "error-callback": () => {
      pendingReject?.(new Error(TURNSTILE_CLIENT_ERROR));
      pendingResolve = null;
      pendingReject = null;
    },
  });
  return widgetId;
}

// Acquires a fresh, single-use Turnstile token. Tokens can't be reused
// across requests, so every mutation attempt calls this again — reset()
// clears the widget's previous token before execute() requests a new one
// from the same (already-rendered) widget instance.
export async function getTurnstileToken(siteKey: string): Promise<string> {
  await loadScript();
  const turnstileGlobal = globalThis.turnstile;
  if (!turnstileGlobal) throw new Error(TURNSTILE_CLIENT_ERROR);

  const id = ensureWidget(siteKey);

  return new Promise<string>((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    try {
      turnstileGlobal.reset(id);
      turnstileGlobal.execute(id);
    } catch (err) {
      pendingResolve = null;
      pendingReject = null;
      reject(err instanceof Error ? err : new Error(TURNSTILE_CLIENT_ERROR));
    }
  });
}
