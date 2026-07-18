import "./env.d.ts";
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
