import type {
  EventPayload,
  Facet,
  JobPosting,
  Note,
  Question,
  ReaderCheck,
  Unit,
} from "./contracts.js";
import type { Classifier, Decision, DecisionKind } from "./laya.js";
import { LabError } from "./errors.js";
import type { ContextReview } from "./jev.js";
import type { FocusLedger } from "./focus-contract.js";

export const facetLabels: Record<Facet, string> = {
  role: "본인 역할",
  method: "행동과 방법",
  result: "결과",
  basis: "비교·측정 근거",
};
const facets: Facet[] = ["role", "method", "result", "basis"];
const excerpt = (text: string) =>
  `“${Array.from(text.trim()).slice(0, 64).join("")}${Array.from(text.trim()).length > 64 ? "…" : ""}”`;
export interface ReadingObservation {
  unit_id: string;
  facts: Decision;
  requirement_ids: string[];
  context_limited: boolean;
}
export interface ReaderMemory {
  engine: "laya" | "codex_cli" | "jev";
  profile_id: string;
  units: Unit[];
  observations: ReadingObservation[];
  transitions: Extract<EventPayload, { type: "question_updated" }>[];
  /** Private deduplication only; original public notes remain immutable. */
  note_retractions?: { note_id: string; at_unit_id: string }[];
  /** Private provenance; failed optional checks are not evidence of absence. */
  context_reviews?: ContextReview[];
  /** New opt-in inquiry ledger, independent of posting criteria. */
  focus?: Pick<FocusLedger, "version" | "questions">;
}
export interface TransitionCandidate {
  question: Question;
  check: ReaderCheck;
  prefix: readonly Unit[];
  current: Unit;
  relation: "complete" | "partial" | "conflict";
}
// A separate verifier is injectable for evaluation. The base checkpoint is never
// authorized to resolve a question merely by selecting answers with a high score.
export type TransitionVerifier = (candidate: TransitionCandidate) => Promise<{
  verdict: "complete" | "partial" | "conflict" | "unrelated" | "unknown";
  evidence_unit_ids: string[];
}>;
export function createMemory(
  job: JobPosting,
  engine: ReaderMemory["engine"] = "laya",
): ReaderMemory {
  if (!job.reader_profile) throw new LabError("reader_profile_missing");
  return {
    engine,
    profile_id: job.reader_profile.id,
    units: [],
    observations: [],
    transitions: [],
  };
}
export function finishReading(
  memory: ReaderMemory,
  questions: Question[],
  emit: (event: EventPayload) => void,
): void {
  const last = memory.units.at(-1);
  if (!last) throw new LabError("reader_not_complete");
  for (const question of questions) {
    if (question.status !== "open") continue;
    question.status = "open_at_end";
    question.state_version = (question.state_version ?? 0) + 1;
    const event: Extract<EventPayload, { type: "question_updated" }> = {
      type: "question_updated",
      question_id: question.id,
      previous_status: "open",
      status: "open_at_end",
      evidence_unit_ids: [...(question.evidence_unit_ids ?? [])],
      at_unit_id: last.id,
      state_version: question.state_version,
      question: structuredClone(question),
    };
    memory.transitions.push(structuredClone(event));
    emit(event);
  }
}
function select(result: Decision, key: string, labels: string[]): string {
  const answer = result[key];
  if (
    !answer ||
    !labels.includes(answer.label) ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  )
    throw new LabError("engine_output_invalid", 503);
  return answer.confidence >= 0.75 ? answer.label : "unknown";
}

