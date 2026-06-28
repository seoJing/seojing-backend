import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

interface OpenApiContract {
  info: {
    title: string;
  };
  paths: Record<string, unknown>;
}

const okayjingOpsOnlyPaths = [
  "/ops/summary",
  "/ops/capabilities",
  "/tickets",
  "/work-items",
  "/habitat/gateway-events",
  "/profiles",
  "/sessions",
  "/artifacts",
];

describe("public SEOJing API boundary", () => {
  it("does not expose OkayJing habitat/control-plane routes", async () => {
    const app = await buildApp();

    for (const path of okayjingOpsOnlyPaths) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(404);
    }

    await app.close();
  });

  it("keeps SEOJing public endpoints on the Node API surface", async () => {
    const app = await buildApp();

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.json()).toMatchObject({
      name: "seojing-backend",
      status: "ok",
      docs: "/docs",
      openapi: "/openapi.json",
    });

    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    const contract = openapi.json<OpenApiContract>();
    expect(contract.info.title).toBe("SEOJing Backend API");
    const publicPaths = Object.keys(contract.paths);
    for (const path of [
      "/health",
      "/health/ready",
      "/articles",
      "/articles/{slug}/qa",
      "/tts/summary",
    ]) {
      expect(publicPaths, path).toContain(path);
    }

    await app.close();
  });
});
