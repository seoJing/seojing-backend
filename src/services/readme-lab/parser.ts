import { Worker } from "node:worker_threads";
import type { ReadmeUploadInput } from "../readme-upload.js";
import type { ResumeDocument } from "./contracts.js";
import { LabError } from "./errors.js";

export function parseDocument(
  input: ReadmeUploadInput,
  signal: AbortSignal,
  timeoutMs = 12000,
): Promise<ResumeDocument> {
  if (signal.aborted) return Promise.reject(new LabError("cancelled"));
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(`./parser-worker${ext}`, import.meta.url),
      {
        workerData: {
          module_url: new URL(`./document${ext}`, import.meta.url).href,
          input,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 24,
        },
      },
    );
    let settled = false;
    const initialRss = process.memoryUsage.rss();
    const finish = (code?: string, document?: ResumeDocument) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(memory);
      signal.removeEventListener("abort", abort);
      void worker.terminate().catch(() => undefined);
      if (code || !document)
        reject(new LabError(code ?? "text_extraction_failed"));
      else resolve(document);
    };
    const abort = () => finish("cancelled");
    const timer = setTimeout(() => finish("engine_timeout"), timeoutMs);
    const memory = setInterval(() => {
      if (process.memoryUsage.rss() - initialRss > 512 * 1024 * 1024)
        finish("document_resource_limit");
    }, 50);
    memory.unref();
    signal.addEventListener("abort", abort, { once: true });
    worker.on(
      "message",
      (message: { ok: boolean; document?: ResumeDocument; code?: string }) =>
        finish(
          message.ok ? undefined : (message.code ?? "text_extraction_failed"),
          message.document,
        ),
    );
    worker.on("error", () => finish("text_extraction_failed"));
    worker.on("exit", () => finish("text_extraction_failed"));
  });
}
