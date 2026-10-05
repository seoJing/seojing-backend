import { parentPort, workerData } from "node:worker_threads";
import type { ReadmeUploadInput } from "../readme-upload.js";
import type { ResumeDocument } from "./contracts.js";

const data = workerData as { module_url: string; input: ReadmeUploadInput };
try {
  const service = (await import(data.module_url)) as {
    extractDocument: (input: ReadmeUploadInput) => Promise<ResumeDocument>;
  };
  parentPort?.postMessage({
    ok: true,
    document: await service.extractDocument(data.input),
  });
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "text_extraction_failed";
  parentPort?.postMessage({ ok: false, code });
}
