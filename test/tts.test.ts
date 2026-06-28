import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { PythonWorkerClient } from "../src/services/python-worker.js";

interface TtsJobResponse {
  job: { id: string; status?: string; text?: string };
}

async function waitForDone(
  app: Awaited<ReturnType<typeof buildApp>>,
  jobId: string,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/tts/jobs/${jobId}`,
    });
    const payload = response.json<TtsJobResponse>();
    if (["done", "failed"].includes(payload.job.status ?? "")) {
      return payload.job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("tts job did not finish");
}

async function createAudioFixture() {
  const dir = await mkdtemp(join(tmpdir(), "seojing-tts-"));
  const audioPath = join(dir, "fixture.mp3");
  await writeFile(audioPath, Buffer.from("fixture-mp3-bytes"));
  return { audioPath, audioRoot: dir };
}

describe("public TTS API", () => {
  it("keeps the Node route public while generation is delegated to the Python worker", async () => {
    const { audioPath, audioRoot } = await createAudioFixture();
    const invoke = vi.fn().mockResolvedValue({
      requestId: "TTS-test",
      result: { audioPath, mimeType: "audio/mpeg", byteLength: 17 },
    });
    const app = await buildApp({
      ttsAudioRoot: audioRoot,
      pythonWorkerClient: {
        health: () =>
          Promise.resolve({
            status: "ok",
            worker: "seojing-python-worker",
            capabilities: ["tts"],
          }),
        invoke: invoke as unknown as PythonWorkerClient["invoke"],
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/tts/jobs",
      headers: { "idempotency-key": "same-post" },
      payload: {
        article_id: "day-6",
        text: "SEOJing 테스트 음성입니다.",
        metadata: { source: "vitest" },
      },
    });

    expect(created.statusCode).toBe(202);
    const createdPayload = created.json<TtsJobResponse>();
    expect(createdPayload.job.id).toMatch(/^TTS-/);
    expect(created.body).not.toContain(audioPath);
    expect(createdPayload.job.text).toBeUndefined();

    const job = await waitForDone(app, createdPayload.job.id);
    expect(job).toMatchObject({
      id: createdPayload.job.id,
      articleId: "day-6",
      status: "done",
      audioUrl: `/tts/audio/${createdPayload.job.id}`,
    });

    expect(invoke).toHaveBeenCalledWith(
      "tts",
      expect.objectContaining({
        operation: "synthesize",
        jobId: createdPayload.job.id,
        text: "SEOJing 테스트 음성입니다.",
      }),
      { requestId: createdPayload.job.id },
    );

    const audio = await app.inject({
      method: "GET",
      url: `/tts/audio/${createdPayload.job.id}`,
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toContain("audio/mpeg");
    expect(audio.body).toBe("fixture-mp3-bytes");

    const range = await app.inject({
      method: "GET",
      url: `/tts/audio/${createdPayload.job.id}`,
      headers: { range: "bytes=0-6" },
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe("bytes 0-6/17");
    expect(range.body).toBe("fixture");

    const suffixRange = await app.inject({
      method: "GET",
      url: `/tts/audio/${createdPayload.job.id}`,
      headers: { range: "bytes=-5" },
    });
    expect(suffixRange.statusCode).toBe(206);
    expect(suffixRange.headers["content-range"]).toBe("bytes 12-16/17");
    expect(suffixRange.body).toBe("bytes");

    const invalidRange = await app.inject({
      method: "GET",
      url: `/tts/audio/${createdPayload.job.id}`,
      headers: { range: "bytes=999-1000" },
    });
    expect(invalidRange.statusCode).toBe(416);
    expect(invalidRange.headers["content-range"]).toBe("bytes */17");

    await app.close();
  });

  it("returns a public 503 instead of exposing Python worker details when TTS is not configured", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/tts/jobs",
      payload: { text: "hello" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: {
        code: "not_configured",
        message: "tts worker is not configured",
      },
    });

    await app.close();
  });

  it("fails jobs whose worker audio path escapes the configured audio root", async () => {
    const { audioPath } = await createAudioFixture();
    const safeRoot = await mkdtemp(join(tmpdir(), "seojing-tts-root-"));
    const invoke = vi.fn().mockResolvedValue({
      result: { audioPath, mimeType: "audio/mpeg" },
    });
    const app = await buildApp({
      ttsAudioRoot: safeRoot,
      pythonWorkerClient: {
        health: () =>
          Promise.resolve({
            status: "ok",
            worker: "seojing-python-worker",
            capabilities: ["tts"],
          }),
        invoke: invoke as unknown as PythonWorkerClient["invoke"],
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/tts/jobs",
      payload: { text: "outside path" },
    });
    const createdPayload = created.json<TtsJobResponse>();
    const job = await waitForDone(app, createdPayload.job.id);

    expect(job.status).toBe("failed");

    await app.close();
  });

  it("preserves idempotency at the Node job boundary", async () => {
    const { audioPath, audioRoot } = await createAudioFixture();
    const invoke = vi.fn().mockResolvedValue({
      result: { audioPath, mimeType: "audio/mpeg" },
    });
    const app = await buildApp({
      ttsAudioRoot: audioRoot,
      pythonWorkerClient: {
        health: () =>
          Promise.resolve({
            status: "ok",
            worker: "seojing-python-worker",
            capabilities: ["tts"],
          }),
        invoke: invoke as unknown as PythonWorkerClient["invoke"],
      },
    });

    const first = await app.inject({
      method: "POST",
      url: "/tts/jobs",
      payload: { text: "same", idempotency_key: "same" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/tts/jobs",
      payload: { text: "same", idempotency_key: "same" },
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const firstPayload = first.json<TtsJobResponse>();
    const secondPayload = second.json<TtsJobResponse>();
    expect(firstPayload.job.id).toBe(secondPayload.job.id);

    await app.close();
  });
});
