import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Unit } from "./contracts.js";
import { LabError } from "./errors.js";
import {
  focusQuestionSchema,
  focusSourceUnit,
  focusStepSchema,
  validateFocusStep,
  type FocusLedger,
} from "./focus-contract.js";

export const SITUATION_VERSION = "situation-reader-v1" as const;
export const SITUATION_POLICY = "readme-situation-v1" as const;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u);
const version = z.number().int().positive();
export const situationProofSchema = z
  .object({
    unit_id: id,
    quote: z.string().min(1).max(400),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
const proofs = z.array(situationProofSchema).max(8);
export const situationEntitySchema = z
  .object({
    id,
    kind: z.enum(["project", "product", "organization", "activity", "term"]),
    canonical_name: z.string().trim().min(1).max(120),
    aliases: z.array(z.string().trim().min(1).max(120)).max(8),
    introduced_at_unit_id: id,
    context_id: id.nullable(),
    origin: situationProofSchema,
    status: z.enum(["noticed", "explained"]),
    definition_unit_ids: z.array(id).max(120),
  })
  .strict();
export const situationExpectationSchema = z
  .object({
    id,
    kind: z.enum([
      "entity_definition",
      "overview_detail",
      "reference_resolution",
      "causal_explanation",
    ]),
    origin_unit_id: id,
    origin: situationProofSchema,
    context_id: id.nullable(),
    entity_ids: z.array(id).length(1),
    prompt: z.string().min(1).max(200),
    sufficient: z.string().min(1).max(300),
    status: z.enum([
      "pending",
      "partially_satisfied",
      "satisfied",
      "contradicted",
      "unresolved_at_end",
    ]),
    evidence: proofs,
    withdrawn_evidence: z.array(situationProofSchema).max(120),
    correction_evidence: proofs,
    state_version: version,
    focus: z.enum(["active", "parked"]),
  })
  .strict();
const targets = z.array(id).min(1).max(8);
const base = { at_unit_id: id };
export const situationEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("attention_created"),
      entity: situationEntitySchema,
      expectation: situationExpectationSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("expectation_parked"),
      expectation_id: id,
      previous_version: version,
      state_version: version,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("source_revisit"),
      expectation_id: id,
      target_unit_ids: targets,
      reason: z.enum(["definition", "detail", "reference", "correction"]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("expectation_updated"),
      previous_status: situationExpectationSchema.shape.status,
      expectation: situationExpectationSchema,
      target_unit_ids: targets,
    })
    .strict(),
]);
export const situationFinishedEventSchema = z
  .object({
    ...base,
    type: z.literal("expectation_finished"),
    previous_status: z.enum(["pending", "partially_satisfied"]),
    expectation: situationExpectationSchema,
  })
  .strict();
export const situationStepSchema = z
  .object({
    version: z.literal(SITUATION_VERSION),
    at_unit_id: id,
    active_expectation_id: id.nullable(),
    events: z.array(situationEventSchema).max(32),
    focus: focusStepSchema,
  })
  .strict();
export const situationSnapshotSchema = z
  .object({
    entities: z.array(situationEntitySchema).max(32),
    expectations: z.array(situationExpectationSchema).max(24),
    questions: z.array(focusQuestionSchema).max(16),
  })
  .strict();
export const situationFinishSchema = z
  .object({
    version: z.literal(SITUATION_VERSION),
    at_unit_id: id,
    final_events: z.array(situationFinishedEventSchema).max(24),
    snapshot: situationSnapshotSchema,
  })
  .strict();
