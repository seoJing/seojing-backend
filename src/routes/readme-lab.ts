import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CodexReasoner } from "../services/readme-lab/codex.js";
import { LabError } from "../services/readme-lab/errors.js";
import { openLaya } from "../services/readme-lab/laya.js";
import { openJev } from "../services/readme-lab/jev.js";
import { parseDocument } from "../services/readme-lab/parser.js";
import { ReadmeLab } from "../services/readme-lab/service.js";

const uploadSchema = z
  .object({
    job_text: z.string().trim().min(20).max(6000),
    resume_filename: z.string().min(1).max(120),
    resume_media_type: z.string().max(120),
    resume_base64: z.string().min(1).max(2666672),
  })
  .strict();
const startSchema = z
  .object({
    prepare_id: z.string().min(1).max(100),
    input_hash: z.string().length(64),
    confirmed: z.literal(true),
  })
  .strict();
export function registerReadmeLabRoutes(
  app: FastifyInstance,
  injected?: ReadmeLab,
): void {
  if (!injected && process.env.README_LAB_ENABLED !== "1") return;
  if (
    !injected &&
    process.env.README_LAB_ENGINE &&
    !["laya", "jev"].includes(process.env.README_LAB_ENGINE)
  )
    throw new Error("Unknown README Lab engine");
  const reasoner = new CodexReasoner(
    process.env.README_CODEX_BIN,
    process.env.README_CODEX_MODEL,
  );
  const lab =
    injected ??
    new ReadmeLab({
      invitations: (process.env.README_LAB_INVITES ?? "")
        .split(",")
        .filter(Boolean),
      reasoner,
      parse: parseDocument,
      onPrepareFailure: (event) =>
        app.log.warn(event, "README preparation failed"),
      ...(process.env.README_LAB_ENGINE === "jev"
        ? {
            jev: (signal: AbortSignal) =>
              openJev(signal, {
                apiKey: process.env.TYPESAFE_API_KEY ?? "",
                reassessRole: reasoner.reassessRole,
                ...(process.env.README_JEV_PYTHON
                  ? { python: process.env.README_JEV_PYTHON }
                  : {}),
                ...(process.env.README_JEV_SCRIPT
                  ? { script: process.env.README_JEV_SCRIPT }
                  : {}),
              }),
          }
        : {
            classifier: (signal: AbortSignal) =>
              openLaya(
                signal,
                process.env.README_LAYA_HOME,
                process.env.README_LAYA_SCRIPT,
              ),
          }),
    });
  void app.register(
    (scoped, _options, done) => {
      scoped.addHook("onRoute", (options) => {
        options.schema = { ...options.schema, hide: true };
      });
      const attempts = new Map<string, { until: number; count: number }>();
      const session = (request: FastifyRequest) => {
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ") || header.length > 200)
          throw new LabError("invite_invalid", 401);
        return lab.authenticate(header.slice(7));
      };
      scoped.addHook("onRequest", (request, reply, next) => {
        reply.header("Cache-Control", "private, no-store");
        reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
        const now = Date.now();
        for (const [key, value] of attempts)
          if (value.until <= now) attempts.delete(key);
        const login = request.url.split("?")[0] === "/readme/lab/session";
        const key = login
          ? `login:${request.ip}`
          : `session:${session(request).owner}`;
        const bucket = attempts.get(key) ?? { until: now + 60000, count: 0 };
        if (!attempts.has(key) && attempts.size >= 1000)
          throw new LabError("rate_limited", 429);
        bucket.count++;
        attempts.set(key, bucket);
        if (bucket.count > (login ? 10 : 180))
          throw new LabError("rate_limited", 429);
        next();
      });
      scoped.setErrorHandler((error, _request, reply) => {
        if (error instanceof LabError)
          return reply.code(error.status).send({ error: error.code });
        if (error instanceof z.ZodError)
          return reply.code(400).send({ error: "invalid_input" });
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 413)
          return reply.code(413).send({ error: "request_too_large" });
        if (status === 415)
          return reply.code(415).send({ error: "unsupported_media_type" });
        if (status === 400)
          return reply.code(400).send({ error: "invalid_input" });
        return reply.code(503).send({ error: "engine_unavailable" });
      });
      scoped.post("/session", { bodyLimit: 512 }, (request) => {
        const value = z
          .object({
            invite_code: z.string().min(1).max(200),
            cloud_consent: z.boolean(),
            consent_version: z.string().max(80).optional(),
          })
          .strict()
          .parse(request.body);
        return lab.session(
          value.invite_code,
          value.cloud_consent,
          value.consent_version,
        );
      });
      scoped.post(
        "/prepare",
        {
          bodyLimit: 3000000,
          preValidation: (request, _reply, next) => {
            session(request);
            next();
          },
        },
        (request, reply) =>
          reply
            .code(202)
            .send(
              lab.prepare(session(request), uploadSchema.parse(request.body)),
            ),
      );
      scoped.get<{ Params: { id: string } }>("/prepare/:id", (request) =>
        lab.getPrepare(session(request), request.params.id),
      );
      scoped.delete<{ Params: { id: string } }>(
        "/prepare/:id",
        (request, reply) => {
          lab.cancelPrepare(session(request), request.params.id);
          return reply.code(204).send();
        },
      );
      scoped.post("/jobs", { bodyLimit: 512 }, (request, reply) => {
        const value = startSchema.parse(request.body);
        return reply
          .code(202)
          .send(
            lab.start(
              session(request),
              value.prepare_id,
              value.input_hash,
              value.confirmed,
            ),
          );
      });
      scoped.get<{
        Params: { id: string };
        Querystring: { after_seq?: string };
      }>("/jobs/:id", (request) =>
        lab.getJob(
          session(request),
          request.params.id,
          Number(request.query.after_seq ?? 0),
        ),
      );
      scoped.delete<{ Params: { id: string } }>(
        "/jobs/:id",
        (request, reply) => {
          lab.cancel(session(request), request.params.id);
          return reply.code(204).send();
        },
      );
      scoped.addHook("onClose", () => {
        lab.close();
      });
      done();
    },
    { prefix: "/readme/lab" },
  );
}
