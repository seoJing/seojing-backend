import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("public request rate limit", () => {
  it("allows health probes but limits repeated unauthenticated requests", async () => {
    const app = await buildApp();

    for (let index = 0; index < 130; index += 1) {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    }

    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({ method: "GET", url: "/missing" });
      expect(response.statusCode).toBe(404);
    }

    const blocked = await app.inject({ method: "GET", url: "/missing" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.json()).toEqual({ error: "Too many requests" });

    await app.close();
  });

  it("does not rate limit protected admin and OAuth entry routes", async () => {
    const app = await buildApp();

    for (let index = 0; index < 121; index += 1) {
      const admin = await app.inject({ method: "GET", url: "/admin/articles" });
      expect(admin.statusCode).not.toBe(429);
      const oauth = await app.inject({
        method: "GET",
        url: "/community/auth/github",
      });
      expect(oauth.statusCode).not.toBe(429);
    }

    await app.close();
  });

  it("uses the peer address when a non-proxy request supplies a Cloudflare header", async () => {
    const app = await buildApp();

    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/missing",
        remoteAddress: "198.51.100.10",
        headers: { "cf-connecting-ip": `203.0.113.${index}` },
      });
      expect(response.statusCode).toBe(404);
    }

    const blocked = await app.inject({
      method: "GET",
      url: "/missing",
      remoteAddress: "198.51.100.10",
      headers: { "cf-connecting-ip": "203.0.113.250" },
    });
    expect(blocked.statusCode).toBe(429);

    await app.close();
  });
});