export type SituationProof = z.infer<typeof situationProofSchema>;
export type SituationEntity = z.infer<typeof situationEntitySchema>;
export type SituationExpectation = z.infer<typeof situationExpectationSchema>;
export type SituationEvent = z.infer<typeof situationEventSchema>;
export type SituationStep = z.infer<typeof situationStepSchema>;
export type SituationFinish = z.infer<typeof situationFinishSchema>;
export interface SituationLedger {
  version: typeof SITUATION_VERSION;
  /** Local validator manifest only. Never send this unread suffix to the worker. */
  readonly source_units: readonly Readonly<Unit>[];
  steps: SituationStep[];
  entities: SituationEntity[];
  expectations: SituationExpectation[];
  focus: FocusLedger;
  final_events: SituationFinish["final_events"];
  complete: boolean;
}
const fail = (): never => {
  throw new LabError("engine_output_invalid", 503);
};
const equal = isDeepStrictEqual;
function requireEqual(a: unknown, b: unknown): void {
  if (!equal(a, b)) fail();
}
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** Bind the complete immutable source locally; reading still receives one prefix at a time. */
export function createSituationLedger(units: readonly Unit[]): SituationLedger {
  const source = units.map(focusSourceUnit);
  if (
    !source.length ||
    !unique(source.map((u) => u.id)) ||
    source.some(
      (u, i) =>
        !id.safeParse(u.id).success ||
        !id.safeParse(u.block_id).success ||
        !id.safeParse(u.scope_id).success ||
        !Number.isInteger(u.order) ||
        u.order < 0 ||
        (i > 0 && u.order <= source[i - 1]!.order) ||
        typeof u.text !== "string" ||
        !u.text.length ||
        !Number.isInteger(u.start) ||
        u.start < 0 ||
        !Number.isInteger(u.end) ||
        u.end <= u.start,
    )
  )
    throw new LabError("engine_input_invalid", 503);
  return {
    version: SITUATION_VERSION,
    source_units: Object.freeze(source.map((u) => Object.freeze(u))),
    steps: [],
    entities: [],
    expectations: [],
    final_events: [],
    complete: false,
    focus: {
      version: "focus-reader-v1",
      steps: [],
      questions: [],
      units: [],
      complete: false,
    },
  };
}
function checkProofs(
  items: SituationProof[],
  source: Map<string, Readonly<Unit>>,
): void {
  if (!unique(items.map((p) => p.unit_id))) fail();
  for (const p of items) {
    const u = source.get(p.unit_id);
    if (
      !u ||
      p.end <= p.start ||
      p.end > u.text.length ||
      u.text.slice(p.start, p.end) !== p.quote
    )
      fail();
  }
}
function checkExpectation(
  q: SituationExpectation,
  source: Map<string, Readonly<Unit>>,
): void {
  if (q.origin.unit_id !== q.origin_unit_id) fail();
  checkProofs([q.origin], source);
  checkProofs(q.evidence, source);
  checkProofs(q.withdrawn_evidence, source);
  checkProofs(q.correction_evidence, source);
  if (
    q.evidence.some((p) =>
      q.withdrawn_evidence.some((w) => w.unit_id === p.unit_id),
    )
  )
    fail();
}
function identity(q: SituationExpectation) {
  return {
    id: q.id,
    kind: q.kind,
    origin_unit_id: q.origin_unit_id,
    origin: q.origin,
    context_id: q.context_id,
    entity_ids: q.entity_ids,
    prompt: q.prompt,
    sufficient: q.sufficient,
  };
}
function activeId(expectations: SituationExpectation[]): string | null {
  const active = expectations.filter((q) => q.focus === "active");
  if (active.length > 1) fail();
  return active[0]?.id ?? null;
}
function deriveEntities(
  entities: SituationEntity[],
  expectations: SituationExpectation[],
): SituationEntity[] {
  return entities.map((entity) => {
    const definitions = expectations.filter(
      (q) =>
        q.entity_ids.includes(entity.id) &&
        q.kind === "entity_definition" &&
        q.status === "satisfied",
    );
    return {
      ...entity,
      status: definitions.length ? "explained" : "noticed",
      definition_unit_ids: [
        ...new Set(
          definitions.flatMap((q) => q.evidence.map((p) => p.unit_id)),
        ),
      ],
    };
  });
}
function reasonFor(
  q: SituationExpectation,
): "definition" | "detail" | "reference" | "correction" {
  if (q.status === "contradicted") return "correction";
  return q.kind === "entity_definition"
    ? "definition"
    : q.kind === "reference_resolution"
      ? "reference"
      : "detail";
}
function checkUpdate(
  old: SituationExpectation,
  q: SituationExpectation,
  current: Unit,
): void {
  requireEqual(identity(q), identity(old));
  if (
    q.state_version !== old.state_version + 1 ||
    (old.focus === "parked" && q.focus !== "parked")
  )
    fail();
  if (q.status === "contradicted") {
    if (
      !["pending", "partially_satisfied", "satisfied"].includes(old.status) ||
      q.focus !== "parked" ||
      q.evidence.length
    )
      fail();
    requireEqual(q.withdrawn_evidence, [
      ...old.withdrawn_evidence,
      ...old.evidence,
    ]);
    requireEqual(q.correction_evidence.slice(0, -1), old.correction_evidence);
    if (q.correction_evidence.at(-1)?.unit_id !== current.id) fail();
  } else {
    if (
      !["pending", "partially_satisfied", "contradicted"].includes(
        old.status,
      ) ||
      !["partially_satisfied", "satisfied"].includes(q.status) ||
      !q.evidence.some((p) => p.unit_id === current.id) ||
      old.evidence.some((p) => !q.evidence.some((n) => equal(p, n))) ||
      (q.status === "satisfied" && q.focus !== "parked")
    )
      fail();
    requireEqual(q.withdrawn_evidence, old.withdrawn_evidence);
    requireEqual(q.correction_evidence, old.correction_evidence);
  }
}

