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
import { jevMetadataSchema, type JevMetadata } from "./jev.js";
import type { Unit } from "./contracts.js";
import {
  validateFocusStep,
  type FocusLedger,
  type FocusStep,
} from "./focus-contract.js";

const count = z.number().int().nonnegative();
/** Internal count-only telemetry; never allow arbitrary model/source fields. */
export const focusDiagnosticsSchema = z
  .object({
    candidate_routes: count,
    no_context_candidates: count,
    duplicate_facet: count,
    candidate_audits: count,
    accepted_questions: count,
    unsupported_claim: count,
    uncertain_claim: count,
    already_answered: count,
    uncertain_answer: count,
    cross_page_uncertain: count,
    discovery_deferred: count,
    explicit_rechecks: count,
    fallback_rechecks: count,
    fallback_deferred: count,
    fallback_budget_skipped: count,
    fallback_source_skipped: count,
    fallback_updates: count,
    different_or_uncertain_experience: count,
    no_answer_relation: count,
    missing_current_proof: count,
    invalid_transition: count,
    unchanged_answer: count,
    verified_updates: count,
  })
  .strict();
export type FocusDiagnostics = z.infer<typeof focusDiagnosticsSchema>;
const metricsSchema = z
  .object({
    calls: count,
    input_tokens: count,
    output_tokens: count,
    steps: count,
    retrievals: count,
    abstentions: count,
    limited: count,
  })
  .strict();
export interface FocusReader {
  metadata: JevMetadata;
  metrics: z.infer<typeof metricsSchema>;
  diagnostics?: FocusDiagnostics | null;
  ledger: FocusLedger;
  readStep(
    prefix: Array<Unit & { block_type?: string }>,
    roleContext: string,
  ): Promise<FocusStep>;
  finish(): Promise<void>;
  close(): void;
}
export interface FocusOptions {
  apiKey: string;
  python?: string;
  script?: string;
  timeoutMs?: number;
}

/** Separate opt-in worker: no production switch, default credentials or source logs. */
export function openFocusJev(
  signal: AbortSignal,
  totalUnits: number,
  options: FocusOptions,
): Promise<FocusReader> {
  if (signal.aborted) return Promise.reject(new LabError("cancelled"));
  if (
    modelShutdownStarted() ||
    !options.apiKey ||
    options.apiKey.length < 16 ||
    options.apiKey.length > 1000 ||
    !Number.isInteger(totalUnits) ||
    totalUnits < 1 ||
    totalUnits > 120
  )
    return Promise.reject(new LabError("engine_input_invalid", 503));
  return new Promise((resolveReady, rejectReady) => {
    const child = spawn(
      options.python ?? "/usr/bin/python3",
      [
        options.script ??
          resolve("src/services/readme-lab/python/jev_focus_runtime.py"),
      ],
      {
        env: { ...modelEnvironment(), PYTHONDONTWRITEBYTECODE: "1" },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    trackModelProcess(child);
    let reader: FocusReader | undefined;
    let stopped = false,
      bytes = 0,
      counter = 0,
      finished = false;
    let pending:
      | {
          id: string;
          resolve: (v: Record<string, unknown>) => void;
          reject: (e: LabError) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    const close = (code = "cancelled") => {
      if (stopped) return;
      stopped = true;
      clearTimeout(loadTimer);
      signal.removeEventListener("abort", abort);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new LabError(code, 503));
        pending = undefined;
      }
      if (!reader) rejectReady(new LabError(code, 503));
      terminate(child);
    };
    const abort = () => close("cancelled");
    const loadTimer = setTimeout(() => close("engine_timeout"), 10000);
    signal.addEventListener("abort", abort, { once: true });
    const request = (payload: object) =>
      new Promise<Record<string, unknown>>((resolveResult, rejectResult) => {
        if (signal.aborted || stopped || finished) {
          rejectResult(
            new LabError(
              signal.aborted ? "cancelled" : "engine_unavailable",
              503,
            ),
          );
          return;
        }
        if (pending) {
          rejectResult(new LabError("engine_busy", 503));
          return;
        }
        const id = String(++counter),
          encoded = JSON.stringify({ id, ...payload }) + "\n";
        if (Buffer.byteLength(encoded) > 1_000_000) {
          rejectResult(new LabError("engine_input_invalid", 503));
          return;
        }
        pending = {
          id,
          resolve: resolveResult,
          reject: rejectResult,
          timer: setTimeout(
            () => close("engine_timeout"),
            options.timeoutMs ?? 45000,
          ),
        };
        child.stdin.write(encoded);
      });
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
        const value = JSON.parse(line) as Record<string, unknown>;
        if (!reader) {
          if (value.version !== "focus-reader-v1")
            throw new Error("invalid_version");
          const metadata = jevMetadataSchema.parse(value.ready);
          clearTimeout(loadTimer);
          reader = {
            metadata,
            diagnostics: null,
            metrics: {
              calls: 0,
              input_tokens: 0,
              output_tokens: 0,
              steps: 0,
              retrievals: 0,
              abstentions: 0,
              limited: 0,
            },
            ledger: {
              version: "focus-reader-v1",
              steps: [],
              questions: [],
              units: [],
              complete: false,
            },
            close: () => close(),
            async readStep(prefix, roleContext) {
              const result = await request({
                input: { prefix, role_context: roleContext },
              });
              try {
                return validateFocusStep(result.result, prefix, reader!.ledger);
              } catch {
                close("engine_output_invalid");
                throw new LabError("engine_output_invalid", 503);
              }
            },
            async finish() {
              if (reader!.ledger.steps.length !== totalUnits)
                throw new LabError("reader_not_complete", 503);
              const response = await request({ finish: true });
              const snapshot = response.snapshot as
                | {
                    version?: unknown;
                    frontier_unit_id?: unknown;
                    questions?: unknown;
                  }
                | undefined;
              if (
                !snapshot ||
                snapshot.version !== "focus-reader-v1" ||
                snapshot.frontier_unit_id !==
                  reader!.ledger.steps.at(-1)?.at_unit_id ||
                JSON.stringify(snapshot.questions) !==
                  JSON.stringify(reader!.ledger.questions)
              ) {
                close("engine_output_invalid");
                throw new LabError("engine_output_invalid", 503);
              }
              reader!.ledger.complete = true;
              finished = true;
            },
          };
          resolveReady(reader);
          return;
        }
        if (!pending || value.id !== pending.id) {
          close("engine_output_invalid");
          return;
        }
        reader.metrics = metricsSchema.parse(value.metrics);
        reader.diagnostics =
          value.diagnostics === undefined
            ? null
            : focusDiagnosticsSchema.parse(value.diagnostics);
        if (value.error) {
          const code =
            typeof value.error === "string" &&
            [
              "engine_unavailable",
              "engine_timeout",
              "engine_budget_exceeded",
              "engine_output_invalid",
              "reader_not_complete",
            ].includes(value.error)
              ? value.error
              : "engine_output_invalid";
          close(code);
          return;
        }
        const done = pending;
        pending = undefined;
        clearTimeout(done.timer);
        done.resolve(value);
      } catch {
        close("engine_output_invalid");
      }
    });
    child.stdin.write(
      JSON.stringify({
        api_key: options.apiKey,
        allow_remote: true,
        total_units: totalUnits,
      }) + "\n",
    );
  });
}
