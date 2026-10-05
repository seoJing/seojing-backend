import { z } from "zod";
import type {
  EventPayload,
  JobPosting,
  Note,
  Question,
  Unit,
} from "./contracts.js";
import { LabError } from "./errors.js";
import { facetLabels, type ReaderMemory } from "./reader.js";

// Display only: keep the full source quote and span in the evidence ledger.
// Omitting an overlong first word is safer than changing a number or unit.
function shortExcerpt(text: string, limit: number): string {
  const points = Array.from(text.trim());
  if (points.length <= limit) return points.join("");
  let end = Math.min(limit - 1, points.length);
  while (end > 0 && !/\s/u.test(points[end]!)) end--;
  return `${points.slice(0, end).join("").trimEnd()}…`;
}

function displayQuote(quote: string): string {
  return quote
    .trim()
    .replace(/^(?:#{1,6}\s+|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u, "");
}

const quoteSchema = z
  .object({ unit_id: z.string(), quote: z.string().min(1).max(400) })
  .strict();
const proofSchema = z.array(quoteSchema).min(1).max(6);
export const semanticStepSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            criterion_id: z.string(),
            facet: z.enum(["role", "method", "result", "basis"]),
            text: z.string().min(8).max(180),
            evidence: proofSchema,
          })
          .strict(),
      )
      .max(1),
    updates: z
      .array(
        z
          .object({
            question_id: z.string(),
            relation: z.enum(["complete", "partial", "conflict"]),
            text: z.string().min(8).max(200),
            evidence: proofSchema,
          })
          .strict(),
      )
      .max(32),
    evidence: z
      .array(
        z
          .object({
            requirement_ids: z.array(z.string()).min(1).max(4),
            text: z.string().min(8).max(200),
            evidence: proofSchema,
          })
          .strict(),
      )
      .max(1),
    retractions: z
      .array(
        z
          .object({
            note_id: z.string(),
            text: z.string().min(8).max(200),
            evidence: proofSchema,
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type SemanticStep = z.infer<typeof semanticStepSchema>;
export interface SemanticInput {
  job: JobPosting;
  prefix: readonly Unit[];
  questions: readonly Question[];
  notes: readonly Note[];
  note_retractions?: Readonly<NonNullable<ReaderMemory["note_retractions"]>>;
}
export interface SequentialReasoner {
  readStep(input: SemanticInput, signal: AbortSignal): Promise<SemanticStep>;
}

const internalCopy =
  /\b(?:[qnur]\d+|criterion_id|requirement_ids|open_at_end|held|resolved|reopened)\b/u;
function invalid(reason: string): never {
  throw new LabError("engine_output_invalid", 503, reason);
}
export function semanticInput(input: SemanticInput) {
  const current = input.prefix.at(-1);
  if (
    !current ||
    !input.job.reader_profile ||
    new Set(input.prefix.map((u) => u.id)).size !== input.prefix.length ||
    input.prefix.some((u, i) => u.order !== i)
  )
    throw new LabError("reader_prefix_invalid");
  const priorIds = new Set(input.prefix.slice(0, -1).map((u) => u.id));
  if (
    new Set(input.questions.map((q) => q.id)).size !== input.questions.length ||
    input.questions.some(
      (q) =>
        [...q.candidate_unit_ids, ...(q.evidence_unit_ids ?? [])].some(
          (id) => !priorIds.has(id),
        ) ||
        !input.job.reader_profile!.criteria.some(
          (c) =>
            c.id === q.criterion_id &&
            c.checks.some((check) => check.facet === q.facet),
        ) ||
        !input.prefix.some(
          (u) => u.id === q.unit_id && u.order < current.order,
        ),
    )
  )
    throw new LabError("reader_state_invalid");
  if (
    new Set(input.notes.map((n) => n.id)).size !== input.notes.length ||
    input.notes.some((n) => {
      const unit = input.prefix.find((u) => u.id === n.unit_id);
      return (
        !unit ||
        !priorIds.has(unit.id) ||
        n.evidence_unit_ids.some((id) => !priorIds.has(id)) ||
        n.span.block_id !== unit.block_id ||
        n.span.start < unit.start ||
        n.span.end > unit.end ||
        n.span.start >= n.span.end ||
        (n.question_id !== undefined &&
          !input.questions.some((q) => q.id === n.question_id))
      );
    })
  )
    throw new LabError("reader_state_invalid");
  const retractions = input.note_retractions ?? [];
  if (
    new Set(retractions.map((r) => r.note_id)).size !== retractions.length ||
    retractions.some((r) => {
      const note = input.notes.find((n) => n.id === r.note_id);
      const origin = input.prefix.find((u) => u.id === note?.unit_id);
      const at = input.prefix.find((u) => u.id === r.at_unit_id);
      return (
        !note ||
        note.kind !== "evidence" ||
        note.question_id !== undefined ||
        !origin ||
        !at ||
        !priorIds.has(at.id) ||
        at.order <= origin.order
      );
    })
  )
    throw new LabError("reader_state_invalid");
  return {
    requirements: input.job.requirements,
    reader_profile: input.job.reader_profile,
    units: input.prefix.map(({ id, text, order, scope_id }) => ({
      id,
      text,
      order,
      scope_id,
    })),
    current_unit_id: current.id,
    questions: input.questions,
    notes: input.notes.map((note) => {
      const unit = input.prefix.find((u) => u.id === note.unit_id)!;
      return {
        ...note,
        anchor_quote: unit.text.slice(
          note.span.start - unit.start,
          note.span.end - unit.start,
        ),
      };
    }),
    note_retractions: retractions,
  };
}

export function validateSemanticStep(
  value: unknown,
  input: SemanticInput,
): SemanticStep {
  semanticInput(input);
  const parsed = semanticStepSchema.safeParse(value);
  if (!parsed.success) return invalid("reader_step_schema_invalid");
  const step = parsed.data;
  const current = input.prefix.at(-1)!;
  const checkProof = (proof: z.infer<typeof proofSchema>) => {
    if (!proof.some((e) => e.unit_id === current.id))
      invalid("reader_current_quote_missing");
    for (const e of proof) {
      const unit = input.prefix.find((u) => u.id === e.unit_id);
      if (!unit || !unit.text.includes(e.quote))
        invalid("reader_quote_invalid");
    }
  };
  for (const item of [
    ...step.questions,
    ...step.updates,
    ...step.evidence,
    ...step.retractions,
  ]) {
    checkProof(item.evidence);
    if (internalCopy.test(item.text)) invalid("reader_internal_copy");
  }
  const retracted = new Set(
    (input.note_retractions ?? []).map((r) => r.note_id),
  );
  for (const correction of step.retractions) {
    const note = input.notes.find((n) => n.id === correction.note_id);
    if (
      !note ||
      note.kind !== "evidence" ||
      note.question_id !== undefined ||
      retracted.has(note.id)
    )
      invalid("reader_retraction_reference_invalid");
    retracted.add(note.id);
    if (!correction.evidence.some((e) => e.unit_id === note.unit_id))
      invalid("reader_retraction_origin_quote_missing");
    const origin = input.prefix.find((u) => u.id === note.unit_id)!;
    const overlapsAnchor = correction.evidence.some((e) => {
      if (e.unit_id !== origin.id) return false;
      let index = origin.text.indexOf(e.quote);
      while (index !== -1) {
        const start = Math.max(origin.start + index, note.span.start);
        const end = Math.min(
          origin.start + index + e.quote.length,
          note.span.end,
        );
        if (
          start < end &&
          origin.text.slice(start - origin.start, end - origin.start).trim()
        )
          return true;
        index = origin.text.indexOf(e.quote, index + 1);
      }
      return false;
    });
    if (!overlapsAnchor) invalid("reader_retraction_anchor_quote_missing");
  }
  const seen = new Set<string>();
  for (const q of step.questions) {
    const criterion = input.job.reader_profile!.criteria.find(
      (c) => c.id === q.criterion_id,
    );
    if (!criterion?.checks.some((c) => c.facet === q.facet))
      invalid("reader_question_criterion_invalid");
    if (
      input.questions.some(
        (prior) =>
          prior.criterion_id === q.criterion_id &&
          prior.facet === q.facet &&
          prior.scope_id === current.scope_id &&
          prior.text === q.text,
      )
    )
      invalid("reader_question_duplicate");
  }
  for (const update of step.updates) {
    const q = input.questions.find((q) => q.id === update.question_id);
    if (!q || seen.has(q.id)) invalid("reader_update_reference_invalid");
    seen.add(q.id);
    if (!update.evidence.some((e) => e.unit_id === q.unit_id))
      invalid("reader_origin_quote_missing");
    if (update.relation === "conflict" && !q.evidence_unit_ids?.length)
      invalid("reader_conflict_without_answer");
    if (
      update.relation === "conflict" &&
      !update.evidence.some((e) => q.evidence_unit_ids?.includes(e.unit_id))
    )
      invalid("reader_conflict_answer_quote_missing");
    if (
      update.relation === "partial" &&
      ["resolved", "reopened"].includes(q.status)
    )
      invalid("reader_partial_downgrade");
  }
  for (const card of step.evidence) {
    if (
      new Set(card.requirement_ids).size !== card.requirement_ids.length ||
      card.requirement_ids.some(
        (id) =>
          !input.job.requirements.some(
            (r) => r.id === id && r.kind !== "other",
          ),
      )
    )
      invalid("reader_evidence_requirement_invalid");
  }
  return step;
}

/** Commit only an entirely checked step. No partial mutation on model/audit failure. */
export async function readSemanticPrefix(
  prefix: readonly Unit[],
  job: JobPosting,
  reasoner: SequentialReasoner,
  memory: ReaderMemory,
  notes: Note[],
  questions: Question[],
  emit: (event: EventPayload) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new LabError("cancelled");
  const current = prefix.at(-1);
  if (
    !current ||
    !["codex_cli", "jev"].includes(memory.engine) ||
    memory.profile_id !== job.reader_profile?.id ||
    prefix.length !== memory.units.length + 1 ||
    prefix.some(
      (u, i) =>
        u.order !== i ||
        (i < memory.units.length &&
          JSON.stringify(u) !== JSON.stringify(memory.units[i])),
    )
  )
    throw new LabError("reader_prefix_invalid");
  const input: SemanticInput = {
    job,
    prefix,
    questions,
    notes,
    note_retractions: memory.note_retractions,
  };
  const step = validateSemanticStep(
    await reasoner.readStep(structuredClone(input), signal),
    input,
  );
  if (signal.aborted) throw new LabError("cancelled");
  memory.units.push(structuredClone(current));
  const ids = (proof: z.infer<typeof proofSchema>) => [
    ...new Set(proof.map((e) => e.unit_id)),
  ];
  const transition = (q: Question, previous: Question["status"] | null) => {
    q.state_version = (q.state_version ?? 0) + 1;
    const event: Extract<EventPayload, { type: "question_updated" }> = {
      type: "question_updated",
      question_id: q.id,
      previous_status: previous,
      status: q.status,
      evidence_unit_ids: [...(q.evidence_unit_ids ?? [])],
      state_version: q.state_version,
      at_unit_id: current.id,
      question: structuredClone(q),
    };
    memory.transitions.push(structuredClone(event));
    emit(event);
  };
  const card = (
    kind: Note["kind"],
    text: string,
    proof: z.infer<typeof proofSchema>,
    requirements: string[],
    q?: Question,
    retractedNoteId?: string,
  ) => {
    const anchor = proof.find((p) => p.unit_id === current.id)!;
    const start = current.start + current.text.indexOf(anchor.quote);
    const n: Note = {
      id: `n${notes.length + 1}`,
      unit_id: current.id,
      span: {
        block_id: current.block_id,
        start,
        end: start + anchor.quote.length,
      },
      kind,
      text: `“${shortExcerpt(displayQuote(anchor.quote), 64)}” — ${text}`,
      evidence_unit_ids: ids(proof),
      requirement_ids: requirements,
      review_required: true,
      ...(q ? { question_id: q.id } : {}),
      ...(retractedNoteId ? { retracted_note_id: retractedNoteId } : {}),
    };
    notes.push(n);
    emit({ type: "note", note: structuredClone(n) });
  };
  for (const update of step.updates) {
    const q = questions.find((q) => q.id === update.question_id)!;
    const criterion = job.reader_profile.criteria.find(
      (c) => c.id === q.criterion_id,
    )!;
    const previous = q.status;
    q.status =
      update.relation === "complete"
        ? "resolved"
        : update.relation === "conflict"
          ? "reopened"
          : "partial";
    q.evidence_unit_ids = [
      ...new Set([
        ...(memory.engine === "jev" ? [] : (q.evidence_unit_ids ?? [])),
        ...ids(update.evidence).filter((id) => id !== q.unit_id),
      ]),
    ];
    q.candidate_unit_ids = [...new Set([...q.candidate_unit_ids, current.id])];
    transition(q, previous);
    card(
      q.status === "resolved" ? "resolves" : "hold",
      update.text,
      update.evidence,
      [criterion.requirement_id],
      q,
    );
  }
  for (const created of step.questions) {
    const criterion = job.reader_profile.criteria.find(
      (c) => c.id === created.criterion_id,
    )!;
    const q: Question = {
      id: `q${questions.length + 1}`,
      unit_id: current.id,
      scope_id: current.scope_id,
      criterion_id: criterion.id,
      facet: created.facet,
      label: `${shortExcerpt(criterion.label, 24 - 3 - Array.from(facetLabels[created.facet]).length)} · ${facetLabels[created.facet]}`,
      text: created.text,
      status: "open",
      candidate_unit_ids: [],
      evidence_unit_ids: [],
      state_version: 0,
    };
    questions.push(q);
    transition(q, null);
    card(
      "question",
      created.text,
      created.evidence,
      [criterion.requirement_id],
      q,
    );
  }
  for (const item of step.evidence)
    card("evidence", item.text, item.evidence, item.requirement_ids);
  for (const correction of step.retractions) {
    const original = notes.find((n) => n.id === correction.note_id)!;
    (memory.note_retractions ??= []).push({
      note_id: original.id,
      at_unit_id: current.id,
    });
    card(
      "observation",
      correction.text,
      correction.evidence,
      [...original.requirement_ids],
      undefined,
      original.id,
    );
  }
  // Raw source and explicit transition ledger are authoritative. Never disguise
  // Codex's structured output as Laya probabilities in memory.observations.
}
