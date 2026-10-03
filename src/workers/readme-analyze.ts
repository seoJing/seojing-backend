import { parentPort, workerData } from "node:worker_threads";
import type {
  ReadmeInputError,
  ReadmeUploadInput,
} from "../services/readme-upload.js";

interface AnalyzeWorkerData {
  serviceUrl: string;
  input: {
    job_text: string;
    resume_filename: string;
    resume_media_type: string;
    resume_base64: string;
  };
}

const { serviceUrl, input } = workerData as AnalyzeWorkerData;
interface ReadmeService {
  extractResumeText: (input: ReadmeUploadInput) => Promise<string>;
  buildUploadedPreview: (jobText: string, resumeText: string) => unknown;
  ReadmeInputError: new (
    code: string,
    message: string,
    statusCode?: number,
  ) => ReadmeInputError;
}
const service = (await import(serviceUrl)) as unknown as ReadmeService;

try {
  const resumeText = await service.extractResumeText(input);
  parentPort?.postMessage({
    ok: true,
    preview: service.buildUploadedPreview(input.job_text, resumeText),
  });
} catch (error) {
  if (error instanceof service.ReadmeInputError) {
    const inputError = error as {
      code: string;
      message: string;
      statusCode: number;
    };
    parentPort?.postMessage({
      ok: false,
      code: inputError.code,
      message: inputError.message,
      statusCode: inputError.statusCode,
    });
  } else {
    parentPort?.postMessage({
      ok: false,
      code: "analysis_unavailable",
      statusCode: 503,
    });
  }
}
