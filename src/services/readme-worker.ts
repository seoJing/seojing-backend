import { Worker } from "node:worker_threads";

import { ReadmeInputError, type ReadmeUploadInput } from "./readme-upload.js";

const ANALYSIS_TIMEOUT_MS = 12_000;
const MAX_RSS_GROWTH_BYTES = 512 * 1024 * 1024;

export function analyzeReadmeInWorker(
  input: ReadmeUploadInput,
  timeoutMs = ANALYSIS_TIMEOUT_MS,
): Promise<unknown> {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const workerUrl = new URL(
    `../workers/readme-analyze${extension}`,
    import.meta.url,
  );
  const serviceUrl = new URL(`./readme-upload${extension}`, import.meta.url)
    .href;

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { serviceUrl, input },
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 24,
      },
    });
    let settled = false;
    const initialRss = process.memoryUsage.rss();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(memoryWatch);
      void worker.terminate().catch(() => undefined);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new ReadmeInputError(
            "analysis_timeout",
            "문서 분석 시간이 초과되었습니다.",
            503,
          ),
        ),
      );
    }, timeoutMs);
    // Only RSS is process-wide for worker_threads. Other memoryUsage fields
    // (including arrayBuffers) describe the caller's thread and miss parser buffers.
    const memoryWatch = setInterval(() => {
      if (process.memoryUsage.rss() - initialRss <= MAX_RSS_GROWTH_BYTES)
        return;
      finish(() =>
        reject(
          new ReadmeInputError(
            "analysis_resource_limit",
            "문서 분석 자원 한도를 초과했습니다.",
            503,
          ),
        ),
      );
    }, 50);
    memoryWatch.unref();
    worker.on("message", (value: unknown) => {
      if (!value || typeof value !== "object" || !("ok" in value)) {
        finish(() => reject(new Error("invalid_worker_response")));
        return;
      }
      const message = value as {
        ok: boolean;
        preview?: unknown;
        code?: string;
        message?: string;
        statusCode?: number;
      };
      if (message.ok) {
        finish(() => resolve(message.preview));
      } else if (message.code && message.code !== "analysis_unavailable") {
        finish(() =>
          reject(
            new ReadmeInputError(
              message.code ?? "analysis_unavailable",
              message.message ?? "문서를 읽지 못했습니다.",
              message.statusCode ?? 422,
            ),
          ),
        );
      } else {
        finish(() => reject(new Error("worker_analysis_failed")));
      }
    });
    worker.on("error", () => finish(() => reject(new Error("worker_failed"))));
    worker.on("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error("worker_exited")));
    });
  });
}
