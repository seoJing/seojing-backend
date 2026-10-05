import { z } from "zod";
import type {
  JobPosting,
  Note,
  Question,
  Report,
  ResumeDocument,
} from "./contracts.js";
import type { ReaderMemory } from "./reader.js";
import { LabError } from "./errors.js";

export const groundedReportSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            category: z.enum(["explained", "open", "improve"]),
            observation: z.string().min(1).max(160),
            gap: z.string().max(160),
            suggestion: z.string().max(180),
            evidence: z
              .array(
                z
                  .object({
                    unit_id: z.string(),
                    quote: z.string().min(1).max(400),
                  })
                  .strict(),
              )
              .min(1)
              .max(8),
            note_ids: z.array(z.string()).max(8),
            requirement_ids: z.array(z.string()).max(8),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type GroundedDraft = z.infer<typeof groundedReportSchema>;
export const MAX_REVISION_ITEMS = 5;

/** New reports are a selected editing plan; existing stored reports stay valid. */
export function validateRevisionPlan(value: unknown): void {
  const parsed = groundedReportSchema.safeParse(value);
  if (!parsed.success)
    throw new LabError(
      "engine_output_invalid",
      503,
      "grounded_report_schema_invalid",
    );
  if (parsed.data.items.length > MAX_REVISION_ITEMS)
    throw new LabError(
      "engine_output_invalid",
      503,
      "report_revision_plan_too_long",
    );
  if (
    parsed.data.items.filter((item) => item.category === "explained").length > 2
  )
    throw new LabError(
      "engine_output_invalid",
      503,
      "report_strength_inventory",
    );
  if (
    parsed.data.items.some(
      (item) => item.category !== "explained" && !item.suggestion.trim(),
    )
  )
    throw new LabError(
      "engine_output_invalid",
      503,
      "report_revision_action_missing",
    );
}
export interface RepairPolicy {
  citationIndices: readonly number[];
  deletableIndices: readonly number[];
}
export function citationIdentity(item: GroundedDraft["items"][number]): string {
  return JSON.stringify({
    observation: item.observation,
    evidence: [...new Set(item.evidence.map((e) => JSON.stringify(e)))].sort(),
  });
}
export const groundedRepairSchema = z
  .object({
    repairs: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(11),
            item: groundedReportSchema.shape.items.element.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

/** Constrain generated references without dropping posting context from input. */
export function groundedOutputSchemas(
  document: ResumeDocument,
  job: JobPosting,
  notes: Note[],
) {
  const references = (ids: string[]) =>
    ids.length
      ? z.array(z.enum(ids as [string, ...string[]])).max(8)
      : z.array(z.string()).max(0);
  const retired = new Set(notes.flatMap((n) => n.retracted_note_id ?? []));
  const unitIds = document.units.map((u) => u.id);
  const item = groundedReportSchema.shape.items.element.extend({
    evidence: z
      .array(
        groundedReportSchema.shape.items.element.shape.evidence.element.extend({
          unit_id: unitIds.length
            ? z.enum(unitIds as [string, ...string[]])
            : z.string(),
        }),
      )
      .min(1)
      .max(unitIds.length ? 8 : 0),
    note_ids: references(
      notes.filter((n) => !retired.has(n.id)).map((n) => n.id),
    ),
    requirement_ids: references(
      job.requirements.filter((r) => r.kind !== "other").map((r) => r.id),
    ),
  });
  return {
    report: groundedReportSchema.extend({
      items: z.array(item).max(MAX_REVISION_ITEMS),
    }),
    repair: groundedRepairSchema.extend({
      repairs: z
        .array(
          groundedRepairSchema.shape.repairs.element.extend({
            item: item.nullable(),
          }),
        )
        .min(1)
        .max(12),
    }),
  };
}

/** Apply only requested repairs; the model cannot rewrite approved neighbors. */
export function mergeGroundedRepairs(
  value: unknown,
  original: GroundedDraft,
  indices: readonly number[],
  policy?: RepairPolicy,
): GroundedDraft {
  const parsed = groundedRepairSchema.safeParse(value);
  const requested = new Set(indices);
  if (
    !parsed.success ||
    !requested.size ||
    requested.size !== indices.length ||
    indices.some(
      (i) => !Number.isInteger(i) || i < 0 || i >= original.items.length,
    ) ||
    parsed.data.repairs.length !== requested.size ||
    new Set(parsed.data.repairs.map((r) => r.index)).size !== requested.size ||
    parsed.data.repairs.some((r) => !requested.has(r.index))
  )
    throw new LabError(
      "engine_output_invalid",
      503,
      "report_repair_indices_invalid",
    );
  const changes = new Map(parsed.data.repairs.map((r) => [r.index, r.item]));
  if (policy)
    for (const [index, item] of changes) {
      if (item === null && !policy.deletableIndices.includes(index))
        throw new LabError(
          "engine_output_invalid",
          503,
          "report_unique_item_deleted",
        );
      if (
        item !== null &&
        (policy.citationIndices.includes(index)
          ? citationIdentity(item) === citationIdentity(original.items[index]!)
          : JSON.stringify(item) === JSON.stringify(original.items[index]!))
      )
        throw new LabError(
          "engine_output_invalid",
          503,
          "report_repair_unchanged",
        );
    }
  const items = original.items.flatMap((item, index) => {
    const replacement = changes.has(index) ? changes.get(index)! : item;
    return replacement === null ? [] : [structuredClone(replacement)];
  });
  if (!items.length)
    throw new LabError("engine_output_invalid", 503, "report_repair_empty");
  return { items };
}

export const entailmentSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(11),
            supported: z.boolean(),
            issue: z.enum([
              "none",
              "actor",
              "time",
              "scope",
              "quantity",
              "causality",
              "unsupported_absence",
              "question_state",
              "requirement",
              "duplicate",
              "other",
            ]),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export function failedEntailment(value: unknown, count: number): number[] {
  const checked = entailmentSchema.safeParse(value);
  if (
    !checked.success ||
    checked.data.checks.length !== count ||
    new Set(checked.data.checks.map((c) => c.index)).size !== count ||
    checked.data.checks.some((c) => c.index >= count)
  )
    throw new LabError("engine_output_invalid", 503, "report_audit_incomplete");
  return checked.data.checks
    .filter((c) => !c.supported || c.issue !== "none")
    .map((c) => c.index);
}

export const citationAuditSchema = entailmentSchema.extend({
  checks: z
    .array(
      entailmentSchema.shape.checks.element.extend({
        unsupported_claims: z
          .array(
            z
              .object({
                claim: z.string().min(1).max(160),
                reason: z.string().min(1).max(240),
              })
              .strict(),
          )
          .max(8),
      }),
    )
    .length(1),
});

export function citationRejected(value: unknown, observation: string): boolean {
  const parsed = citationAuditSchema.safeParse(value);
  if (!parsed.success || parsed.data.checks[0]!.index !== 0)
    throw new LabError(
      "engine_output_invalid",
      503,
      "report_citation_audit_invalid",
    );
  const check = parsed.data.checks[0]!;
  const rejected = !check.supported || check.issue !== "none";
  if (
    rejected !== Boolean(check.unsupported_claims.length) ||
    check.unsupported_claims.some(
      (c) =>
        !c.claim.trim() || !c.reason.trim() || !observation.includes(c.claim),
    )
  )
    throw new LabError(
      "engine_output_invalid",
      503,
      "report_citation_audit_unexplained",
    );
  return rejected;
}

export function reportInput(
  document: ResumeDocument,
  job: JobPosting,
  notes: Note[],
  questions: Question[],
  memory?: ReaderMemory,
) {
  if (
    memory &&
    (memory.units.length !== document.units.length ||
      memory.units.some(
        (u, i) => JSON.stringify(u) !== JSON.stringify(document.units[i]),
      ))
  )
    throw new LabError("reader_not_complete", 503);
  return {
    requirements: job.requirements,
    reader_profile: job.reader_profile ?? null,
    // Include every processed source unit, including units with no public card.
    units: document.units.map(({ id, text, scope_id, order }) => ({
      id,
      text,
      scope_id,
      order,
    })),
    notes: notes.map(
      ({
        id,
        unit_id,
        kind,
        text,
        evidence_unit_ids,
        requirement_ids,
        question_id,
        retracted_note_id,
      }) => ({
        id,
        unit_id,
        kind,
        text,
        evidence_unit_ids,
        requirement_ids,
        ...(question_id ? { question_id } : {}),
        ...(retracted_note_id ? { retracted_note_id } : {}),
      }),
    ),
    questions,
    note_retractions:
      memory?.note_retractions ??
      notes
        .filter((n) => n.retracted_note_id)
        .map((n) => ({ note_id: n.retracted_note_id!, at_unit_id: n.unit_id })),
    observations: memory?.observations ?? [],
    context_reviews: memory?.context_reviews ?? [],
    transitions: (memory?.transitions ?? []).map(
      ({
        question_id,
        previous_status,
        status,
        evidence_unit_ids,
        state_version,
        at_unit_id,
      }) => ({
        question_id,
        previous_status,
        status,
        evidence_unit_ids,
        state_version,
        at_unit_id,
      }),
    ),
    limitation: `${memory?.engine === "jev" ? "The ledger was generated by prefix-only remote Jev with optional bounded Codex role-context confirmation. Posting-derived role, method, result and applicable comparison checks and job-linked explanation notes are bounded and uncalibrated; silence does not establish sufficient explanation or missing ability." : memory?.engine === "codex_cli" ? "The ledger was generated by prefix-only Codex CLI reading." : "Laya observations are uncalibrated candidates."} These are source-grounded reading observations, never actual recruiter thoughts. Retracted evidence notes are historical only, never current support. A failed context_review means the optional check could not be completed, never that the document lacks an answer. Reassess source directly for the report without rewriting historical states. Scope IDs are structural boundaries, not proof of the same experience.`,
  };
}

export function validateGroundedReport(
  value: unknown,
  document: ResumeDocument,
  job: JobPosting,
  notes: Note[],
  questions: Question[],
  readingEngine: ReaderMemory["engine"] = "laya",
  contextReviews: NonNullable<ReaderMemory["context_reviews"]> = [],
): Report {
  const parsed = groundedReportSchema.safeParse(value);
  if (!parsed.success)
    throw new LabError(
      "engine_output_invalid",
      503,
      "grounded_report_schema_invalid",
    );
  const items = parsed.data.items.map((item, i) => {
    // Do not silently truncate a claim to the schema limit or patch punctuation
    // onto an unfinished model sentence. Ask the writer to shorten/rewrite it.
    const unfinished = (["observation", "gap", "suggestion"] as const).filter(
      (field) =>
        item[field].trim() &&
        !/[.!?。！？][”’"')\]]?$/u.test(item[field].trim()),
    );
    if (unfinished.length)
      throw new LabError(
        "engine_output_invalid",
        503,
        "report_sentence_unfinished",
        {
          item_index: i,
          fields: unfinished,
        },
      );
    const copy = [item.observation, item.gap, item.suggestion].join(" ");
    if (
      /\b(?:[qnur]\d+|note_ids|requirement_ids|open_at_end|held|resolved|reopened)\b/u.test(
        copy,
      )
    )
      throw new LabError("engine_output_invalid", 503, "report_internal_copy");
    if (
      new Set(item.requirement_ids).size !== item.requirement_ids.length ||
      item.requirement_ids.some(
        (id) =>
          !job.requirements.some((r) => r.id === id && r.kind !== "other"),
      ) ||
      new Set(item.note_ids).size !== item.note_ids.length ||
      item.note_ids.some(
        (id) =>
          !notes.some((n) => n.id === id) ||
          notes.some((n) => n.retracted_note_id === id),
      )
    )
      throw new LabError(
        "engine_output_invalid",
        503,
        "grounded_report_reference_invalid",
      );
    const citations = item.evidence.map((evidence) => {
      const unit = document.units.find((u) => u.id === evidence.unit_id);
      const offset = unit?.text.indexOf(evidence.quote) ?? -1;
      if (!unit || offset < 0)
        throw new LabError(
          "engine_output_invalid",
          503,
          "report_quote_invalid",
        );
      return {
        unit_id: unit.id,
        block_id: unit.block_id,
        start: unit.start + offset,
        end: unit.start + offset + evidence.quote.length,
      };
    });
    // Notes are optional for the explicit final source check. If supplied they
    // must actually concern at least one cited passage, not just a valid ID.
    const unlinkedNotes = item.note_ids.filter(
      (id) =>
        !notes
          .find((n) => n.id === id)!
          .evidence_unit_ids.some((u) =>
            citations.some((c) => c.unit_id === u),
          ),
    );
    if (unlinkedNotes.length)
      throw new LabError(
        "engine_output_invalid",
        503,
        "report_note_quote_unlinked",
        {
          item_index: i,
          unlinked_notes: unlinkedNotes.map((id) => ({
            note_id: id,
            required_unit_ids: notes.find((n) => n.id === id)!
              .evidence_unit_ids,
          })),
        },
      );
    const linkedUnconfirmedQuestion =
      item.category === "explained" &&
      item.note_ids.some((id) => {
        const note = notes.find((n) => n.id === id);
        return (
          note?.kind === "question" &&
          questions.some(
            (q) => q.id === note.question_id && q.status !== "resolved",
          )
        );
      });
    return {
      id: `report${i + 1}`,
      category: item.category,
      text: [item.observation, item.gap].filter(Boolean).join(" "),
      reason: [
        ...(linkedUnconfirmedQuestion
          ? [
              "이 항목은 전체 문서를 검토해 확인한 설명입니다. 연결된 메모에는 읽는 중 확정하지 못한 질문이 남아 있습니다.",
            ]
          : []),
        item.suggestion || "연결된 원문에서 서술의 범위를 확인할 수 있습니다.",
      ].join(" "),
      note_ids: item.note_ids,
      requirement_ids: item.requirement_ids,
      citations,
    };
  });
  return {
    items,
    questions: questions.map((q) => ({
      ...structuredClone(q),
      status: q.status === "open" ? "open_at_end" : q.status,
    })),
    limitations: [
      ...document.warnings,
      ...job.warnings,
      "질문 상태는 읽는 동안 남긴 기록입니다. 다 읽은 뒤 원문에서 설명을 찾더라도 이전 기록을 바꾸지는 않습니다.",
      ...(readingEngine === "jev"
        ? [
            "읽는 동안 공고에서 만든 기준에 따라 역할·수행 방식·결과와 필요한 비교 근거를 살폈습니다. 연결한 설명과 남은 질문은 문서에 근거한 독해 기록이며 실제 채용 담당자의 생각이나 모든 요건의 충족 판정이 아닙니다.",
            `읽는 동안의 판단은 Typesafe의 Jev 모델로 처리했습니다.${contextReviews.length ? " 일부 역할의 문맥 연결은 Codex로 추가 확인했습니다." : ""} 판단 정확도는 검증 중이며, ‘유지할 설명’은 문서 안에서 설명을 찾았다는 뜻이지 경험의 진위를 인증한 결과가 아닙니다.`,
            ...(contextReviews.some((r) => r.outcome === "failed")
              ? [
                  "일부 역할의 추가 문맥 확인을 완료하지 못했습니다. 이는 문서에 설명이 없다는 뜻이 아니며, 연결된 원문을 함께 확인해 주세요.",
                ]
              : []),
            "공고 기준과 추출된 이력서 전체의 최종 점검은 OpenAI Codex의 클라우드 모델로 처리했습니다. 모든 피드백은 사람이 다시 확인해야 합니다.",
          ]
        : readingEngine === "codex_cli"
          ? [
              "순차 독해와 의미 검토는 Codex CLI의 모델 판단이며 오류가 남을 수 있습니다. 설명됨은 문서에 적힌 내용이며 경험의 진위나 채용 가능성을 인증하지 않습니다.",
              "공고 기준, 추출된 원문 전체의 순차 독해와 최종 점검은 ChatGPT 로그인 Codex CLI를 통해 클라우드에서 처리했습니다.",
            ]
          : [
              "Laya 기본 모델의 이력서 판단 정확도·확률 보정은 검증 전입니다. 설명됨은 문서에 적힌 내용이며 경험의 진위나 채용 가능성을 인증하지 않습니다.",
              "공고 기준과 최종 원문 점검은 ChatGPT 로그인 Codex CLI를 통해 클라우드에서 처리했습니다. 의미 검토 역시 모델 판단이므로 오류가 남을 수 있습니다.",
            ]),
    ],
  };
}