/** Validate both ledgers in isolation, then commit together. No event escapes a failed window. */
export function validateSituationStep(
  value: unknown,
  prefix: readonly Unit[],
  ledger: SituationLedger,
): SituationStep {
  const parsed = situationStepSchema.safeParse(value);
  if (!parsed.success) return fail();
  const step = parsed.data,
    current = prefix.at(-1);
  if (
    ledger.complete ||
    ledger.focus.complete ||
    !current ||
    prefix.length !== ledger.steps.length + 1 ||
    prefix.length > ledger.source_units.length ||
    step.at_unit_id !== current.id ||
    step.focus.at_unit_id !== current.id
  )
    return fail();
  requireEqual(
    prefix.map(focusSourceUnit),
    ledger.source_units.slice(0, prefix.length),
  );
  const focus = structuredClone(ledger.focus);
  // validateFocusStep mutates only this clone. Later situation rejection cannot leak a question.
  validateFocusStep(step.focus, prefix, focus);
  // Keep step acceptance consistent with the bounded final snapshot.
  if (focus.questions.length > 16) fail();
  const source = new Map(prefix.map((u) => [u.id, u]));
  const entities = new Map(
    ledger.entities.map((e) => [e.id, structuredClone(e)]),
  );
  const expectations = new Map(
    ledger.expectations.map((q) => [q.id, structuredClone(q)]),
  );
  const changed = new Set<string>();
  const revisits = new Map<
    string,
    Extract<SituationEvent, { type: "source_revisit" }>
  >();
  let creations = 0;
  for (const event of step.events) {
    if (
      event.at_unit_id !== current.id ||
      (creations > 0 && event.type !== "attention_created")
    )
      fail();
    if (event.type === "source_revisit") {
      const q = expectations.get(event.expectation_id);
      if (
        !q ||
        changed.has(q.id) ||
        revisits.has(q.id) ||
        !unique(event.target_unit_ids) ||
        !event.target_unit_ids.includes(q.origin_unit_id) ||
        event.target_unit_ids.some(
          (target) =>
            !source.has(target) || source.get(target)!.order >= current.order,
        )
      )
        fail();
      revisits.set(event.expectation_id, event);
      continue;
    }
    const qid =
      event.type === "expectation_parked"
        ? event.expectation_id
        : event.expectation.id;
    if (changed.has(qid)) fail();
    changed.add(qid);
    if (event.type === "expectation_parked") {
      const q = expectations.get(qid);
      if (
        !q ||
        q.focus !== "active" ||
        !["pending", "partially_satisfied"].includes(q.status) ||
        revisits.has(qid) ||
        event.previous_version !== q.state_version ||
        event.state_version !== q.state_version + 1
      )
        fail();
      expectations.set(qid, {
        ...q!,
        focus: "parked",
        state_version: event.state_version,
      });
    } else {
      const q = event.expectation;
      checkExpectation(q, source);
      if (event.type === "attention_created") {
        creations++;
        if (
          creations > 3 ||
          expectations.has(q.id) ||
          q.origin_unit_id !== current.id ||
          q.status !== "pending" ||
          q.state_version !== 1 ||
          q.evidence.length ||
          q.withdrawn_evidence.length ||
          q.correction_evidence.length ||
          q.entity_ids[0] !== event.entity.id ||
          [...expectations.values()].some(
            (old) =>
              old.origin_unit_id === q.origin_unit_id &&
              old.kind === q.kind &&
              equal(old.entity_ids, q.entity_ids),
          )
        )
          fail();
        const entity = event.entity,
          oldEntity = entities.get(entity.id);
        if (oldEntity) {
          // Include updates earlier in this step when checking a reused entity snapshot.
          const derived = deriveEntities(
            [oldEntity],
            [...expectations.values()],
          )[0];
          requireEqual(entity, derived);
        } else {
          checkProofs([entity.origin], source);
          if (
            entity.introduced_at_unit_id !== current.id ||
            entity.origin.unit_id !== current.id ||
            entity.origin.quote !== entity.canonical_name ||
            entity.status !== "noticed" ||
            entity.definition_unit_ids.length ||
            !unique([entity.canonical_name, ...entity.aliases]) ||
            entity.aliases.some((alias) => !current.text.includes(alias))
          )
            fail();
          entities.set(entity.id, entity);
        }
        expectations.set(q.id, q);
      } else {
        const old = expectations.get(q.id),
          revisit = revisits.get(q.id);
        if (
          !old ||
          !revisit ||
          event.previous_status !== old.status ||
          revisit.reason !== reasonFor(q)
        )
          fail();
        requireEqual(event.target_unit_ids, revisit!.target_unit_ids);
        checkUpdate(old!, q, current);
        expectations.set(q.id, q);
        revisits.delete(q.id);
      }
    }
    activeId([...expectations.values()]);
    if (entities.size > 32 || expectations.size > 24) fail();
  }
  if (
    revisits.size ||
    activeId([...expectations.values()]) !== step.active_expectation_id
  )
    fail();
  const nextExpectations = [...expectations.values()];
  const nextEntities = deriveEntities([...entities.values()], nextExpectations);
  ledger.focus = focus;
  ledger.expectations = structuredClone(nextExpectations);
  ledger.entities = structuredClone(nextEntities);
  ledger.steps.push(structuredClone(step));
  return step;
}

