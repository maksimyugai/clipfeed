import "./chrome.d.ts";
import type { AddedVia, CreateArticleRequest, CreateArticleResponse } from "@clipfeed/shared/types";
import { buildAuthHeaders } from "./lib/auth.ts";
import { getStoredConfig, type StoredConfig } from "./lib/config.ts";
import type { HtmlSource } from "./lib/payload.ts";
import type { CheckSelectionResult, ExtensionMessage, SaveResult } from "./lib/messages.ts";

const ADDED_VIA: AddedVia = "extension";
const BADGE_SUCCESS_MS = 4000;

interface CapturedContent {
  url: string;
  title: string;
  html: string | null;
  htmlSource: HtmlSource;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Two-step injection: (1) load the bundled content script for its side
// effect of registering a page-global capture function — it can't be run
// directly via `func:` because `func:` only stringifies the function itself,
// losing the bundled Readability code it closes over; (2) invoke that global
// with a tiny, closure-free `func:` whose Promise/return value Chrome
// reliably captures.
async function runCapture<T>(tabId: number, file: string, globalName: string): Promise<T> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  const [{ result }] = await chrome.scripting.executeScript<[string], T>({
    target: { tabId },
    func: (name) => (globalThis as unknown as Record<string, () => unknown>)[name]?.() as T,
    args: [globalName],
  });
  return result;
}

async function setBadgeSuccess(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#2fa36b" });
  await chrome.action.setBadgeText({ text: "✓" });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, BADGE_SUCCESS_MS);
}

async function setBadgeError(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#d64545" });
  await chrome.action.setBadgeText({ text: "!" });
}

async function postArticle(
  config: StoredConfig,
  body: CreateArticleRequest,
  htmlSource: HtmlSource,
): Promise<SaveResult> {
  let response: Response;
  try {
    response = await fetch(`${config.serverOrigin}/api/admin/articles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(config.clientId, config.clientSecret),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    await setBadgeError();
    return { ok: false, errorCategory: "network", message: describeError(err) };
  }

  if (response.status === 401 || response.status === 403) {
    await setBadgeError();
    return {
      ok: false,
      errorCategory: "auth",
      message: "Access denied — check your service token.",
    };
  }

  if (response.status === 409) {
    const data = await response.json().catch(() => null) as CreateArticleResponse | null;
    await setBadgeSuccess();
    return {
      ok: true,
      alreadySaved: true,
      articleId: data?.id ?? null,
      htmlSource,
      serverOrigin: config.serverOrigin,
    };
  }

  if (!response.ok) {
    await setBadgeError();
    return { ok: false, errorCategory: "server", message: `Server error (${response.status}).` };
  }

  const data = await response.json() as CreateArticleResponse;
  await setBadgeSuccess();
  return {
    ok: true,
    alreadySaved: false,
    articleId: data.id,
    htmlSource,
    serverOrigin: config.serverOrigin,
  };
}

async function saveCapture(
  tabId: number,
  tags: string[],
  file: string,
  globalName: string,
): Promise<SaveResult> {
  const config = await getStoredConfig();
  if (!config) {
    return {
      ok: false,
      errorCategory: "not_configured",
      message: "ClipFeed is not configured yet — open settings first.",
    };
  }

  let captured: CapturedContent | null;
  try {
    captured = await runCapture<CapturedContent | null>(tabId, file, globalName);
  } catch (err) {
    await setBadgeError();
    return { ok: false, errorCategory: "capture", message: describeError(err) };
  }
  if (!captured) {
    await setBadgeError();
    return { ok: false, errorCategory: "capture", message: "Nothing to save on this page." };
  }

  const body: CreateArticleRequest = {
    url: captured.url,
    title: captured.title,
    tags,
    added_via: ADDED_VIA,
    ...(captured.html !== null ? { html: captured.html } : {}),
  };
  return await postArticle(config, body, captured.htmlSource);
}

async function savePage(tabId: number, tags: string[]): Promise<SaveResult> {
  return await saveCapture(tabId, tags, "content-page.js", "__clipfeed_capturePage");
}

async function saveSelection(tabId: number, tags: string[]): Promise<SaveResult> {
  const selectionTags = tags.includes("фрагмент") ? tags : [...tags, "фрагмент"];
  return await saveCapture(
    tabId,
    selectionTags,
    "content-selection.js",
    "__clipfeed_captureSelection",
  );
}

async function undoSave(articleId: string): Promise<SaveResult> {
  const config = await getStoredConfig();
  if (!config) {
    return {
      ok: false,
      errorCategory: "not_configured",
      message: "ClipFeed is not configured yet.",
    };
  }
  try {
    const response = await fetch(`${config.serverOrigin}/api/admin/articles/${articleId}`, {
      method: "DELETE",
      headers: buildAuthHeaders(config.clientId, config.clientSecret),
    });
    if (!response.ok && response.status !== 404) {
      return {
        ok: false,
        errorCategory: "server",
        message: `Could not undo (${response.status}).`,
      };
    }
    return {
      ok: true,
      alreadySaved: false,
      articleId: null,
      htmlSource: "none",
      serverOrigin: config.serverOrigin,
    };
  } catch (err) {
    return { ok: false, errorCategory: "network", message: describeError(err) };
  }
}

async function checkSelection(tabId: number): Promise<CheckSelectionResult> {
  try {
    const [{ result }] = await chrome.scripting.executeScript<[], boolean>({
      target: { tabId },
      func: () => {
        const sel = globalThis.getSelection?.();
        return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
      },
    });
    return { ok: true, hasSelection: Boolean(result) };
  } catch {
    return { ok: true, hasSelection: false };
  }
}

async function handleMessage(
  message: ExtensionMessage,
): Promise<SaveResult | CheckSelectionResult> {
  switch (message.type) {
    case "SAVE_PAGE":
      return await savePage(message.tabId, message.tags);
    case "SAVE_SELECTION":
      return await saveSelection(message.tabId, message.tags);
    case "UNDO":
      return await undoSave(message.articleId);
    case "CHECK_SELECTION":
      return await checkSelection(message.tabId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message as ExtensionMessage).then(sendResponse);
  return true;
});
