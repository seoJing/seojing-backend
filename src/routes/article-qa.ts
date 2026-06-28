import type { FastifyInstance } from "fastify";

import {
  ArticleQaServiceError,
  type ArticleQaService,
} from "../services/article-qa.js";

interface ArticleQaRouteOptions {
  articleQaService: ArticleQaService;
}

interface ArticleQaParams {
  slug: string;
}

export function registerArticleQaRoutes(
  app: FastifyInstance,
  options: ArticleQaRouteOptions,
): void {
  app.post<{ Params: ArticleQaParams }>(
    "/articles/:slug/qa",
    {
      schema: {
        params: {
          type: "object",
          required: ["slug"],
          properties: { slug: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string", minLength: 2, maxLength: 600 },
            section_id: { type: "string" },
            sectionId: { type: "string" },
            session_id: { type: "string" },
            sessionId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const body = readQaBody(request.body);
        return await options.articleQaService.answer({
          slug: request.params.slug,
          question: body.question,
          sectionId: body.sectionId,
          sessionId: body.sessionId,
          requestId: readRequestId(request.headers),
        });
      } catch (error) {
        return sendQaError(error, reply);
      }
    },
  );
}

function readQaBody(body: unknown): {
  question: string;
  sectionId?: string;
  sessionId?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ArticleQaServiceError(
      "validation_error",
      "JSON body is required",
      400,
    );
  }
  const candidate = body as Record<string, unknown>;
  return {
    question: readRequiredString(candidate.question, "question"),
    sectionId: readOptionalString(candidate.section_id ?? candidate.sectionId),
    sessionId: readOptionalString(candidate.session_id ?? candidate.sessionId),
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ArticleQaServiceError(
      "validation_error",
      `${field} is required`,
      400,
    );
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequestId(headers: Record<string, string | string[] | undefined>) {
  const value = headers["x-request-id"];
  return Array.isArray(value) ? value[0] : value;
}

function sendQaError(
  error: unknown,
  reply: { code: (statusCode: number) => void },
) {
  if (error instanceof ArticleQaServiceError) {
    reply.code(error.statusCode);
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  reply.code(500);
  return {
    ok: false,
    error: { code: "internal_error", message: "Article QA request failed" },
  };
}
