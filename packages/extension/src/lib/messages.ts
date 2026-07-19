import type { HtmlSource } from "./payload.ts";

// Runtime messages sent from popup.tsx to background.ts. Background owns all
// fetch()/credential access; the popup only dispatches intents and renders
// whatever comes back, so an in-progress save survives the popup closing.
export type ExtensionMessage =
  | { type: "SAVE_PAGE"; tabId: number; tags: string[] }
  | { type: "SAVE_SELECTION"; tabId: number; tags: string[] }
  | { type: "UNDO"; articleId: string }
  | { type: "CHECK_SELECTION"; tabId: number };

export type SaveErrorCategory = "not_configured" | "capture" | "auth" | "server" | "network";

export type SaveResult =
  | {
    ok: true;
    alreadySaved: boolean;
    articleId: string | null;
    htmlSource: HtmlSource;
    serverOrigin: string;
  }
  | { ok: false; errorCategory: SaveErrorCategory; message: string };

export type CheckSelectionResult = { ok: true; hasSelection: boolean };