export async function readPrefix(
  prefix: readonly Unit[],
  job: JobPosting,
  classifier: Classifier,
  memory: ReaderMemory,
  notes: Note[],
  questions: Question[],
  emit: (event: EventPayload) => void,
  verify?: TransitionVerifier,
): Promise<void> {
  const current = prefix.at(-1);
  if (
    !current ||
    !job.reader_profile ||
    memory.engine !== "laya" ||
    job.reader_profile.id !== memory.profile_id ||
    prefix.length !== memory.units.length + 1 ||
    prefix.some(
      (u, i) =>
        u.order !== i ||
        (i < memory.units.length &&
          JSON.stringify(u) !== JSON.stringify(memory.units[i])),
    )
  )
    throw new LabError("reader_prefix_invalid");
  memory.units.push(structuredClone(current));
  const note = (
    kind: Note["kind"],
    text: string,
    ids: string[],
    evidence: string[],
    question?: Question,
  ) => {
    if (kind === "evidence" && !ids.length) return;
    if (evidence.some((id) => !prefix.some((u) => u.id === id)))
      throw new LabError("engine_output_invalid", 503);
    const item: Note = {
      id: `n${notes.length + 1}`,
      kind,
      text,
      unit_id: current.id,
      span: {
        block_id: current.block_id,
        start: current.start,
        end: current.end,
      },
      evidence_unit_ids: [...new Set(evidence)],
      requirement_ids: ids,
      review_required: true,
      ...(question ? { question_id: question.id } : {}),
    };
    notes.push(item);
    emit({ type: "note", note: structuredClone(item) });
  };
  const update = (question: Question, previous: Question["status"] | null) => {
    question.state_version = (question.state_version ?? 0) + 1;
    const event: Extract<EventPayload, { type: "question_updated" }> = {
      type: "question_updated",
      question_id: question.id,
      previous_status: previous,
      status: question.status,
      at_unit_id: current.id,
      state_version: question.state_version,
      evidence_unit_ids: [...(question.evidence_unit_ids ?? [])],
      question: structuredClone(question),
    };
    memory.transitions.push(structuredClone(event));
    emit(event);
  };
  let budgetLimited = false;
  const predict = async (
    kind: DecisionKind,
    state: unknown,
  ): Promise<Decision | null> => {
    try {
      return await classifier.predict(kind, state);
    } catch (error) {
      if (
        !(error instanceof LabError) ||
        error.code !== "context_budget_exceeded"
      )
        throw error;
      budgetLimited = true;
      return null;
    }
  };
  const sameScope = prefix
    .slice(0, -1)
    .filter((u) => u.scope_id === current.scope_id);
  // Keep older explanatory candidates as well as recent context. Raw units are
  // always retained independently; context omission never means missing ability.
  const priorEvidence = memory.observations
    .filter((o) =>
      facets.some(
        (f) => o.facts[f]?.label === "present" && o.facts[f].confidence >= 0.75,
      ),
    )
    .map((o) => sameScope.find((u) => u.id === o.unit_id))
    .filter((u): u is Unit => Boolean(u));
  const compact = [
    ...new Map(
      [...priorEvidence.slice(-3), ...sameScope.slice(-3)].map((u) => [
        u.id,
        u,
      ]),
    ).values(),
  ].sort((a, b) => a.order - b.order);
  let selected = sameScope;
  let contextLimited = false;
  let facts = await predict("reader_unit", {
    current: current.text,
    previous: selected.map((u) => ({ id: u.id, text: u.text })),
    context_limited: contextLimited,
  });
  if (!facts) {
    selected = compact;
    contextLimited = true;
    facts = await predict("reader_unit", {
      current: current.text,
      previous: selected.map((u) => ({ id: u.id, text: u.text })),
      context_limited: true,
    });
  }
  const statuses = Object.fromEntries(
    facets.map((facet) => [
      facet,
      facts
        ? select(facts, facet, ["present", "missing", "irrelevant", "unknown"])
        : "unknown",
    ]),
  );
  const actor = facts
    ? select(facts, "actor", ["self", "team", "other", "unknown"])
    : "unknown";
  const actuality = facts
    ? select(facts, "actuality", [
        "performed",
        "planned",
        "negated",
        "context",
        "unknown",
      ])
    : "unknown";
  const related: string[] = [];
  const mentioned: string[] = [];
  for (const criterion of job.reader_profile.criteria) {
    const requirement = job.requirements.find(
      (r) => r.id === criterion.requirement_id,
    )!;
    const result = await predict("relevance", {
      current: current.text,
      requirement: requirement.quote,
    });
    const relevance = result
      ? select(result, "relevance", ["supports", "mentions", "unrelated"])
      : "unknown";
    if (
      relevance === "supports" &&
      actor === "self" &&
      actuality === "performed"
    )
      related.push(requirement.id);
    if (["supports", "mentions"].includes(relevance))
      mentioned.push(requirement.id);
  }
  const observation: ReadingObservation = {
    unit_id: current.id,
    facts: facts ?? {},
    requirement_ids: related,
    context_limited: contextLimited || budgetLimited,
  };
  memory.observations.push(observation);

  // Check every question/current-unit pair. Rotating a subset would permanently
  // miss an answer that appears only once. Eight criteria × four facets bound this.
  const prior = questions.filter((q) => q.scope_id === current.scope_id);
  if (prior.length > 32) throw new LabError("reader_state_invalid");
  for (const question of prior) {
    const criterion = job.reader_profile.criteria.find(
      (c) => c.id === question.criterion_id,
    );
    const check = criterion?.checks.find((c) => c.facet === question.facet);
    const origin = prefix.find((u) => u.id === question.unit_id);
    if (!criterion || !check || !origin)
      throw new LabError("reader_state_invalid");
    const result = await predict("reader_relation", {
      question: question.text,
      sufficient: check.sufficient,
      insufficient: check.insufficient,
      original: origin.text,
      current: current.text,
      evidence: (question.evidence_unit_ids ?? [])
        .map((id) => prefix.find((u) => u.id === id)!)
        .filter(Boolean)
        .slice(-2)
        .map((u) => u.text),
    });
    if (!result) continue;
    const scope = select(result, "scope", ["same", "different", "unknown"]);
    const relation = select(result, "relation", [
      "complete",
      "partial",
      "conflict",
      "unrelated",
      "unknown",
    ]);
    if (
      scope !== "same" ||
      !["complete", "partial", "conflict"].includes(relation)
    )
      continue;
    const candidate = relation as TransitionCandidate["relation"];
    let status: Question["status"] = "held";
    let evidence = [current.id];
    if (verify) {
      const verdict = await verify({
        question: structuredClone(question),
        check,
        prefix: structuredClone(prefix),
        current: structuredClone(current),
        relation: candidate,
      });
      if (["unknown", "unrelated"].includes(verdict.verdict)) continue;
      evidence = [...new Set(verdict.evidence_unit_ids)];
      if (
        !evidence.length ||
        !evidence.includes(current.id) ||
        evidence.some(
          (id) =>
            !prefix.some(
              (u) => u.id === id && u.scope_id === question.scope_id,
            ),
        )
      )
        throw new LabError("reader_verifier_reference_invalid", 503);
      status =
        verdict.verdict === "complete"
          ? "resolved"
          : verdict.verdict === "partial"
            ? "partial"
            : "reopened";
      // A partial follow-up does not erase a previous complete explanation.
      if (
        ["resolved", "reopened"].includes(question.status) &&
        status === "partial"
      )
        continue;
    } else if (question.status === "resolved") {
      continue;
    }
    const previous = question.status;
    question.status = status;
    question.candidate_unit_ids = [
      ...new Set([...question.candidate_unit_ids, current.id]),
    ];
    if (verify)
      question.evidence_unit_ids = [
        ...new Set([...(question.evidence_unit_ids ?? []), ...evidence]),
      ];
    update(question, previous);
    const wording =
      status === "resolved"
        ? "앞선 질문에 필요한 설명을 찾았습니다"
        : status === "partial"
          ? "앞선 질문에 일부 설명이 더해졌습니다"
          : status === "reopened"
            ? "앞선 설명과 충돌해 질문을 다시 확인합니다"
            : "앞선 질문에 연결될 설명 후보입니다. 해소 여부는 아직 확인하지 못했습니다";
    note(
      status === "resolved" ? "resolves" : "hold",
      `${excerpt(current.text)} — ${wording}.`,
      [criterion.requirement_id],
      [question.unit_id, ...evidence],
      question,
    );
  }
  if (!contextLimited && !budgetLimited && actuality === "performed") {
    outer: for (const criterion of job.reader_profile.criteria.filter((c) =>
      mentioned.includes(c.requirement_id),
    )) {
      for (const check of criterion.checks) {
        if (
          statuses[check.facet] !== "missing" ||
          questions.some(
            (q) =>
              q.scope_id === current.scope_id &&
              q.criterion_id === criterion.id &&
              q.facet === check.facet,
          )
        )
          continue;
        const triggered = await predict("reader_check", {
          current: current.text,
          previous: selected.map((u) => u.text),
          check,
        });
        if (
          !triggered ||
          select(triggered, "check", [
            "needed",
            "explained",
            "irrelevant",
            "unknown",
          ]) !== "needed"
        )
          continue;
        const question: Question = {
          id: `q${questions.length + 1}`,
          unit_id: current.id,
          scope_id: current.scope_id,
          label: `${criterion.label.slice(0, 36)} · ${facetLabels[check.facet]}`,
          text: `${excerpt(current.text)} — ${facetLabels[check.facet]}에 어떤 설명이 있는지 확인하고 싶습니다.`,
          facet: check.facet,
          criterion_id: criterion.id,
          status: "open",
          candidate_unit_ids: [],
          evidence_unit_ids: [],
          state_version: 0,
        };
        questions.push(question);
        update(question, null);
        note(
          "question",
          question.text,
          [criterion.requirement_id],
          [current.id],
          question,
        );
        break outer;
      }
    }
  }
  if (related.length && !notes.some((n) => n.unit_id === current.id))
    note(
      "evidence",
      `${excerpt(current.text)} — 공고의 ${job.requirements
        .filter((r) => related.includes(r.id))
        .map((r) => `‘${r.label}’`)
        .join(", ")}에 연결되는 행동 후보입니다.`,
      related,
      [current.id],
    );
  observation.context_limited ||= budgetLimited;
}
