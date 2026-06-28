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

  it("returns readiness when Python worker is not configured", async () => {
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "seojing-backend",
      dependencies: {
        pythonWorker: {
          status: "not_configured",
          required: false,
        },
      },
    });

    await app.close();
  });

  it("returns dependency readiness when Python worker is configured", async () => {
    const app = await buildApp({
      pythonWorkerClient: {
        health: () =>
          Promise.resolve({
            status: "ok",
            worker: "seojing-python-worker",
            capabilities: ["tts", "rag"],
          }),
      },
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "seojing-backend",
      dependencies: {
        pythonWorker: {
          status: "ok",
          required: true,
          capabilities: ["tts", "rag"],
        },
      },
    });

    await app.close();
  });

  it("reflects degraded Python worker readiness", async () => {
    const app = await buildApp({
      pythonWorkerClient: {
        health: () =>
          Promise.resolve({
            status: "degraded",
            worker: "seojing-python-worker",
            capabilities: ["tts"],
          }),
      },
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "degraded",
      service: "seojing-backend",
      dependencies: {
        pythonWorker: {
          status: "degraded",
          required: true,
          capabilities: ["tts"],
        },
      },
    });

    await app.close();
  });

  it("fails readiness when a required Python worker is unavailable", async () => {
    const app = await buildApp({
      pythonWorkerClient: {
        health: () => Promise.reject(new Error("worker down")),
      },
    });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      service: "seojing-backend",
      dependencies: {
        pythonWorker: {
          status: "unavailable",
          required: true,
        },
      },
    });

    await app.close();
  });
});
