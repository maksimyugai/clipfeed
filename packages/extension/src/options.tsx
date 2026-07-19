import "./chrome.d.ts";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { normalizeServerOrigin } from "./lib/url.ts";
import { buildAuthHeaders } from "./lib/auth.ts";
import { getStoredConfig, setStoredConfig } from "./lib/config.ts";
import "./shared.css";
import "./options.css";

type Status = "idle" | "saving" | "connected" | "error";

function OptionsApp() {
  const [serverUrl, setServerUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    getStoredConfig().then((config) => {
      if (config) {
        setServerUrl(config.serverOrigin);
        setClientId(config.clientId);
        setClientSecret(config.clientSecret);
      }
    });
  }, []);

  async function handleSave(e: Event) {
    e.preventDefault();
    setMessage(null);

    const normalized = normalizeServerOrigin(serverUrl);
    if (!normalized.ok) {
      setStatus("error");
      setMessage(normalized.error);
      return;
    }
    const origin = normalized.origin;

    setStatus("saving");

    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      setStatus("error");
      setMessage("Permission to access this server was declined — settings were not saved.");
      return;
    }

    try {
      const healthRes = await fetch(`${origin}/api/health`);
      if (!healthRes.ok) {
        setStatus("error");
        setMessage(`Could not reach the server (health check returned ${healthRes.status}).`);
        return;
      }

      const articlesRes = await fetch(`${origin}/api/articles?limit=1`, {
        headers: buildAuthHeaders(clientId, clientSecret),
      });
      if (articlesRes.status === 401 || articlesRes.status === 403) {
        setStatus("error");
        setMessage("Authentication failed — check your service token / Access policy.");
        return;
      }
      if (!articlesRes.ok) {
        setStatus("error");
        setMessage(`Unexpected response from the server (${articlesRes.status}).`);
        return;
      }
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
      return;
    }

    await setStoredConfig({ serverOrigin: origin, clientId, clientSecret });
    setServerUrl(origin);
    setStatus("connected");
    setMessage("Connected ✓");
  }

  return (
    <form class="options-form" onSubmit={handleSave}>
      <h1 class="options-title">clipfeed</h1>
      <p class="options-hint">
        Point the extension at your own ClipFeed instance and its Access service token.
      </p>

      <label class="options-field">
        <span>Server URL</span>
        <input
          type="text"
          placeholder="https://clipfeed.example.com"
          value={serverUrl}
          onInput={(e) => setServerUrl((e.target as HTMLInputElement).value)}
        />
      </label>

      <label class="options-field">
        <span>Access Client ID</span>
        <input
          type="text"
          value={clientId}
          onInput={(e) => setClientId((e.target as HTMLInputElement).value)}
        />
      </label>

      <label class="options-field">
        <span>Access Client Secret</span>
        <input
          type="password"
          value={clientSecret}
          onInput={(e) => setClientSecret((e.target as HTMLInputElement).value)}
        />
      </label>

      <button type="submit" class="options-save" disabled={status === "saving"}>
        {status === "saving" ? "Checking…" : "Save"}
      </button>

      {message && <p class={`options-status options-status--${status}`}>{message}</p>}

      <p class="options-note">
        Credentials are stored unencrypted in this browser profile (chrome.storage.local) and never
        synced across devices. If this machine is compromised, rotate the service token in
        Cloudflare Zero Trust.
      </p>
    </form>
  );
}

const root = document.getElementById("app");
if (root) {
  render(<OptionsApp />, root);
}
