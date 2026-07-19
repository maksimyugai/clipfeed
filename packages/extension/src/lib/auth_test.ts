import { assertEquals } from "@std/assert";
import { buildAuthHeaders } from "./auth.ts";

Deno.test("buildAuthHeaders: returns the two CF-Access-* headers", () => {
  assertEquals(buildAuthHeaders("client-id-123", "client-secret-456"), {
    "CF-Access-Client-Id": "client-id-123",
    "CF-Access-Client-Secret": "client-secret-456",
  });
});
