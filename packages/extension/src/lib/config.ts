import "../chrome.d.ts";

export interface StoredConfig {
  serverOrigin: string;
  clientId: string;
  clientSecret: string;
}

const KEYS = ["serverOrigin", "clientId", "clientSecret"] as const;

export async function getStoredConfig(): Promise<StoredConfig | null> {
  const data = await chrome.storage.local.get([...KEYS]);
  const { serverOrigin, clientId, clientSecret } = data;
  if (
    typeof serverOrigin !== "string" || !serverOrigin ||
    typeof clientId !== "string" || !clientId ||
    typeof clientSecret !== "string" || !clientSecret
  ) {
    return null;
  }
  return { serverOrigin, clientId, clientSecret };
}

export async function setStoredConfig(config: StoredConfig): Promise<void> {
  await chrome.storage.local.set(config);
}
