import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LabClientError,
  ReadmeLabClient,
  type ConnectionUpdate,
} from "../src/services/readme-lab/browser-client.js";
import { designFixtures } from "../src/services/readme-lab/tools/design-fixtures.js";

const final = designFixtures().short.final;
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("lab browser transport", () => {
  it("sends a consent version only when explicitly supplied by the caller", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        response({
          access_token: "synthetic-test-token",
          expires_at: "2099-01-01",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new ReadmeLabClient();
    await client.session("synthetic-code", true);
    await client.session("synthetic-code", true, undefined, "readme-jev-v1");
    await client.session("synthetic-code", false, undefined, "readme-jev-v1");
    const bodies = fetcher.mock.calls.map(
      ([, init]) =>
        JSON.parse(
          typeof init?.body === "string" ? init.body : "null",
        ) as unknown,
    );
    expect(bodies).toEqual([
      { invite_code: "synthetic-code", cloud_consent: true },
      {
        invite_code: "synthetic-code",
        cloud_consent: true,
        consent_version: "readme-jev-v1",
      },
      {
        invite_code: "synthetic-code",
        cloud_consent: false,
        consent_version: "readme-jev-v1",
      },
    ]);
  });
  it("reconnects when the response body stream fails after successful headers", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("Network interrupted"));
            },
          }),
        ),
      )
      .mockResolvedValueOnce(response(final));
    vi.stubGlobal("fetch", fetcher);
    const watch = new ReadmeLabClient().watchJob(
      "j",
      new AbortController().signal,
    );
    const next = watch.next();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await next).value?.view?.status).toBe("completed");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await watch.return();
  });
  it("maps HTML upstream errors without exposing their body and preserves API codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html>private proxy details</html>", { status: 524 }),
        )
        .mockResolvedValueOnce(response({ error: "expired" }, 410)),
    );
    const client = new ReadmeLabClient();
    await expect(client.getJob("j")).rejects.toMatchObject({
      code: "upstream_unavailable",
      status: 524,
      message: "upstream_unavailable",
    });
    await expect(client.getJob("j")).rejects.toMatchObject({
      code: "expired",
      status: 410,
    });
  });
  it("retains the last cursor and notes after a dropped poll without duplicate events", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          ...final,
          status: "reading",
          events: final.events.slice(0, 2),
          next_seq: 2,
          report: null,
        }),
      )
      .mockRejectedValueOnce(new TypeError("Network lost"))
      .mockResolvedValueOnce(response(final));
    vi.stubGlobal("fetch", fetcher);
    const updates: ConnectionUpdate[] = [];
    const watch = new ReadmeLabClient().watchJob(
      "j",
      new AbortController().signal,
      (u) => updates.push(u),
    );
    expect((await watch.next()).value?.last_seq).toBe(2);
    const next = watch.next();
    await vi.advanceTimersByTimeAsync(2000);
    const result = await next;
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      "/api/readme/lab/jobs/j?after_seq=0",
      "/api/readme/lab/jobs/j?after_seq=2",
      "/api/readme/lab/jobs/j?after_seq=2",
    ]);
    expect(result.value?.events).toEqual(final.events);
    expect(updates.map((u) => u.status)).toEqual([
      "connected",
      "reconnecting",
      "connected",
    ]);
    expect((await watch.next()).done).toBe(true);
  });
  it("bounds retries to three and keeps connection failure distinct from job failure", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("Tunnel unavailable", { status: 502 })),
      );
    vi.stubGlobal("fetch", fetcher);
    const updates: ConnectionUpdate[] = [];
    const watch = new ReadmeLabClient().watchJob(
      "j",
      new AbortController().signal,
      (u) => updates.push(u),
    );
    const assertion = expect(watch.next()).rejects.toBeInstanceOf(
      LabClientError,
    );
    await vi.advanceTimersByTimeAsync(7000);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(updates.map((u) => u.retry_in_ms)).toEqual([1000, 2000, 4000, 0]);
    expect(updates.at(-1)?.status).toBe("disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out hung polls and aborts a reconnect wait without another request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const updates: ConnectionUpdate[] = [];
    const watch = new ReadmeLabClient().watchJob("j", controller.signal, (u) =>
      updates.push(u),
    );
    const assertion = expect(watch.next()).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updates[0]?.status).toBe("reconnecting");
    controller.abort();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not retry expired sessions, invalid JSON, event gaps, or mutations", async () => {
    for (const reply of [
      () => response({ error: "expired" }, 410),
      () => new Response("<html>bad JSON</html>"),
      () => response({ ...final, events: final.events.slice(1) }),
    ]) {
      const fetcher = vi
        .fn()
        .mockImplementation(() => Promise.resolve(reply()));
      vi.stubGlobal("fetch", fetcher);
      await expect(
        new ReadmeLabClient()
          .watchJob("j", new AbortController().signal)
          .next(),
      ).rejects.toBeInstanceOf(Error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Network lost"));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new ReadmeLabClient().session("synthetic-code", true),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
