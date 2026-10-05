import { z } from "zod";
import { LabError } from "./errors.js";
import { semanticInput, type SemanticInput } from "./semantic-reader.js";

const ids = z.array(z.string()).max(6);
export const roleContextSchema = z
  .object({
    verdict: z.enum(["complete", "unknown"]),
    task: z.string().max(160),
    actor: z.enum(["applicant", "unclear"]),
    modality: z.enum(["performed", "planned", "unclear"]),
    task_unit_ids: ids,
    performance_unit_ids: ids,
    evidence: z
      .array(
        z
          .object({ unit_id: z.string(), quote: z.string().min(1).max(400) })
          .strict(),
      )
      .max(6),
  })
  .strict();
export type RoleContext = z.infer<typeof roleContextSchema>;
export type RoleReassessor = (
  input: SemanticInput,
  questionId: string,
  signal: AbortSignal,
) => Promise<RoleContext | null>;
export const roleContextAuditSchema = z
  .object({
    same_experience: z.boolean(),
    same_task: z.boolean(),
    applicant_performed: z.boolean(),
    not_retracted: z.boolean(),
    evidence_sufficient: z.boolean(),
    issues: z.array(z.string().min(1).max(180)).max(6),
  })
  .strict();

/** Exact proof remains usable by the Python adopted-evidence audit. */
export function validateRoleContext(
  value: unknown,
  input: SemanticInput,
  questionId: string,
): RoleContext | null {
  semanticInput(input);
  const question = input.questions.find((q) => q.id === questionId);
  if (
    !question ||
    question.facet !== "role" ||
    !["open", "held", "partial", "reopened"].includes(question.status)
  )
    throw new LabError("reader_state_invalid");
  const parsed = roleContextSchema.safeParse(value);
  if (!parsed.success)
    throw new LabError(
      "engine_output_invalid",
      503,
      "role_context_schema_invalid",
    );
  const result = parsed.data;
  if (result.verdict === "unknown") return null;
  const evidenceIds = new Set(result.evidence.map((e) => e.unit_id));
  if (
    result.actor !== "applicant" ||
    result.modality !== "performed" ||
    !result.task.trim() ||
    !result.task_unit_ids.length ||
    !result.performance_unit_ids.length ||
    !evidenceIds.has(input.prefix.at(-1)!.id) ||
    evidenceIds.size !== result.evidence.length ||
    [...result.task_unit_ids, ...result.performance_unit_ids].some(
      (id) => !evidenceIds.has(id),
    ) ||
    result.evidence.some(
      (e) => input.prefix.find((u) => u.id === e.unit_id)?.text !== e.quote,
    ) ||
    new Set([question.unit_id, ...evidenceIds]).size > 6 ||
    input.prefix.find((u) => u.id === question.unit_id)!.text.length > 400
  )
    throw new LabError(
      "engine_output_invalid",
      503,
      "role_context_proof_invalid",
    );
  return result;
}
