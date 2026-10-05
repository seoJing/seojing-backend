import { describe, expect, it, vi } from "vitest";
import { validateProfile } from "../src/services/readme-lab/codex.js";
import { validateReaderProfile } from "../src/services/readme-lab/profile.js";
import {
  createMemory,
  finishReading,
  readPrefix,
  type TransitionVerifier,
} from "../src/services/readme-lab/reader.js";
import {
  reportInput,
  validateGroundedReport,
  failedEntailment,
} from "../src/services/readme-lab/report-v2.js";
import {
  buildDocument,
  textBlocks,
} from "../src/services/readme-lab/document.js";
import {
  emptyReading,
  mergeJob,
} from "../src/services/readme-lab/browser-client.js";
import { LabError } from "../src/services/readme-lab/errors.js";
import type { Decision, Classifier } from "../src/services/readme-lab/laya.js";
import type {
  EventPayload,
  JobView,
  Note,
  Question,
} from "../src/services/readme-lab/contracts.js";

const check = {
  facet: "role" as const,
  trigger: "운영 참여를 주장하지만 본인 역할이 없음",
  sufficient: "직접 맡은 업무를 설명",
  insufficient: "팀 성과·다른 경험·계획만 설명",
};
function posting() {
  const job = validateProfile(
    {
      requirements: [{ kind: "duty", label: "행사 운영", quote: "행사 운영" }],
    },
    "담당업무: 행사 운영",
  );
  job.reader_profile = validateReaderProfile(
    { criteria: [{ requirement_id: "r1", checks: [check] }] },
    job,
  );
  return job;
}
const decision = (labels: Record<string, string>): Decision =>
  Object.fromEntries(
    Object.entries(labels).map(([k, label]) => [
      k,
      { label, confidence: 0.99 },
    ]),
  );
const prediction = (labels: Record<string, string>) =>
  Promise.resolve(decision(labels));
function engine(): Classifier {
  return {
    metadata: {
      model: "convaiinnovations/laya-multilingual",
      revision: "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67",
      sdk: "0.3.25",
      device: "test_double",
      weights_sha256: "0".repeat(64),
      finetuned: false,
      calibrated_for_readme: false,
    },
    close: vi.fn(),
    predict: vi.fn<Classifier["predict"]>((kind, input) => {
      const state = input as { current: string; previous?: { text: string }[] };
      if (kind === "reader_unit")
        return prediction({
          actor: "self",
          actuality: state.current.includes("계획") ? "planned" : "performed",
          role:
            state.current.includes("직접") ||
            state.previous?.some((u) => u.text.includes("직접"))
              ? "present"
              : "missing",
          method: "irrelevant",
          result: "irrelevant",
          basis: "irrelevant",
        });
      if (kind === "reader_relation")
        return prediction({
          scope: state.current.includes("다른") ? "different" : "same",
          relation: state.current.includes("일부")
            ? "partial"
            : state.current.includes("정정")
              ? "conflict"
              : "complete",
        });
      if (kind === "reader_check") return prediction({ check: "needed" });
      return prediction({ relevance: "supports" });
    }),
  };
}
function setup(
  text = "행사 운영을 지원했습니다. 제가 직접 안내문 작성을 맡았습니다. 일부 내용을 덧붙입니다. 앞선 내용은 정정합니다.",
) {
  const document = buildDocument(textBlocks(text), "txt");
  const job = posting();
  const memory = createMemory(job);
  const classifier = engine();
  const notes: Note[] = [],
    questions: Question[] = [],
    events: EventPayload[] = [];
  return {
    document,
    job,
    memory,
    classifier,
    notes,
    questions,
    events,
    step: (i: number, verify?: TransitionVerifier) =>
      readPrefix(
        document.units.slice(0, i + 1),
        job,
        classifier,
        memory,
        notes,
        questions,
        (e) => events.push(e),
        verify,
      ),
  };
}
const verifier: TransitionVerifier = ({ current, relation }) =>
  Promise.resolve({
    verdict: relation,
    evidence_unit_ids: [current.id],
  });

