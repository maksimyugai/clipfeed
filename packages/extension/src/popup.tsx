import "./chrome.d.ts";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { parseTags } from "./lib/tags.ts";
import { getStoredConfig } from "./lib/config.ts";
import type { CheckSelectionResult, SaveErrorCategory, SaveResult } from "./lib/messages.ts";
import type { HtmlSource } from "./lib/payload.ts";
import "./shared.css";
import "./popup.css";

type ViewState = "loading" | "not_configured" | "ready" | "saving" | "saved" | "error";
type LastAction = "page" | "selection" | null;

function domainOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function errorHint(category: SaveErrorCategory): string | null {
  switch (category) {
    case "auth":
      return "Check your Access service token in settings.";
    case "server":
      return "The server returned an error — try again in a moment.";
    case "network":
      return "Could not reach the server — check your connection and server URL.";
    case "not_configured":
      return "Open settings to configure ClipFeed.";
    case "capture":
      return null;
  }
}

const gearIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

function PopupApp() {
  const [state, setState] = useState<ViewState>("loading");
  const [tabId, setTabId] = useState<number | null>(null);
  const [domain, setDomain] = useState("");
  const [title, setTitle] = useState("");
  const [hasSelection, setHasSelection] = useState(false);
  const [tagsInput, setTagsInput] = useState("");
  const [lastAction, setLastAction] = useState<LastAction>(null);
  const [savedArticleId, setSavedArticleId] = useState<string | null>(null);
  const [savedHtmlSource, setSavedHtmlSource] = useState<HtmlSource>("full");
  const [alreadySaved, setAlreadySaved] = useState(false);
  const [serverOrigin, setServerOrigin] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [errorCategory, setErrorCategory] = useState<SaveErrorCategory>("network");

  useEffect(() => {
    chrome.action.setBadgeText({ text: "" });

    (async () => {
      const config = await getStoredConfig();
      if (!config) {
        setState("not_configured");
        return;
      }
      setServerOrigin(config.serverOrigin);

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setErrorCategory("capture");
        setErrorMessage("Could not find the active tab.");
        setState("error");
        return;
      }
      setTabId(tab.id);
      setDomain(domainOf(tab.url));
      setTitle(tab.title ?? "");

      const selectionResult = await chrome.runtime.sendMessage<CheckSelectionResult>({
        type: "CHECK_SELECTION",
        tabId: tab.id,
      });
      setHasSelection(Boolean(selectionResult?.hasSelection));

      setState("ready");
    })();
  }, []);

  async function runSave(action: "page" | "selection") {
    if (tabId === null) return;
    setLastAction(action);
    setState("saving");

    const tags = parseTags(tagsInput);
    const message = action === "page"
      ? { type: "SAVE_PAGE" as const, tabId, tags }
      : { type: "SAVE_SELECTION" as const, tabId, tags };

    const result = await chrome.runtime.sendMessage<SaveResult>(message);

    if (result.ok) {
      setSavedArticleId(result.articleId);
      setSavedHtmlSource(result.htmlSource);
      setAlreadySaved(result.alreadySaved);
      setServerOrigin(result.serverOrigin);
      setState("saved");
    } else {
      setErrorCategory(result.errorCategory);
      setErrorMessage(result.message);
      setState("error");
    }
  }

  async function handleUndo() {
    if (!savedArticleId) {
      setState("ready");
      return;
    }
    setState("saving");
    const result = await chrome.runtime.sendMessage<SaveResult>({
      type: "UNDO",
      articleId: savedArticleId,
    });
    if (result.ok) {
      setSavedArticleId(null);
      setState("ready");
    } else {
      setErrorCategory(result.errorCategory);
      setErrorMessage(result.message);
      setState("error");
    }
  }

  function handleOpenFeed() {
    if (serverOrigin) chrome.tabs.create({ url: serverOrigin });
  }

  function handleOpenSettings() {
    chrome.runtime.openOptionsPage();
  }

  function handleRetry() {
    if (lastAction) {
      runSave(lastAction);
    } else {
      setState("ready");
    }
  }

  return (
    <div class="popup">
      <div class="popup-strip" />
      <header class="popup-header">
        <span class="popup-wordmark">clipfeed</span>
        <button
          type="button"
          class="popup-gear"
          onClick={handleOpenSettings}
          aria-label="Settings"
          title="Settings"
        >
          {gearIcon}
        </button>
      </header>

      <main class="popup-body">
        {state === "loading" && <p class="popup-muted">Loading…</p>}

        {state === "not_configured" && (
          <div class="popup-empty">
            <p>ClipFeed is not configured yet.</p>
            <button type="button" class="popup-primary" onClick={handleOpenSettings}>
              Open settings
            </button>
          </div>
        )}

        {(state === "ready" || state === "saving") && (
          <>
            <p class="popup-domain">{domain}</p>
            <p class="popup-title">{title}</p>
            <input
              class="popup-tags"
              type="text"
              placeholder="tags, comma, separated"
              value={tagsInput}
              disabled={state === "saving"}
              onInput={(e) => setTagsInput((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              class="popup-primary"
              disabled={state === "saving"}
              onClick={() => runSave("page")}
            >
              {state === "saving" && lastAction === "page"
                ? <span class="popup-spinner" />
                : "Save page"}
            </button>
            <button
              type="button"
              class="popup-secondary"
              disabled={state === "saving" || !hasSelection}
              onClick={() => runSave("selection")}
            >
              {state === "saving" && lastAction === "selection"
                ? <span class="popup-spinner" />
                : "or save selected text"}
            </button>
          </>
        )}

        {state === "saved" && (
          <div class="popup-card popup-card--ok">
            <p class="popup-card-title">
              {alreadySaved ? "Already saved" : "Saved — summary in ~10s"}
            </p>
            {savedHtmlSource === "none" && (
              <p class="popup-card-hint">
                Sent without page HTML — the server will fetch it directly.
              </p>
            )}
            <div class="popup-card-actions">
              <button type="button" class="popup-primary" onClick={handleOpenFeed}>
                Open feed
              </button>
              {!alreadySaved && savedArticleId && (
                <button type="button" class="popup-secondary" onClick={handleUndo}>
                  Undo
                </button>
              )}
            </div>
          </div>
        )}

        {state === "error" && (
          <div class="popup-card popup-card--error">
            <p class="popup-card-title">{errorMessage}</p>
            {errorHint(errorCategory) && <p class="popup-card-hint">{errorHint(errorCategory)}</p>}
            <div class="popup-card-actions">
              <button type="button" class="popup-primary" onClick={handleRetry}>
                Retry
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const root = document.getElementById("app");
if (root) {
  render(<PopupApp />, root);
}
