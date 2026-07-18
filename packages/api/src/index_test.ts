import app from "./index.ts";

Deno.test("GET /api/health returns ok", async () => {
  const res = await app.request("/api/health");
  if (res.status !== 200) {
    throw new Error(`expected status 200, got ${res.status}`);
  }
  const body = await res.json();
  if (body.ok !== true) {
    throw new Error(`expected ok: true, got ${JSON.stringify(body)}`);
  }
  if (typeof body.ts !== "string") {
    throw new Error(`expected ts to be a string, got ${typeof body.ts}`);
  }
});