describe("reader profile provenance", () => {
  it("requires every actionable requirement exactly once and no duplicate facet", () => {
    const job = posting();
    expect(() => validateReaderProfile({ criteria: [] }, job)).toThrow(
      "engine_output_invalid",
    );
    expect(() =>
      validateReaderProfile(
        { criteria: [{ requirement_id: "fake", checks: [check] }] },
        job,
      ),
    ).toThrow("engine_output_invalid");
    expect(() =>
      validateReaderProfile(
        { criteria: [{ requirement_id: "r1", checks: [check, check] }] },
        job,
      ),
    ).toThrow("engine_output_invalid");
    expect(posting().reader_profile).toEqual(job.reader_profile);
    job.requirements[0]!.kind = "other";
    expect(() =>
      validateReaderProfile(
        { criteria: [{ requirement_id: "r1", checks: [check] }] },
        job,
      ),
    ).toThrow("engine_output_invalid");
  });
});

describe("prefix memory and conservative transitions", () => {
  it("checks a one-off answer against every prior question even when there are more than eight", async () => {
    const document = buildDocument(
      textBlocks(
        Array.from({ length: 10 }, (_, i) => `업무 ${i + 1} 설명입니다.`).join(
          " ",
        ),
      ),
      "txt",
    );
    const labels = Array.from({ length: 8 }, (_, i) => `담당업무 ${i + 1}`);
    const job = validateProfile(
      {
        requirements: labels.map((label) => ({
          kind: "duty",
          label,
          quote: label,
        })),
      },
      labels.join("\n"),
    );
    job.reader_profile = validateReaderProfile(
      {
        criteria: job.requirements.map((r, i) => ({
          requirement_id: r.id,
          checks: i === 0 ? [check, { ...check, facet: "basis" }] : [check],
        })),
      },
      job,
    );
    const memory = createMemory(job);
    memory.units = structuredClone(document.units.slice(0, 9));
    const questions: Question[] = job.reader_profile.criteria.flatMap((c) =>
      c.checks.map((item) => ({
        id: "",
        unit_id: "u1",
        scope_id: document.units[0]!.scope_id,
        criterion_id: c.id,
        facet: item.facet,
        text: "",
        status: "open" as const,
        candidate_unit_ids: [],
        evidence_unit_ids: [],
        state_version: 1,
      })),
    );
    questions.forEach((q, i) => {
      q.id = `q${i + 1}`;
      q.text = `질문 ${i + 1}`;
    });
    const classifier = engine();
    classifier.predict = vi.fn<Classifier["predict"]>((kind, input) => {
      if (kind === "reader_relation")
        return prediction({
          scope: "same",
          relation:
            (input as { question: string }).question === "질문 9"
              ? "complete"
              : "unrelated",
        });
      if (kind === "reader_unit")
        return prediction({
          actor: "unknown",
          actuality: "context",
          role: "irrelevant",
          method: "irrelevant",
          result: "irrelevant",
          basis: "irrelevant",
        });
      return prediction({ relevance: "unrelated" });
    });
    await readPrefix(
      document.units,
      job,
      classifier,
      memory,
      [],
      questions,
      () => undefined,
      verifier,
    );
    expect(questions[8]).toMatchObject({
      status: "resolved",
      evidence_unit_ids: ["u10"],
    });
    expect(
      vi
        .mocked(classifier.predict)
        .mock.calls.filter(([kind]) => kind === "reader_relation"),
    ).toHaveLength(9);
    expect(questions.slice(0, 8).every((q) => q.status === "open")).toBe(true);
  });
  it("finalizes still-open questions in the ledger before generating the report", async () => {
    const s = setup();
    await s.step(0);
    finishReading(s.memory, s.questions, (e) => s.events.push(e));
    expect(s.questions[0]).toMatchObject({
      status: "open_at_end",
      state_version: 2,
    });
    expect(s.memory.transitions.at(-1)).toMatchObject({
      previous_status: "open",
      status: "open_at_end",
      at_unit_id: "u1",
    });
    expect(s.memory.transitions[0]!.question.status).toBe("open");
  });
  it("uses all short past context instead of stopping new questions after four background units", async () => {
    const s = setup(
      "행사 운영 프로젝트입니다. 기간은 지난해입니다. 장소는 회의실입니다. 팀원은 세 명입니다. 행사 운영에 참여했습니다.",
    );
    const original = s.classifier.predict;
    s.classifier.predict = vi.fn<Classifier["predict"]>((kind, input) => {
      if (
        kind === "reader_unit" &&
        !(input as { current: string }).current.includes("참여")
      )
        return prediction({
          actor: "unknown",
          actuality: "context",
          role: "irrelevant",
          method: "irrelevant",
          result: "irrelevant",
          basis: "irrelevant",
        });
      return original(kind, input);
    });
    for (let i = 0; i < 5; i++) await s.step(i);
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]!.unit_id).toBe("u5");
    expect(s.memory.observations[4]!.context_limited).toBe(false);
  });
  it("retains older role evidence, avoids asking for it again, and never receives future text", async () => {
    const a = setup(
      "제가 직접 행사 안내문을 작성했습니다. 행사는 주말에 열렸습니다. 장소는 회의실입니다. 신청은 온라인으로 받았습니다. 행사 운영을 지원했습니다.",
    );
    const b = setup(
      "제가 직접 행사 안내문을 작성했습니다. 행사는 주말에 열렸습니다. 장소는 회의실입니다. 신청은 온라인으로 받았습니다. 완전히 다른 미래 비밀입니다.",
    );
    for (let i = 0; i < 4; i++) {
      await a.step(i);
      await b.step(i);
    }
    expect(vi.mocked(a.classifier.predict).mock.calls).toEqual(
      vi.mocked(b.classifier.predict).mock.calls,
    );
    await a.step(4);
    expect(a.questions).toHaveLength(0);
    const units = vi
      .mocked(a.classifier.predict)
      .mock.calls.filter(([kind]) => kind === "reader_unit");
    expect(JSON.stringify(units.at(-1))).toContain("직접 행사 안내문");
    expect(a.memory.units).toEqual(a.document.units);
  });
  it("does not resolve from a confident uncalibrated base model", async () => {
    const s = setup();
    await s.step(0);
    await s.step(1);
    expect(s.questions[0]).toMatchObject({
      status: "held",
      candidate_unit_ids: ["u2"],
      evidence_unit_ids: [],
    });
    expect(s.notes.some((n) => n.kind === "resolves")).toBe(false);
    expect(
      s.events.filter((e) => e.type === "question_updated")[0],
    ).toMatchObject({
      previous_status: null,
      status: "open",
      question: { status: "open" },
    });
  });
  it("preserves original questions and evidence across partial, resolved and reopened states", async () => {
    const s = setup(
      "행사 운영을 지원했습니다. 제가 일부 안내문을 직접 작성했습니다. 제가 나머지 안내문도 직접 작성했습니다. 앞선 설명을 정정합니다.",
    );
    for (let i = 0; i < 4; i++) await s.step(i, verifier);
    const transitions = s.memory.transitions;
    expect(transitions.map((e) => e.status)).toEqual([
      "open",
      "partial",
      "resolved",
      "reopened",
    ]);
    expect(transitions[0]!.question.status).toBe("open");
    expect(s.questions[0]).toMatchObject({
      unit_id: "u1",
      status: "reopened",
      evidence_unit_ids: ["u2", "u3", "u4"],
      state_version: 4,
    });
    expect(s.notes.filter((n) => n.kind === "resolves")).toHaveLength(1);
  });
  it("checks planned and short follow-ups independently of action classification; refuses different experience", async () => {
    const s = setup(
      "행사 운영을 지원했습니다. 다음에도 참여할 계획입니다. 다른 행사에서 직접 자료를 작성했습니다.",
    );
    await s.step(0);
    await s.step(1);
    await s.step(2);
    expect(
      vi
        .mocked(s.classifier.predict)
        .mock.calls.filter(([k]) => k === "reader_relation"),
    ).toHaveLength(2);
    expect(s.questions[0]!.candidate_unit_ids).toEqual(["u2"]);
  });
  it("rejects forged/future verifier references and non-contiguous prefixes", async () => {
    const s = setup();
    await expect(s.step(1)).rejects.toThrow("reader_prefix_invalid");
    await s.step(0);
    await expect(
      s.step(1, () =>
        Promise.resolve({
          verdict: "complete",
          evidence_unit_ids: ["u2", "u4"],
        }),
      ),
    ).rejects.toThrow("reader_verifier_reference_invalid");
  });
  it("keeps all raw source after a context-budget abstention and does not ask a false missing-info question", async () => {
    const s = setup();
    s.classifier.predict = vi.fn(() =>
      Promise.reject(new LabError("context_budget_exceeded")),
    );
    await s.step(0);
    expect(s.notes).toEqual([]);
    expect(s.questions).toEqual([]);
    expect(s.memory.observations[0]!.context_limited).toBe(true);
    expect(s.memory.units[0]!.text).toBe(s.document.units[0]!.text);
  });
  it("does not emit evidence cards without requirement links", async () => {
    const s = setup();
    s.job.requirements = [];
    s.job.reader_profile!.criteria = [];
    await s.step(0);
    expect(s.notes).toEqual([]);
    expect(s.memory.units).toHaveLength(1);
  });
  it("merges versioned question events idempotently and rejects missing state transitions", async () => {
    const s = setup();
    await s.step(0);
    await s.step(1, verifier);
    const view: JobView = {
      job_id: "test",
      status: "reading",
      events: s.events.map((e, i) => ({ ...e, seq: i + 1 })),
      next_seq: s.events.length,
      progress: {
        read_unit_count: 2,
        total_unit_count: 4,
        current_window: null,
      },
      report: null,
      error: null,
      generation: {
        engine: "laya",
        policy_version: "readme-prefix-v2",
        model: s.classifier.metadata,
        prepare_engine: "codex_cli",
        report_engine: "codex_cli",
        codex_model: "test_double",
      },
      expires_at: "synthetic",
    };
    const first = mergeJob(emptyReading(), view);
    expect(first.questions[0]!.status).toBe("resolved");
    expect(mergeJob(first, view).questions).toEqual(first.questions);
    const broken = structuredClone(view);
    const event = broken.events.find(
      (e) => e.type === "question_updated" && e.previous_status !== null,
    )!;
    if (event.type === "question_updated") event.previous_status = "partial";
    expect(() => mergeJob(emptyReading(), broken)).toThrow(
      "question_state_gap",
    );
  });
});

