// Cloudflare Access Service Token headers — converted by Access into the same
// JWT the Worker's middleware verifies (see packages/api/src/auth/access.ts).
export function buildAuthHeaders(clientId: string, clientSecret: string): Record<string, string> {
  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  };
}
