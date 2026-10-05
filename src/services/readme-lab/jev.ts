import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { z } from "zod";
import { LabError } from "./errors.js";
import {
  modelEnvironment,
  modelShutdownStarted,
  terminate,
  trackModelProcess,
} from "./process.js";
import {
  semanticInput,
  validateSemanticStep,
  type SequentialReasoner,
  type SemanticStep,
  type SemanticInput,
} from "./semantic-reader.js";
import { validateRoleContext, type RoleReassessor } from "./role-context.js";

export interface ContextReview {
  question_id: string;
  at_unit_id: string;
  outcome: "confirmed" | "unconfirmed" | "failed";
}

export const jevMetadataSchema = z
  .object({
    model: z.literal("jev-1.13.0"),
    provider: z.literal("typesafe"),
    execution: z.literal("remote"),
    calibrated_for_readme: z.literal(false),
  })
  .strict();
export type JevMetadata = z.infer<typeof jevMetadataSchema>;
const metricsSchema = z
  .object({
    calls: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    omitted_proofs: z.number().int().nonnegative(),
  })
  .strict();
export interface JevReader extends SequentialReasoner {
  metadata: JevMetadata;
  metrics: z.infer<typeof metricsSchema>;
  contextReviews?: ContextReview[];
  close(): void;
}
export interface JevOptions {
  apiKey: string;
  python?: string;
  script?: string;
  timeoutMs?: number;
  /** Opt-in synthetic diagnostics; never forwarded in public JobView/events. */
  onFailure?: (code: string) => void;
  reassessRole?: RoleReassessor;
  onRecovery?: (event: ContextReview & { elapsed_ms: number }) => void;
  onRetry?: (event: { code: string; call: number }) => void;
}

