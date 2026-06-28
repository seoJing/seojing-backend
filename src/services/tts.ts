import { createReadStream, mkdirSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";

import type { FastifyReply } from "fastify";

import { PythonWorkerError, type PythonWorkerClient } from "./python-worker.js";

export type TtsJobStatus = "queued" | "running" | "done" | "failed";

export interface TtsJobCreateInput {
  text: string;
  articleId?: string;
  voice?: string;
  rate?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface TtsJobPublic {
  id: string;
  articleId?: string;
  textChars: number;
  voice: string;
  rate: string;
  status: TtsJobStatus;
  metadata: Record<string, unknown>;
  audioUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface TtsJobInternal extends TtsJobPublic {
  text: string;
  idempotencyKey?: string;
  audioPath?: string;
  mimeType?: string;
  byteLength?: number;
}

export interface TtsWorkerResult {
  audioPath: string;
  mimeType?: string;
  byteLength?: number;
  durationMs?: number;
}

export type TtsWorkerGateway = Partial<Pick<PythonWorkerClient, "invoke">>;

export const DEFAULT_TTS_VOICE = "ko-KR-SunHiNeural";
export const DEFAULT_TTS_RATE = "+0%";
export const MAX_TTS_TEXT_CHARS = 5000;

export class TtsServiceError extends Error {
  constructor(
    public readonly code:
      | "not_configured"
      | "validation_error"
      | "not_found"
      | "not_ready"
      | "audio_missing"
      | "worker_failed",
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "TtsServiceError";
  }
}

export class TtsService {
  private readonly jobs = new Map<string, TtsJobInternal>();
  private readonly idempotencyKeys = new Map<string, string>();
  private readonly audioRoot: string;

  constructor(
    private readonly worker?: TtsWorkerGateway,
    options: { audioRoot?: string } = {},
  ) {
    const configuredAudioRoot = resolve(
      options.audioRoot ??
        process.env.TTS_AUDIO_ROOT ??
        process.env.SEOJING_TTS_AUDIO_DIR ??
        ".seojing-worker/tts-audio",
    );
    mkdirSync(configuredAudioRoot, { recursive: true });
    this.audioRoot = realpathSync(configuredAudioRoot);
  }

  summary() {
    const counts: Partial<Record<TtsJobStatus, number>> = {};
    for (const job of this.jobs.values()) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
    }
    return {
      configured: Boolean(this.worker?.invoke),
      counts,
      maxTextChars: MAX_TTS_TEXT_CHARS,
      defaultVoice: DEFAULT_TTS_VOICE,
      time: new Date().toISOString(),
    };
  }

  create(input: TtsJobCreateInput): TtsJobPublic {
    this.assertWorkerConfigured();
    const text = input.text?.trim();
    if (!text) {
      throw new TtsServiceError(
        "validation_error",
        "tts text is required",
        400,
      );
    }
    if (text.length > MAX_TTS_TEXT_CHARS) {
      throw new TtsServiceError(
        "validation_error",
        `tts text must be at most ${MAX_TTS_TEXT_CHARS} characters`,
        400,
      );
    }

    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey) {
      const existingId = this.idempotencyKeys.get(idempotencyKey);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing) {
        return this.toPublic(existing);
      }
    }

    const now = new Date().toISOString();
    const job: TtsJobInternal = {
      id: `TTS-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      articleId: input.articleId,
      text,
      textChars: text.length,
      voice: input.voice?.trim() || DEFAULT_TTS_VOICE,
      rate: input.rate?.trim() || DEFAULT_TTS_RATE,
      idempotencyKey,
      status: "queued",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (idempotencyKey) {
      this.idempotencyKeys.set(idempotencyKey, job.id);
    }

    queueMicrotask(() => {
      void this.synthesize(job.id);
    });

    return this.toPublic(job);
  }

  list(status?: string, limit = 50): TtsJobPublic[] {
    const normalizedLimit = Math.max(1, Math.min(limit, 200));
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, normalizedLimit)
      .map((job) => this.toPublic(job));
  }

  get(id: string): TtsJobPublic {
    return this.toPublic(this.getInternal(id));
  }

  async streamAudio(jobId: string, reply: FastifyReply, range?: string) {
    const job = this.getInternal(jobId);
    if (job.status !== "done") {
      throw new TtsServiceError("not_ready", `tts job is ${job.status}`, 409);
    }
    if (!job.audioPath) {
      throw new TtsServiceError("audio_missing", "tts audio file missing", 404);
    }

    let fileStat;
    try {
      fileStat = await stat(job.audioPath);
    } catch {
      throw new TtsServiceError("audio_missing", "tts audio file missing", 404);
    }

    const mimeType = job.mimeType ?? "audio/mpeg";
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "public, max-age=86400");
    reply.header("Content-Type", mimeType);

    const parsedRange = parseRange(range, fileStat.size);
    if (parsedRange === null) {
      reply.code(416);
      reply.header("Content-Range", `bytes */${fileStat.size}`);
      return reply.send();
    }
    if (parsedRange) {
      reply.code(206);
      reply.header(
        "Content-Range",
        `bytes ${parsedRange.start}-${parsedRange.end}/${fileStat.size}`,
      );
      reply.header(
        "Content-Length",
        String(parsedRange.end - parsedRange.start + 1),
      );
      return reply.send(
        createReadStream(job.audioPath, {
          start: parsedRange.start,
          end: parsedRange.end,
        }),
      );
    }

    reply.header("Content-Length", String(fileStat.size));
    return reply.send(createReadStream(job.audioPath));
  }

  private async synthesize(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "queued") {
      return;
    }
    const startedAt = new Date().toISOString();
    Object.assign(job, {
      status: "running" as const,
      startedAt,
      updatedAt: startedAt,
      error: undefined,
    });

    try {
      if (!this.worker?.invoke) {
        throw new TtsServiceError(
          "not_configured",
          "tts worker is not configured",
          503,
        );
      }
      const response = await this.worker.invoke<TtsWorkerResult>(
        "tts",
        {
          operation: "synthesize",
          jobId: job.id,
          text: job.text,
          articleId: job.articleId,
          voice: job.voice,
          rate: job.rate,
          metadata: job.metadata,
          idempotencyKey: job.idempotencyKey,
        },
        { requestId: job.id },
      );
      if (!response?.result?.audioPath) {
        throw new TtsServiceError(
          "worker_failed",
          "Python worker did not return an audioPath",
          502,
        );
      }
      const audioPath = this.resolveWorkerAudioPath(response.result.audioPath);
      const finishedAt = new Date().toISOString();
      Object.assign(job, {
        status: "done" as const,
        audioPath,
        mimeType: response.result.mimeType ?? "audio/mpeg",
        byteLength: response.result.byteLength,
        audioUrl: `/tts/audio/${job.id}`,
        finishedAt,
        updatedAt: finishedAt,
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      Object.assign(job, {
        status: "failed" as const,
        error: publicWorkerErrorMessage(error),
        finishedAt,
        updatedAt: finishedAt,
      });
    }
  }

  private resolveWorkerAudioPath(workerAudioPath: string): string {
    const resolvedPath = realpathSync(resolve(workerAudioPath));
    const relativePath = relative(this.audioRoot, resolvedPath);
    if (
      relativePath.startsWith("..") ||
      relativePath === "" ||
      relativePath.startsWith("/")
    ) {
      throw new TtsServiceError(
        "worker_failed",
        "Python worker returned an audio path outside the configured TTS audio root",
        502,
      );
    }
    return resolvedPath;
  }

  private assertWorkerConfigured(): void {
    if (!this.worker?.invoke) {
      throw new TtsServiceError(
        "not_configured",
        "tts worker is not configured",
        503,
      );
    }
  }

  private getInternal(id: string): TtsJobInternal {
    const job = this.jobs.get(id);
    if (!job) {
      throw new TtsServiceError("not_found", "tts job not found", 404);
    }
    return job;
  }

  private toPublic(job: TtsJobInternal): TtsJobPublic {
    return {
      id: job.id,
      articleId: job.articleId,
      textChars: job.textChars,
      voice: job.voice,
      rate: job.rate,
      status: job.status,
      metadata: job.metadata,
      audioUrl: job.status === "done" ? `/tts/audio/${job.id}` : undefined,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }
}

function publicWorkerErrorMessage(error: unknown): string {
  if (error instanceof PythonWorkerError) {
    return `python_worker_${error.code}`;
  }
  if (error instanceof TtsServiceError) {
    return error.message;
  }
  return "python_worker_failed";
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) {
    return null;
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}
