import type { FastifyInstance } from "fastify";

import { buildReadmePreview } from "../services/readme.js";
import {
  ReadmeInputError,
  type ReadmeUploadInput,
} from "../services/readme-upload.js";
import { analyzeReadmeInWorker } from "../services/readme-worker.js";

export function registerReadmeRoutes(app: FastifyInstance): void {
  const uploadBuckets = new Map<string, { count: number; resetAt: number }>();
  let activeAnalyzes = 0;
  app.post<{ Body: { case_id: "social-program-operator" } }>(
    "/readme/preview",
    {
      bodyLimit: 256,
      schema: {
        tags: ["readme"],
        summary: "Return a synthetic, rules-based README reading preview.",
        body: {
          type: "object",
          // Fastify's default AJV configuration strips unknown fields when
          // additionalProperties is false; retain them for explicit rejection.
          additionalProperties: true,
          required: ["case_id"],
          properties: {
            case_id: { type: "string", enum: ["social-program-operator"] },
          },
        },
      },
    },
    (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      if (Object.keys(request.body).some((key) => key !== "case_id")) {
        reply.code(400);
        return { error: "synthetic_case_only" };
      }
      return buildReadmePreview();
    },
  );

  app.post<{ Body: ReadmeUploadInput }>(
    "/readme/analyze",
    {
      bodyLimit: 3_000_000,
      schema: {
        tags: ["readme"],
        summary: "Analyze a user-provided resume in memory with preview rules.",
        body: {
          type: "object",
          additionalProperties: true,
          required: [
            "job_text",
            "resume_filename",
            "resume_media_type",
            "resume_base64",
          ],
          properties: {
            job_text: { type: "string", minLength: 20, maxLength: 6_000 },
            resume_filename: { type: "string", minLength: 1, maxLength: 120 },
            resume_media_type: { type: "string", maxLength: 120 },
            resume_base64: {
              type: "string",
              minLength: 1,
              maxLength: 2_666_672,
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const forwarded = request.headers["cf-connecting-ip"];
      const clientKey =
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) &&
        typeof forwarded === "string"
          ? forwarded
          : request.ip;
      const now = Date.now();
      if (uploadBuckets.size >= 10_000) {
        for (const [key, bucket] of uploadBuckets) {
          if (bucket.resetAt <= now) uploadBuckets.delete(key);
        }
        while (uploadBuckets.size >= 10_000) {
          const oldestKey = uploadBuckets.keys().next().value;
          if (!oldestKey) break;
          uploadBuckets.delete(oldestKey);
        }
      }
      const prior = uploadBuckets.get(clientKey);
      const bucket =
        prior && prior.resetAt > now
          ? prior
          : { count: 0, resetAt: now + 60_000 };
      bucket.count += 1;
      uploadBuckets.set(clientKey, bucket);
      if (bucket.count > 5) {
        reply.header("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
        reply.code(429);
        return { error: "rate_limited" };
      }
      if (
        Object.keys(request.body).some(
          (key) =>
            ![
              "job_text",
              "resume_filename",
              "resume_media_type",
              "resume_base64",
            ].includes(key),
        )
      ) {
        reply.code(400);
        return { error: "unexpected_field" };
      }
      if (activeAnalyzes >= 2) {
        reply.code(503);
        return { error: "analysis_busy" };
      }
      activeAnalyzes += 1;
      try {
        return await analyzeReadmeInWorker(request.body);
      } catch (error) {
        if (error instanceof ReadmeInputError) {
          reply.code(error.statusCode);
          return { error: error.code, message: error.message };
        }
        app.log.warn(
          { error: error instanceof Error ? error.name : "unknown" },
          "README upload parse failed",
        );
        reply.code(500);
        return { error: "analysis_unavailable" };
      } finally {
        activeAnalyzes -= 1;
      }
    },
  );
}