/** No default secret lookup, disk writes, source logging or Laya fallback. */
export function openJev(
  signal: AbortSignal,
  options: JevOptions,
): Promise<JevReader> {
  if (signal.aborted) return Promise.reject(new LabError("cancelled"));
  if (modelShutdownStarted())
    return Promise.reject(new LabError("engine_unavailable", 503));
  if (
    !options.apiKey ||
    options.apiKey.length < 16 ||
    options.apiKey.length > 1000
  )
    return Promise.reject(new LabError("engine_unavailable", 503));
  return new Promise((resolveReady, rejectReady) => {
    const lifetime = new AbortController();
    const child = spawn(
      options.python ?? "/usr/bin/python3",
      [
        options.script ??
          resolve("src/services/readme-lab/python/jev_runtime.py"),
      ],
      {
        env: { ...modelEnvironment(), PYTHONDONTWRITEBYTECODE: "1" },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    trackModelProcess(child);
    let ready: JevReader | undefined;
    let stopped = false,
      bytes = 0,
      counter = 0;
    let reassessments = 0;
    let pending:
      | {
          id: string;
          resolve: (result: SemanticStep) => void;
          reject: (error: LabError) => void;
          timer: ReturnType<typeof setTimeout>;
          cleanup: () => void;
          input: SemanticInput;
          signal: AbortSignal;
          reassessing: boolean;
        }
      | undefined;
    const close = (code = "cancelled") => {
      if (stopped) return;
      stopped = true;
      lifetime.abort();
      clearTimeout(loadTimer);
      signal.removeEventListener("abort", abort);
      if (pending) {
        clearTimeout(pending.timer);
        pending.cleanup();
        pending.reject(new LabError(code, 503));
        pending = undefined;
      }
      if (!ready) rejectReady(new LabError(code, 503));
      terminate(child);
    };
    const abort = () => close("cancelled");
    const loadTimer = setTimeout(() => close("engine_timeout"), 10000);
    signal.addEventListener("abort", abort, { once: true });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4_000_000) close("engine_output_invalid");
      });
    child.stdin.on("error", () => close("engine_unavailable"));
    child.on("error", () => close("engine_unavailable"));
    child.on("close", () => close("engine_unavailable"));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (stopped) return;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (!ready) {
          const metadata = jevMetadataSchema.parse(message.ready);
          clearTimeout(loadTimer);
          ready = {
            metadata,
            metrics: {
              calls: 0,
              input_tokens: 0,
              output_tokens: 0,
              omitted_proofs: 0,
            },
            contextReviews: [],
            close: () => close(),
            async readStep(input, callerSignal) {
              semanticInput(input);
              if (signal.aborted || callerSignal.aborted)
                throw new LabError("cancelled");
              if (stopped) throw new LabError("engine_unavailable", 503);
              if (pending) throw new LabError("engine_busy", 503);
              const step = await new Promise<SemanticStep>(
                (resolveResult, rejectResult) => {
                  const id = String(++counter);
                  const cancelStep = () => close("cancelled");
                  callerSignal.addEventListener("abort", cancelStep, {
                    once: true,
                  });
                  pending = {
                    id,
                    resolve: resolveResult,
                    reject: rejectResult,
                    timer: setTimeout(
                      () => close("engine_timeout"),
                      options.timeoutMs ??
                        (options.reassessRole ? 90000 : 45000),
                    ),
                    cleanup: () =>
                      callerSignal.removeEventListener("abort", cancelStep),
                    input: structuredClone(input),
                    signal: callerSignal,
                    reassessing: false,
                  };
                  const payload = JSON.stringify({ id, input }) + "\n";
                  if (Buffer.byteLength(payload) > 1_000_000) {
                    close("engine_input_invalid");
                    return;
                  }
                  child.stdin.write(payload);
                },
              );
              try {
                return validateSemanticStep(step, input);
              } catch (error) {
                close("engine_output_invalid");
                throw error;
              }
            },
          };
          resolveReady(ready);
        } else {
          if (!pending || message.id !== pending.id)
            throw new Error("unexpected_response");
          if (message.reassessment !== undefined) {
            const request = z
              .object({
                nonce: z.string(),
                question_id: z.string(),
                current_unit_id: z.string(),
              })
              .strict()
              .parse(message.reassessment);
            const active = pending;
            const question = active.input.questions.find(
              (q) => q.id === request.question_id,
            );
            if (
              !options.reassessRole ||
              active.reassessing ||
              reassessments >= 2 ||
              request.nonce !== `r${reassessments + 1}` ||
              !question ||
              question.facet !== "role" ||
              !["open", "held", "partial", "reopened"].includes(
                question.status,
              ) ||
              request.current_unit_id !== active.input.prefix.at(-1)?.id
            )
              throw new Error("invalid_reassessment_request");
            active.reassessing = true;
            reassessments++;
            const started = Date.now();
            const reviewSignal = AbortSignal.any([
              lifetime.signal,
              active.signal,
              AbortSignal.timeout(40000),
            ]);
            const review = options.reassessRole;
            void (async () => {
              let result = null;
              let outcome: ContextReview["outcome"] = "failed";
              try {
                const value = await new Promise<
                  Awaited<ReturnType<RoleReassessor>>
                >((resolveReview, rejectReview) => {
                  const abortReview = () =>
                    rejectReview(new LabError("engine_timeout", 503));
                  if (reviewSignal.aborted) return abortReview();
                  reviewSignal.addEventListener("abort", abortReview, {
                    once: true,
                  });
                  Promise.resolve()
                    .then(() =>
                      review(
                        structuredClone(active.input),
                        question.id,
                        reviewSignal,
                      ),
                    )
                    .then(resolveReview, rejectReview)
                    .finally(() =>
                      reviewSignal.removeEventListener("abort", abortReview),
                    );
                });
                if (reviewSignal.aborted)
                  throw new LabError("engine_timeout", 503);
                result =
                  value === null
                    ? null
                    : validateRoleContext(value, active.input, question.id);
                outcome = result ? "confirmed" : "unconfirmed";
              } catch {
                // Optional review failure is not a negative answer. Preserve
                // the valid Jev step and disclose the incomplete check to report.
              }
              if (stopped || pending !== active) return;
              active.reassessing = false;
              const event = {
                question_id: question.id,
                at_unit_id: request.current_unit_id,
                outcome,
              };
              ready.contextReviews!.push(event);
              options.onRecovery?.({
                ...event,
                elapsed_ms: Date.now() - started,
              });
              child.stdin.write(
                JSON.stringify({
                  id: active.id,
                  nonce: request.nonce,
                  reassessment_result: result,
                }) + "\n",
              );
            })().catch(() => close("engine_output_invalid"));
            return;
          }
          if (pending.reassessing)
            throw new Error("unexpected_reassessment_result");
          if (message.retries !== undefined) {
            const retries = z
              .array(
                z
                  .object({
                    code: z.enum([
                      "invalid_answer_distribution_argmax",
                      "invalid_answer_distribution_sum",
                      "jev_http_502",
                      "jev_http_503",
                      "jev_http_504",
                    ]),
                    call: z.number().int().positive(),
                  })
                  .strict(),
              )
              .max(2)
              .parse(message.retries);
            for (const retry of retries) options.onRetry?.(retry);
          }
          if (message.error) {
            if (message.metrics !== undefined)
              ready.metrics = metricsSchema.parse(message.metrics);
            if (
              typeof message.diagnostic_code === "string" &&
              (/^jev_http_[1-5][0-9]{2}$/u.test(message.diagnostic_code) ||
                [
                  "jev_timeout",
                  "jev_call_budget_exceeded",
                  "jev_response_too_large",
                  "jev_usage_missing",
                  "jev_model_mismatch",
                  "jev_request_or_response_failed",
                  "jev_redirect_rejected",
                ].includes(message.diagnostic_code) ||
                /^invalid_answer(?:_(?:keys|type|distribution_(?:label|keys|values|sum|argmax)))?$/u.test(
                  message.diagnostic_code,
                ))
            )
              options.onFailure?.(message.diagnostic_code);
            close(
              typeof message.error === "string" &&
                [
                  "engine_timeout",
                  "engine_output_invalid",
                  "engine_input_invalid",
                  "engine_budget_exceeded",
                ].includes(message.error)
                ? message.error
                : "engine_unavailable",
            );
            return;
          }
          ready.metrics = metricsSchema.parse(message.metrics);
          clearTimeout(pending.timer);
          pending.cleanup();
          pending.resolve(message.result as SemanticStep);
          pending = undefined;
        }
      } catch {
        close("engine_output_invalid");
      }
    });
    // Key is not inherited by subprocesses or persisted in a config/session file.
    child.stdin.write(
      JSON.stringify({
        api_key: options.apiKey,
        allow_remote: true,
        ...(options.reassessRole ? { reassessment: true } : {}),
      }) + "\n",
    );
  });
}
