import { z } from "zod";
import type { Unit } from "./contracts.js";
import { LabError } from "./errors.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u);
const proof = z
  .object({
    unit_id: id,
    quote: z.string().min(1).max(400),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
export const focusQuestionSchema = z
  .object({
    id,
    origin_unit_id: id,
    context_id: id,
    facet: z.enum(["role", "method", "result", "basis", "reason"]),
    text: z.string().min(1).max(200),
    status: z.enum(["open", "partial", "resolved", "reopened"]),
    evidence: z.array(proof).max(6),
    focus: z.enum(["active", "parked"]),
    state_version: z.number().int().positive(),
    withdrawn_evidence: z.array(proof).max(120),
    correction_evidence: z.array(proof).max(6),
  })
  .strict();
const base = { at_unit_id: id, context_id: id.nullable() };
export const focusEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("context"),
      topic: z.string().max(90),
      source_unit_ids: z.array(id).max(120),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("inquiry"),
      question: focusQuestionSchema,
      state_version: z.number().int().positive(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("parked"), question_id: id }).strict(),
  z
    .object({
      ...base,
      type: z.literal("revisit"),
      question_id: id,
      target_unit_ids: z.array(id).min(1).max(7),
      reason: z.enum(["answer", "correction"]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("updated"),
      question: focusQuestionSchema,
      previous_status: focusQuestionSchema.shape.status,
      state_version: z.number().int().positive(),
      target_unit_ids: z.array(id).min(1).max(7),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("observation"),
      note_id: id,
      kind: z.enum([
        "action",
        "method",
        "outcome",
        "reason",
        "boundary",
        "plan",
      ]),
      evidence: z.array(proof).min(1).max(6),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("retracted"),
      note_id: id,
      evidence: z.array(proof).min(1).max(6),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("speech"),
      code: z.enum([
        "ask_role",
        "ask_method",
        "ask_result",
        "ask_basis",
        "ask_reason",
        "partial",
        "resolved",
        "revisit",
        "reopened",
        "parked",
        "understood",
        "revised",
      ]),
      question_id: id.optional(),
      target_unit_ids: z.array(id).min(1).max(7),
    })
    .strict(),
]);
export const focusStepSchema = z
  .object({
    version: z.literal("focus-reader-v1"),
    at_unit_id: id,
    context_id: id.nullable(),
    active_question_id: id.nullable(),
    events: z.array(focusEventSchema).max(64),
  })
  .strict();
export type FocusQuestion = z.infer<typeof focusQuestionSchema>;
export type FocusEvent = z.infer<typeof focusEventSchema>;
export type FocusStep = z.infer<typeof focusStepSchema>;
export interface FocusLedger {
  version: "focus-reader-v1";
  steps: FocusStep[];
  questions: FocusQuestion[];
  units: Unit[];
  complete: boolean;
}

export function focusSourceUnit(u: Unit): Unit {
  return {
    id: u.id,
    block_id: u.block_id,
    order: u.order,
    scope_id: u.scope_id,
    start: u.start,
    end: u.end,
    text: u.text,
  };
}

