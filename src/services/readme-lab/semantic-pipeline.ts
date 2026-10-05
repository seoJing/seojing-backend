import type {
  EventPayload,
  JobPosting,
  Note,
  Question,
  ResumeDocument,
} from "./contracts.js";
import type { Reasoner } from "./codex.js";
import { LabError, errorCode } from "./errors.js";
import { createMemory, finishReading } from "./reader.js";
import {
  readSemanticPrefix,
  type SequentialReasoner,
} from "./semantic-reader.js";

/** Internal/offline baseline. Public serving selection awaits engine contract acknowledgement. */
export async function readSemanticDocument(
  document: ResumeDocument,
  job: JobPosting,
  reasoner: SequentialReasoner & Pick<Reasoner, "report">,
  emit: (event: EventPayload) => void,
  callerSignal: AbortSignal,
  options: { timeoutMs?: number; engine?: "codex_cli" | "jev" } = {},
) {
  const signal = AbortSignal.any([
    callerSignal,
    // A measured 40-unit read took 551s before reporting; retain room for the
    // independently verified report without dropping source or audit calls.
    AbortSignal.timeout(options.timeoutMs ?? 15 * 60 * 1000),
  ]);
  const memory = createMemory(job, options.engine ?? "codex_cli"),
    notes: Note[] = [],
    questions: Question[] = [];
  const started = Date.now();
  let firstUseful: number | null = null;
  const elapsed: number[] = [];
  const send = (event: EventPayload) => {
    if (signal.aborted) throw new LabError("cancelled");
    if (event.type === "note" && firstUseful === null)
      firstUseful = Date.now() - started;
    emit(event);
  };
  try {
    for (let i = 0; i < document.units.length; i++) {
      if (signal.aborted) throw new LabError("cancelled");
      const unit = document.units[i]!,
        window_id = `w${i + 1}`,
        unit_ids = [unit.id];
      send({ type: "window_started", window_id, unit_ids });
      const stepStarted = Date.now();
      await readSemanticPrefix(
        document.units.slice(0, i + 1),
        job,
        reasoner,
        memory,
        notes,
        questions,
        send,
        signal,
      );
      elapsed.push(Date.now() - stepStarted);
      send({ type: "window_completed", window_id, unit_ids });
    }
    finishReading(memory, questions, send);
    send({ type: "reading_completed" });
    const reportStart = Date.now();
    const report = await reasoner.report(
      document,
      job,
      notes,
      questions,
      signal,
      memory,
    );
    if (signal.aborted) throw new LabError("cancelled");
    send({ type: "report_completed" });
    return {
      notes,
      questions,
      memory,
      report,
      metrics: {
        first_useful_ms: firstUseful,
        step_ms: elapsed,
        report_ms: Date.now() - reportStart,
        total_ms: Date.now() - started,
      },
    };
  } catch (error) {
    const failure =
      signal.aborted && !callerSignal.aborted
        ? new LabError("engine_timeout", 503)
        : error;
    emit(
      callerSignal.aborted
        ? { type: "cancelled" }
        : {
            type: "failed",
            error: errorCode(failure),
            partial: memory.units.length > 0,
          },
    );
    throw failure;
  }
}
