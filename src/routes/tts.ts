import type { FastifyInstance } from "fastify";

import { TtsServiceError, type TtsService } from "../services/tts.js";

interface TtsRouteOptions {
  ttsService: TtsService;
}

export function registerTtsRoutes(
  app: FastifyInstance,
  options: TtsRouteOptions,
): void {
  app.get(
    "/tts/summary",
    {
      schema: {
        tags: ["tts"],
        summary: "Report public TTS job/cache summary through the Node API.",
      },
    },
    () => ({
      ok: true,
      service: "seojing-backend",
      tts: options.ttsService.summary(),
    }),
  );

  app.post(
    "/tts/jobs",
    {
      schema: {
        tags: ["tts"],
        summary:
          "Create a TTS synthesis job. Audio generation runs in the internal Python worker.",
      },
    },
    async (request, reply) => {
      try {
        const body = readTtsJobCreateBody(request.body);
        const job = options.ttsService.create({
          ...body,
          idempotencyKey:
            body.idempotencyKey ?? readIdempotencyKey(request.headers),
        });
        reply.code(202);
        return { ok: true, job };
      } catch (error) {
        return sendTtsError(error, reply);
      }
    },
  );

  app.get(
    "/tts/jobs",
    {
      schema: {
        tags: ["tts"],
        summary: "List public TTS jobs managed by the Node API.",
      },
    },
    (request) => {
      const query = request.query as {
        status?: string;
        limit?: string | number;
      };
      const limit = Number(query.limit ?? 50);
      return {
        ok: true,
        jobs: options.ttsService.list(
          query.status,
          Number.isFinite(limit) ? limit : 50,
        ),
      };
    },
  );

  app.get(
    "/tts/jobs/:jobId",
    {
      schema: {
        tags: ["tts"],
        summary:
          "Read one TTS job status without exposing local file paths or text.",
      },
    },
    async (request, reply) => {
      try {
        const { jobId } = request.params as { jobId: string };
        return { ok: true, job: options.ttsService.get(jobId) };
      } catch (error) {
        return sendTtsError(error, reply);
      }
    },
  );

  app.get(
    "/tts/audio/:jobId",
    {
      schema: {
        tags: ["tts"],
        summary:
          "Stream generated TTS audio through Node with byte-range support.",
      },
    },
    async (request, reply) => {
      try {
        const { jobId } = request.params as { jobId: string };
        await options.ttsService.streamAudio(
          jobId,
          reply,
          request.headers.range,
        );
      } catch (error) {
        return sendTtsError(error, reply);
      }
    },
  );
}

function readTtsJobCreateBody(body: unknown) {
  if (!body || typeof body !== "object") {
    throw new TtsServiceError("validation_error", "JSON body is required", 400);
  }
  const candidate = body as Record<string, unknown>;
  return {
    text: readString(candidate.text),
    articleId: readOptionalString(candidate.article_id ?? candidate.articleId),
    voice: readOptionalString(candidate.voice),
    rate: readOptionalString(candidate.rate),
    idempotencyKey: readOptionalString(
      candidate.idempotency_key ?? candidate.idempotencyKey,
    ),
    metadata: readMetadata(candidate.metadata),
  };
}

function readString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TtsServiceError("validation_error", "tts text is required", 400);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TtsServiceError(
      "validation_error",
      "metadata must be an object",
      400,
    );
  }
  return value as Record<string, unknown>;
}

function readIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
}

function sendTtsError(
  error: unknown,
  reply: { code: (statusCode: number) => void },
) {
  if (error instanceof TtsServiceError) {
    reply.code(error.statusCode);
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  reply.code(500);
  return {
    ok: false,
    error: { code: "internal_error", message: "TTS request failed" },
  };
}
