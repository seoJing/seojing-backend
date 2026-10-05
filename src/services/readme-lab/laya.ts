import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { z } from "zod";
import type { LayaMetadata } from "./contracts.js";
import { LabError } from "./errors.js";
import {
  modelEnvironment,
  modelShutdownStarted,
  terminate,
  trackModelProcess,
} from "./process.js";

export type Decision = Record<string, { label: string; confidence: number }>;
export type DecisionKind =
  | "unit"
  | "relation"
  | "relevance"
  | "reader_unit"
  | "reader_relation"
  | "reader_check";
export interface Classifier {
  metadata: LayaMetadata;
  predict: (kind: DecisionKind, state: unknown) => Promise<Decision>;
  close(): void;
}
const resultSchema = z.record(
  z.string(),
  z
    .object({ label: z.string(), confidence: z.number().min(0).max(1) })
    .strict(),
);
const metadataSchema = z
  .object({
    model: z.literal("convaiinnovations/laya-multilingual"),
    revision: z.literal("e4e9ddf21a7b1903b7acffd8814ad4307bf63a67"),
    sdk: z.literal("0.3.25"),
    device: z.string(),
    weights_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    finetuned: z.literal(false),
    calibrated_for_readme: z.literal(false),
  })
  .strict();

export function openLaya(
  signal: AbortSignal,
  directory = resolve(".local/readme-laya"),
  script = resolve("src/services/readme-lab/python/runtime.py"),
): Promise<Classifier> {
  if (signal.aborted) return Promise.reject(new LabError("cancelled"));
  if (modelShutdownStarted())
    return Promise.reject(new LabError("engine_unavailable", 503));
  return new Promise((resolveReady, rejectReady) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      resolve(directory, "venv/bin/python"),
      [script, resolve(directory, "model")],
      {
        env: {
          ...modelEnvironment(),
          HF_HUB_OFFLINE: "1",
          TOKENIZERS_PARALLELISM: "false",
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    trackModelProcess(child);
    let pending:
      | {
          id: string;
          resolve: (result: Decision) => void;
          reject: (error: LabError) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    let stopped = false;
    let ready = false;
    let counter = 0;
    let bytes = 0;
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
      if (!ready) rejectReady(new LabError(code, 503));
      terminate(child);
    };
    const abort = () => close("cancelled");
    const loadTimer = setTimeout(() => close("engine_timeout"), 45000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => close("engine_unavailable"));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) close("engine_output_invalid");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) close("engine_output_invalid");
    });
    child.on("error", () => close("engine_unavailable"));
    child.on("close", () => close("engine_unavailable"));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (stopped) return;
      try {
        const message = JSON.parse(line) as {
          ready?: unknown;
          id?: string;
          result?: unknown;
          error?: string;
        };
        if (!ready) {
          const metadata = metadataSchema.parse(message.ready);
          ready = true;
          clearTimeout(loadTimer);
          resolveReady({
            metadata,
            close: () => close(),
            predict(kind, state) {
              if (stopped)
                return Promise.reject(new LabError("engine_unavailable", 503));
              if (pending)
                return Promise.reject(new LabError("engine_busy", 503));
              return new Promise((resolveResult, rejectResult) => {
                const id = String(++counter);
                pending = {
                  id,
                  resolve: resolveResult,
                  reject: rejectResult,
                  timer: setTimeout(() => close("engine_timeout"), 20000),
                };
                child.stdin.write(JSON.stringify({ id, kind, state }) + "\n");
              });
            },
          });
        } else {
          if (!pending || pending.id !== message.id)
            throw new Error("unexpected_response");
          if (message.error) {
            if (message.error === "context_budget_exceeded") {
              clearTimeout(pending.timer);
              pending.reject(new LabError("context_budget_exceeded", 422));
              pending = undefined;
              return;
            }
            close(
              message.error === "engine_input_invalid"
                ? "engine_input_invalid"
                : "engine_unavailable",
            );
            return;
          }
          const value = resultSchema.parse(message.result);
          clearTimeout(pending.timer);
          pending.resolve(value);
          pending = undefined;
        }
      } catch {
        close("engine_output_invalid");
      }
    });
  });
}
