import type {
  JobPosting,
  Note,
  Question,
  ResumeDocument,
} from "./contracts.js";
import { focusSourceUnit, type FocusLedger } from "./focus-contract.js";
import type { ReaderMemory } from "./reader.js";
import { LabError } from "./errors.js";

/** Preserve inquiry provenance; qualification matching still reads original sources. */
export function focusReportState(
  document: ResumeDocument,
  job: JobPosting,
  ledger: FocusLedger,
) {
  if (
    !ledger.complete ||
    ledger.steps.length !== document.units.length ||
    !job.reader_profile ||
    JSON.stringify(ledger.units) !==
      JSON.stringify(document.units.map(focusSourceUnit))
  )
    throw new LabError("reader_not_complete", 503);
  const source = new Map(document.units.map((u) => [u.id, u]));
  const notes: Note[] = [];
  const memory: ReaderMemory = {
    engine: "jev",
    profile_id: job.reader_profile.id,
    units: structuredClone(document.units),
    observations: [],
    transitions: [],
    note_retractions: [],
    focus: {
      version: ledger.version,
      questions: structuredClone(ledger.questions),
    },
  };
  for (const step of ledger.steps)
    for (const event of step.events) {
      if (event.type === "observation") {
        const unit = source.get(event.at_unit_id)!;
        notes.push({
          id: event.note_id,
          unit_id: unit.id,
          span: { block_id: unit.block_id, start: unit.start, end: unit.end },
          kind: "observation",
          text:
            event.kind === "plan"
              ? "앞으로의 계획으로 적힌 내용입니다."
              : "원문에 설명된 활동의 구체적인 내용을 기록했습니다.",
          evidence_unit_ids: event.evidence.map((p) => p.unit_id),
          requirement_ids: [],
          review_required: true,
        });
      } else if (event.type === "retracted") {
        memory.note_retractions!.push({
          note_id: event.note_id,
          at_unit_id: event.at_unit_id,
        });
      }
    }
  const questions: Question[] = ledger.questions.map((q) => ({
    id: q.id,
    unit_id: q.origin_unit_id,
    scope_id: source.get(q.origin_unit_id)!.scope_id,
    text: q.text,
    status: q.status === "open" ? "open_at_end" : q.status,
    candidate_unit_ids: q.evidence.map((p) => p.unit_id),
    evidence_unit_ids: q.evidence.map((p) => p.unit_id),
    ...(q.facet === "reason" ? { label: "선택 이유" } : { facet: q.facet }),
    state_version: q.state_version,
  }));
  // Focus events remain in their own stream. These are report-only historical
  // transitions, never additional public question_updated events or seqs.
  for (const step of ledger.steps)
    for (const e of step.events)
      if (e.type === "updated" || e.type === "inquiry") {
        const q = questions.find((q) => q.id === e.question.id)!;
        const snapshot = {
          ...q,
          status: e.question.status,
          state_version: e.state_version,
          evidence_unit_ids: e.question.evidence.map((p) => p.unit_id),
          candidate_unit_ids: e.question.evidence.map((p) => p.unit_id),
        };
        memory.transitions.push({
          type: "question_updated",
          question_id: q.id,
          previous_status: e.type === "updated" ? e.previous_status : null,
          status: e.question.status,
          evidence_unit_ids: snapshot.evidence_unit_ids,
          at_unit_id: e.at_unit_id,
          state_version: e.state_version,
          question: snapshot,
        });
      }
  return { notes, questions, memory };
}