describe("grounded final source review", () => {
  it("compacts redundant metadata while preserving all source, current questions and transition proof", async () => {
    const s = setup();
    for (let i = 0; i < s.document.units.length; i++) await s.step(i, verifier);
    const before = structuredClone({
      memory: s.memory,
      notes: s.notes,
      questions: s.questions,
    });
    const input = reportInput(
      s.document,
      s.job,
      s.notes,
      s.questions,
      s.memory,
    );
    expect(input.units).toEqual(
      s.document.units.map(({ id, text, scope_id, order }) => ({
        id,
        text,
        scope_id,
        order,
      })),
    );
    expect(input.questions).toEqual(s.questions);
    expect(input.transitions).toEqual(
      s.memory.transitions.map(
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
    );
    expect(input.transitions.every((t) => !("question" in t))).toBe(true);
    expect(input.notes).toEqual(
      s.notes.map(
        ({
          id,
          unit_id,
          kind,
          text,
          evidence_unit_ids,
          requirement_ids,
          question_id,
        }) => ({
          id,
          unit_id,
          kind,
          text,
          evidence_unit_ids,
          requirement_ids,
          ...(question_id ? { question_id } : {}),
        }),
      ),
    );
    expect({
      memory: s.memory,
      notes: s.notes,
      questions: s.questions,
    }).toEqual(before);
  });
  it("includes unnoted source and refuses incomplete reader memory", async () => {
    const s = setup();
    await s.step(0);
    expect(() =>
      reportInput(s.document, s.job, s.notes, s.questions, s.memory),
    ).toThrow("reader_not_complete");
    expect(reportInput(s.document, s.job, [], []).units).toHaveLength(4);
  });
  it("requires exact quoted spans, valid links and retains held state despite final source findings", () => {
    const s = setup();
    const question: Question = {
      id: "q1",
      unit_id: "u1",
      scope_id: "b1",
      text: "역할은?",
      status: "held",
      candidate_unit_ids: ["u2"],
    };
    const draft = {
      items: [
        {
          category: "explained",
          observation: "안내문을 맡았다고 적혀 있습니다.",
          gap: "",
          suggestion: "작성한 안내 항목을 덧붙일 수 있습니다.",
          evidence: [
            { unit_id: "u2", quote: "직접 안내문 작성을 맡았습니다." },
          ],
          note_ids: [],
          requirement_ids: ["r1"],
        },
      ],
    };
    const report = validateGroundedReport(
      draft,
      s.document,
      s.job,
      [],
      [question],
    );
    expect(report.questions[0]!.status).toBe("held");
    expect(report.items[0]!.reason).not.toMatch(/^최종 원문 점검/);
    const citation = report.items[0]!.citations[0]!;
    expect(s.document.blocks[0]!.text.slice(citation.start, citation.end)).toBe(
      draft.items[0]!.evidence[0]!.quote,
    );
    draft.items[0]!.evidence[0]!.quote = "없던 설명";
    expect(() =>
      validateGroundedReport(draft, s.document, s.job, [], []),
    ).toThrow("engine_output_invalid");
  });
  it("discloses linked unresolved reading history without deriving an answer from a shared citation", () => {
    const s = setup();
    const origin = s.document.units[0]!;
    const question: Question = {
      id: "q1",
      unit_id: origin.id,
      scope_id: origin.scope_id,
      text: "본인이 맡은 역할은 무엇인가요?",
      status: "open_at_end",
      candidate_unit_ids: [],
      state_version: 2,
    };
    const note: Note = {
      id: "n1",
      unit_id: origin.id,
      span: { block_id: origin.block_id, start: origin.start, end: origin.end },
      kind: "question",
      text: question.text,
      question_id: "q1",
      evidence_unit_ids: [origin.id],
      requirement_ids: ["r1"],
      review_required: true,
    };
    const item = {
      category: "explained",
      observation: "안내문 작성을 직접 맡았다고 설명했습니다.",
      gap: "",
      suggestion: "운영 지원 문장에 담당 업무를 연결해 주세요.",
      evidence: [
        { unit_id: origin.id, quote: origin.text },
        { unit_id: "u2", quote: "직접 안내문 작성을 맡았습니다." },
      ],
      note_ids: ["n1"],
      requirement_ids: ["r1"],
    };
    const before = structuredClone({ question, note });
    const report = validateGroundedReport(
      { items: [item] },
      s.document,
      s.job,
      [note],
      [question],
      "jev",
    );
    expect(report.items[0]!.reason).toContain(
      "연결된 메모에는 읽는 중 확정하지 못한 질문이 남아 있습니다.",
    );
    expect(report.items[0]!.reason.endsWith(item.suggestion)).toBe(true);
    expect(report.questions[0]!.status).toBe("open_at_end");
    expect({ question, note }).toEqual(before);
    for (const [otherItem, otherNote, otherQuestion] of [
      [{ ...item, note_ids: [] }, note, question],
      [item, { ...note, kind: "evidence" as const }, question],
      [item, note, { ...question, status: "resolved" as const }],
      [{ ...item, category: "improve" }, note, question],
    ] as const) {
      const other = validateGroundedReport(
        { items: [otherItem] },
        s.document,
        s.job,
        [otherNote],
        [otherQuestion],
        "jev",
      );
      expect(other.items[0]!.reason).toBe(item.suggestion);
    }
  });
  it("requires semantic audit coverage for every item and rejects flagged distortions", () => {
    expect(
      failedEntailment(
        { checks: [{ index: 0, supported: false, issue: "quantity" }] },
        1,
      ),
    ).toEqual([0]);
    expect(() => failedEntailment({ checks: [] }, 1)).toThrow(
      "engine_output_invalid",
    );
    expect(() =>
      failedEntailment(
        { checks: [{ index: 1, supported: true, issue: "none" }] },
        1,
      ),
    ).toThrow("engine_output_invalid");
    expect(() =>
      failedEntailment(
        {
          checks: [
            { index: 0, supported: true, issue: "none" },
            { index: 0, supported: true, issue: "none" },
          ],
        },
        2,
      ),
    ).toThrow("engine_output_invalid");
  });
});