/** Finish cannot create evidence or reinterpret a missing link as a document deficiency. */
export function validateSituationFinish(
  value: unknown,
  ledger: SituationLedger,
): SituationFinish {
  const parsed = situationFinishSchema.safeParse(value);
  if (
    !parsed.success ||
    ledger.complete ||
    ledger.focus.complete ||
    ledger.steps.length !== ledger.source_units.length
  )
    return fail();
  const finish = parsed.data;
  if (finish.at_unit_id !== ledger.source_units.at(-1)?.id) fail();
  requireEqual(ledger.focus.units, ledger.source_units);
  const expectations = new Map(
    ledger.expectations.map((q) => [q.id, structuredClone(q)]),
  );
  const pending = new Set(
    ledger.expectations
      .filter(
        (q) => q.status === "pending" || q.status === "partially_satisfied",
      )
      .map((q) => q.id),
  );
  for (const event of finish.final_events) {
    const q = event.expectation,
      old = expectations.get(q.id);
    if (
      event.at_unit_id !== finish.at_unit_id ||
      !old ||
      !pending.delete(q.id) ||
      event.previous_status !== old.status
    )
      fail();
    requireEqual(q, {
      ...old,
      status: "unresolved_at_end",
      focus: "parked",
      state_version: old!.state_version + 1,
    });
    expectations.set(q.id, q);
  }
  if (pending.size) fail();
  const nextExpectations = [...expectations.values()];
  const nextEntities = deriveEntities(ledger.entities, nextExpectations);
  requireEqual(finish.snapshot, {
    entities: nextEntities,
    expectations: nextExpectations,
    questions: ledger.focus.questions,
  });
  ledger.entities = structuredClone(nextEntities);
  ledger.expectations = structuredClone(nextExpectations);
  ledger.final_events = structuredClone(finish.final_events);
  ledger.focus.complete = true;
  ledger.complete = true;
  return finish;
}

/** Shared semantics only: no free-form model prose and no deficiency classification. */
export function projectSituationExpectation(q: SituationExpectation) {
  const definition =
    q.kind === "entity_definition" || q.kind === "reference_resolution";
  switch (q.status) {
    case "pending":
      return {
        state: definition ? "noticed" : "expected",
        code: definition ? "notice_entity" : "expect_detail",
        is_deficiency: false as const,
      };
    case "partially_satisfied":
      return {
        state: "partially_explained",
        code: "partially_explained",
        is_deficiency: false as const,
      };
    case "satisfied":
      return {
        state: "explained",
        code: definition ? "resolved_definition" : "resolved_detail",
        is_deficiency: false as const,
      };
    case "contradicted":
      return {
        state: "contradicted",
        code: "revised_reference",
        is_deficiency: false as const,
      };
    case "unresolved_at_end":
      return {
        state: "unresolved_at_end",
        code: "unresolved_expectation",
        is_deficiency: false as const,
      };
  }
}
