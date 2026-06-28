import { describe, expect, it } from "vitest";

import {
  PythonWorkerClient,
  PythonWorkerError,
} from "../src/services/python-worker.js";

describe("PythonWorkerClient", () => {
  it("rejects non-loopback worker URLs", () => {
    expect(
      () => new PythonWorkerClient({ baseUrl: "https://worker.example.com" }),
    ).toThrow(PythonWorkerError);
  });

  it("accepts IPv6 loopback worker URLs", () => {
    expect(
      () => new PythonWorkerClient({ baseUrl: "http://[::1]:4037" }),
    ).not.toThrow();
  });

  it("calls the loopback worker health endpoint with internal headers", async () => {
    const calls: Array<{
      input: URL | Parameters<typeof fetch>[0];
      init?: RequestInit;
    }> = [];
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        Response.json({
          status: "ok",
          worker: "seojing-python-worker",
          capabilities: ["tts", "qa"],
        }),
      );
    };
    const client = new PythonWorkerClient({
      baseUrl: "http://127.0.0.1:4037",
      fetchImpl,
    });

    await expect(client.health({ requestId: "req-1" })).resolves.toEqual({
      status: "ok",
      worker: "seojing-python-worker",
      capabilities: ["tts", "qa"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual(new URL("http://127.0.0.1:4037/health"));
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toMatchObject({
      "x-seojing-internal-worker": "python",
      "x-request-id": "req-1",
    });
  });

  it("does not retry non-idempotent task invocation", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = () => {
      callCount += 1;
      return Promise.resolve(new Response("failed", { status: 503 }));
    };
    const client = new PythonWorkerClient({
      baseUrl: "http://localhost:4037",
      retryAttempts: 3,
      fetchImpl,
    });

    await expect(client.invoke("tts", { text: "hello" })).rejects.toMatchObject(
      {
        code: "upstream_error",
        statusCode: 503,
      },
    );
    expect(callCount).toBe(1);
  });

  it("retries health checks on transient worker failures", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = () => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response("failed", { status: 503 }));
      }
      return Promise.resolve(
        Response.json({
          status: "ok",
          worker: "seojing-python-worker",
          capabilities: ["rag"],
        }),
      );
    };
    const client = new PythonWorkerClient({
      baseUrl: "http://localhost:4037",
      retryAttempts: 2,
      fetchImpl,
    });

    await expect(client.health()).resolves.toMatchObject({
      status: "ok",
      capabilities: ["rag"],
    });
    expect(callCount).toBe(2);
  });
});