/** Validate an entire window before committing any state or emitting any event. */
export function validateFocusStep(
  value: unknown,
  prefix: readonly Unit[],
  ledger: FocusLedger,
): FocusStep {
  const parsed = focusStepSchema.safeParse(value);
  const fail = (): never => {
    throw new LabError("engine_output_invalid", 503);
  };
  if (!parsed.success) return fail();
  const step = parsed.data,
    current = prefix.at(-1);
  if (
    !current ||
    step.at_unit_id !== current.id ||
    prefix.length !== ledger.steps.length + 1
  )
    return fail();
  if (
    ledger.complete ||
    JSON.stringify(prefix.slice(0, -1).map(focusSourceUnit)) !==
      JSON.stringify(ledger.units)
  )
    return fail();
  const source = new Map(prefix.map((u) => [u.id, u]));
  const qs = new Map(ledger.questions.map((q) => [q.id, structuredClone(q)]));
  const notes = new Set(
    ledger.steps.flatMap((s) =>
      s.events.flatMap((e) => (e.type === "observation" ? [e.note_id] : [])),
    ),
  );
  const retracted = new Set(
    ledger.steps.flatMap((s) =>
      s.events.flatMap((e) => (e.type === "retracted" ? [e.note_id] : [])),
    ),
  );
  const speeches = new Set<string>();
  const revisits = new Map<string, string[]>();
  const stateEvents = new Map<string, string>();
  const checkIds = (ids: string[]) => {
    if (ids.some((x) => !source.has(x))) fail();
  };
  const checkProof = (items: z.infer<typeof proof>[]) => {
    if (new Set(items.map((p) => p.unit_id)).size !== items.length) fail();
    for (const p of items) {
      const u = source.get(p.unit_id);
      if (
        !u ||
        p.end <= p.start ||
        u.text.slice(p.start, p.end) !== p.quote ||
        p.end > u.text.length
      )
        fail();
    }
  };
  for (const e of step.events) {
    if (e.at_unit_id !== current.id) fail();
    if ("target_unit_ids" in e) checkIds(e.target_unit_ids);
    if ("evidence" in e) checkProof(e.evidence);
    if (e.type === "context") checkIds(e.source_unit_ids);
    if (e.type === "inquiry" || e.type === "updated") {
      const q = e.question,
        old = qs.get(q.id);
      if (
        !source.has(q.origin_unit_id) ||
        q.context_id !== e.context_id ||
        e.state_version !== q.state_version
      )
        fail();
      checkProof(q.evidence);
      checkProof(q.withdrawn_evidence);
      checkProof(q.correction_evidence);
      if (
        (q.status === "resolved" || q.status === "partial") &&
        (!q.evidence.some((p) => p.unit_id === current.id) ||
          q.evidence.some((p) =>
            q.withdrawn_evidence.some((w) => w.unit_id === p.unit_id),
          ))
      )
        fail();
      if (
        q.status === "resolved" &&
        (!q.evidence.length || q.focus !== "parked")
      )
        fail();
      if (
        q.status === "reopened" &&
        (q.evidence.length || !q.correction_evidence.length)
      )
        fail();
      if (e.type === "inquiry") {
        if (
          old ||
          q.state_version !== 1 ||
          q.status !== "open" ||
          q.origin_unit_id !== current.id ||
          q.focus !== "active" ||
          q.evidence.length ||
          [...qs.values()].some((v) => v.focus === "active")
        )
          fail();
      } else {
        if (
          !old ||
          q.state_version !== old.state_version + 1 ||
          e.previous_status !== old.status ||
          q.origin_unit_id !== old.origin_unit_id ||
          q.facet !== old.facet ||
          q.text !== old.text ||
          q.context_id !== old.context_id ||
          (old.focus === "parked" && q.focus !== "parked") ||
          JSON.stringify(revisits.get(q.id)) !==
            JSON.stringify(e.target_unit_ids)
        )
          fail();
        if (
          q.status === "reopened" &&
          (!q.correction_evidence.some((p) => p.unit_id === current.id) ||
            !old!.evidence.length ||
            old!.evidence.some(
              (p) =>
                !q.withdrawn_evidence.some(
                  (w) => JSON.stringify(w) === JSON.stringify(p),
                ),
            ))
        )
          fail();
        if (
          old!.withdrawn_evidence.some(
            (p) =>
              !q.withdrawn_evidence.some(
                (w) => JSON.stringify(w) === JSON.stringify(p),
              ),
          )
        )
          fail();
        revisits.delete(q.id);
      }
      qs.set(q.id, structuredClone(q));
      stateEvents.set(q.id, e.type === "inquiry" ? "ask_" + q.facet : q.status);
    } else if (e.type === "parked") {
      const q = qs.get(e.question_id);
      if (!q || q.focus !== "active" || q.status === "resolved") fail();
      q!.focus = "parked";
      stateEvents.set(e.question_id, "parked");
    } else if (e.type === "revisit") {
      const q = qs.get(e.question_id);
      if (
        !q ||
        revisits.has(e.question_id) ||
        !e.target_unit_ids.includes(q.origin_unit_id) ||
        e.target_unit_ids.some((x) => source.get(x)!.order >= current.order)
      )
        fail();
      revisits.set(e.question_id, e.target_unit_ids);
    } else if (e.type === "observation") {
      if (
        notes.has(e.note_id) ||
        !e.evidence.some((p) => p.unit_id === current.id)
      )
        fail();
      notes.add(e.note_id);
    } else if (e.type === "retracted") {
      if (
        !notes.has(e.note_id) ||
        retracted.has(e.note_id) ||
        !e.evidence.some((p) => p.unit_id === current.id)
      )
        fail();
      const original = ledger.steps
        .flatMap((s) => s.events)
        .find((n) => n.type === "observation" && n.note_id === e.note_id);
      if (
        !original ||
        original.type !== "observation" ||
        !e.evidence.some((p) =>
          original.evidence.some((o) => o.unit_id === p.unit_id),
        )
      )
        fail();
      retracted.add(e.note_id);
    } else if (e.type === "speech") {
      if (e.question_id) {
        if (
          !qs.has(e.question_id) ||
          speeches.has(e.question_id) ||
          stateEvents.get(e.question_id) !== e.code
        )
          fail();
        speeches.add(e.question_id);
      } else if (e.code !== "understood" && e.code !== "revised") fail();
      if (
        e.code === "revised" &&
        !step.events.some((v) => v.type === "retracted")
      )
        fail();
      if (
        e.code === "understood" &&
        !step.events.some((v) => v.type === "observation")
      )
        fail();
    }
  }
  const active = [...qs.values()].filter((q) => q.focus === "active");
  if (
    revisits.size ||
    active.length > 1 ||
    (active[0]?.id ?? null) !== step.active_question_id
  )
    fail();
  ledger.units = prefix.map(focusSourceUnit);
  ledger.questions = [...qs.values()];
  ledger.steps.push(structuredClone(step));
  return step;
}
