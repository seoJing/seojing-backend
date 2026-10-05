import type {
  EventPayload,
  JobPosting,
  Note,
  Question,
  Unit,
} from "./contracts.js";
import type { Classifier, Decision } from "./laya.js";
import { LabError } from "./errors.js";

const prompts = {
  role: "이 경험에서 본인이 맡은 역할은 무엇인가요?",
  method: "어떤 행동과 방법으로 기여했나요?",
  basis: "이 성과의 비교 기준과 측정 근거는 무엇인가요?",
};
function excerpt(text: string): string {
  const chars = Array.from(text);
  return `“${chars.slice(0, 72).join("")}${chars.length > 72 ? "…" : ""}”`;
}
function answer(result: Decision, key: string, labels: string[]): string {
  const value = result[key];
  if (!value || !labels.includes(value.label))
    throw new LabError("engine_output_invalid", 503);
  // A gate limits weak outputs, but its probability is not a calibrated accuracy.
  return value.confidence >= 0.65 ? value.label : "uncertain";
}

// This interface cannot receive future units. The orchestrator passes a prefix.
export async function judgePrefix(
  prefix: readonly Unit[],
  job: JobPosting,
  classifier: Classifier,
  notes: Note[],
  questions: Question[],
  emit: (event: EventPayload) => void,
): Promise<void> {
  const current = prefix.at(-1);
  if (!current) throw new LabError("engine_input_invalid");
  const note = (
    kind: Note["kind"],
    text: string,
    extra: Partial<
      Pick<Note, "question_id" | "evidence_unit_ids" | "requirement_ids">
    > = {},
  ) => {
    const value: Note = {
      id: `n${notes.length + 1}`,
      unit_id: current.id,
      span: {
        block_id: current.block_id,
        start: current.start,
        end: current.end,
      },
      kind,
      text,
      evidence_unit_ids: [current.id],
      requirement_ids: [],
      review_required: true,
      ...extra,
    };
    const read = new Set(prefix.map((u) => u.id));
    if (value.evidence_unit_ids.some((id) => !read.has(id)))
      throw new LabError("engine_output_invalid", 503);
    notes.push(value);
    emit({ type: "note", note: value });
  };
  const state = {
    current: current.text,
    previous: prefix
      .slice(-3, -1)
      .filter((u) => u.scope_id === current.scope_id)
      .map((u) => u.text),
  };
  const result = await classifier.predict("unit", state);
  const signal = answer(result, "signal", [
    "concrete",
    "claim",
    "context",
    "unclear",
  ]);
  const missing = answer(result, "missing", [
    "role",
    "method",
    "basis",
    "none",
  ]);
  const priorQuestions = questions.filter(
    (q) => q.scope_id === current.scope_id,
  );
  const related: string[] = [];
  if (signal === "concrete") {
    // Evaluate links even when a question/answer note replaces the evidence card.
    for (const requirement of job.requirements) {
      const relevance = answer(
        await classifier.predict("relevance", {
          current: current.text,
          requirement: requirement.quote,
        }),
        "relevance",
        ["supports", "mentions", "unrelated"],
      );
      if (relevance === "supports") related.push(requirement.id);
    }
  }
  if (signal === "concrete") {
    const matches: Array<{
      question: Question;
      confidence: number;
      relation: string;
    }> = [];
    for (const prior of priorQuestions) {
      const origin = prefix.find((u) => u.id === prior.unit_id)!;
      const result = await classifier.predict("relation", {
        question: prior.text,
        original: origin.text,
        current: current.text,
      });
      const relation = answer(result, "relation", [
        "answers",
        "partial",
        "unrelated",
        "uncertain",
      ]);
      if (["answers", "partial"].includes(relation))
        matches.push({
          question: prior,
          confidence: result.relation!.confidence,
          relation,
        });
    }
    // Inspect every question, but cap visual connections at two per sentence.
    for (const { question: prior, relation } of matches
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 2)) {
      prior.status = "held";
      prior.candidate_unit_ids.push(current.id);
      note(
        "hold",
        `${excerpt(current.text)} — ${relation === "partial" ? "앞선 질문에 일부 답하는" : "앞선 질문에 답하는"} 설명 후보입니다. 질문: ${prior.text}`,
        {
          question_id: prior.id,
          evidence_unit_ids: [prior.unit_id, current.id],
          requirement_ids: related,
        },
      );
    }
  }
  if (["claim", "concrete", "unclear"].includes(signal) && missing in prompts) {
    const prompt = prompts[missing as keyof typeof prompts];
    const existing = priorQuestions.find((q) => q.text.endsWith(prompt));
    if (existing) {
      // Repeating a question and discovering a new requirement link are distinct.
      // A hold already carries these links; otherwise preserve the new evidence.
      if (
        related.length &&
        !notes.some((n) => n.unit_id === current.id && n.kind === "hold")
      ) {
        note(
          "evidence",
          `${excerpt(current.text)} — 공고의 ${job.requirements
            .filter((r) => related.includes(r.id))
            .map((r) => `‘${r.label}’`)
            .join(
              ", ",
            )} 요건과 연결해 볼 설명입니다. 앞선 질문의 해소 여부는 별도로 남겨 둡니다.`,
          {
            question_id: existing.id,
            requirement_ids: related,
          },
        );
      }
      return;
    }
    const text = `${excerpt(current.text)} — ${prompt}`;
    const question: Question = {
      id: `q${questions.length + 1}`,
      unit_id: current.id,
      scope_id: current.scope_id,
      text,
      status: "open",
      candidate_unit_ids: [],
    };
    questions.push(question);
    note("question", text, {
      question_id: question.id,
      requirement_ids: related,
    });
  } else if (signal === "concrete") {
    if (notes.some((n) => n.unit_id === current.id && n.kind === "hold"))
      return;
    note(
      "evidence",
      related.length
        ? `${excerpt(current.text)} — 공고의 ${job.requirements
            .filter((r) => related.includes(r.id))
            .map((r) => `‘${r.label}’`)
            .join(", ")} 요건과 연결해 볼 설명입니다.`
        : `${excerpt(current.text)} — 구체적인 설명 후보로 표시했습니다. 공고 요건과의 연결은 확인되지 않았습니다.`,
      { requirement_ids: related },
    );
  }
  // Abstention and unchanged duplicate questions produce no public note.
  // Window completion still records that the unit was processed, not endorsed.
}
