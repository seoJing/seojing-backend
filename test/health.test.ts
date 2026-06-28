import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("health endpoint", () => {
  it("returns the service health contract", async () => {
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "seojing-backend",
    });

    await app.close();
  });
});
