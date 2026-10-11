import {
  situationEntitySchema,
  situationExpectationSchema,
  type SituationEntity,
  type SituationExpectation,
  type SituationEvent,
  type SituationFinish,
} from "./situation-contract.js";

export const publicSituationExpectationSchema = situationExpectationSchema
  .omit({ prompt: true, sufficient: true })
  .strict();
export type PublicSituationExpectation = Omit<
  SituationExpectation,
  "prompt" | "sufficient"
>;
type WithPublicExpectation<T> = T extends { expectation: SituationExpectation }
  ? Omit<T, "expectation"> & { expectation: PublicSituationExpectation }
  : T;
export type PublicSituationEvent = WithPublicExpectation<
  SituationEvent | SituationFinish["final_events"][number]
>;
export function publicSituationExpectation(
  q: SituationExpectation,
): PublicSituationExpectation {
  // Build an explicit allowlist; do not copy unknown worker extensions.
  return publicSituationExpectationSchema.parse({
    id: q.id,
    kind: q.kind,
    origin_unit_id: q.origin_unit_id,
    origin: q.origin,
    context_id: q.context_id,
    entity_ids: q.entity_ids,
    status: q.status,
    evidence: q.evidence,
    withdrawn_evidence: q.withdrawn_evidence,
    correction_evidence: q.correction_evidence,
    state_version: q.state_version,
    focus: q.focus,
  });
}
export function publicSituationEvent(
  event: SituationEvent | SituationFinish["final_events"][number],
): PublicSituationEvent {
  switch (event.type) {
    case "attention_created":
      return {
        type: event.type,
        at_unit_id: event.at_unit_id,
        entity: situationEntitySchema.parse(event.entity),
        expectation: publicSituationExpectation(event.expectation),
      };
    case "expectation_updated":
      return {
        type: event.type,
        at_unit_id: event.at_unit_id,
        previous_status: event.previous_status,
        expectation: publicSituationExpectation(event.expectation),
        target_unit_ids: [...event.target_unit_ids],
      };
    case "expectation_finished":
      return {
        type: event.type,
        at_unit_id: event.at_unit_id,
        previous_status: event.previous_status,
        expectation: publicSituationExpectation(event.expectation),
      };
    case "expectation_parked":
      return {
        type: event.type,
        at_unit_id: event.at_unit_id,
        expectation_id: event.expectation_id,
        previous_version: event.previous_version,
        state_version: event.state_version,
      };
    case "source_revisit":
      return {
        type: event.type,
        at_unit_id: event.at_unit_id,
        expectation_id: event.expectation_id,
        reason: event.reason,
        target_unit_ids: [...event.target_unit_ids],
      };
  }
}
export interface SituationReportMemory {
  version: "situation-reader-v1";
  entities: SituationEntity[];
  expectations: PublicSituationExpectation[];
  is_deficiency: false;
}
