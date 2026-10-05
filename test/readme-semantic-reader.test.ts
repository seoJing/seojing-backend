import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CodexReasoner,
  validateProfile,
  type Reasoner,
} from "../src/services/readme-lab/codex.js";
import { validateReaderProfile } from "../src/services/readme-lab/profile.js";
import {
  buildDocument,
  textBlocks,
} from "../src/services/readme-lab/document.js";
import {
  createMemory,
  finishReading,
} from "../src/services/readme-lab/reader.js";
import {
  readSemanticPrefix,
  semanticInput,
  validateSemanticStep,
  type SemanticStep,
} from "../src/services/readme-lab/semantic-reader.js";
import { runCommand } from "../src/services/readme-lab/process.js";
import { readSemanticDocument } from "../src/services/readme-lab/semantic-pipeline.js";
import { validateGroundedReport } from "../src/services/readme-lab/report-v2.js";
import { LabError } from "../src/services/readme-lab/errors.js";
import type {
  EventPayload,
  Note,
  Question,
} from "../src/services/readme-lab/contracts.js";
vi.mock("../src/services/readme-lab/process.js", () => ({
  runCommand: vi.fn(),
}));
afterEach(() => vi.mocked(runCommand).mockReset());
const empty: SemanticStep = {
  questions: [],
  updates: [],
  evidence: [],
  retractions: [],
};
function fixture() {
  const job = validateProfile(
    {
      requirements: [
        { kind: "duty", label: "안내문 작성", quote: "안내문 작성" },
      ],
    },
    "업무: 안내문 작성",
  );
  job.reader_profile = validateReaderProfile(
    {
      criteria: [
        {
          requirement_id: "r1",
          checks: [
            {
              facet: "role",
              trigger: "참여 주장",
              sufficient: "직접 작성한 범위",
              insufficient: "팀의 성과만 있음",
            },
          ],
        },
      ],
    },
    job,
  );
  const document = buildDocument(
    textBlocks(
      "행사 안내문 작성에 참여했습니다. 😀 저는 행사 안내문의 일정 부분을 직접 작성했습니다. 정정하면 이 부분을 작성한 사람은 동료입니다.",
    ),
    "txt",
  );
  const memory = createMemory(job, "codex_cli"),
    notes: Note[] = [],
    questions: Question[] = [],
    events: EventPayload[] = [];
  const proof = (i: number) => ({
    unit_id: document.units[i]!.id,
    quote: document.units[i]!.text,
  });
  const question: SemanticStep = {
    ...empty,
    questions: [
      {
        criterion_id: "c_r1",
        facet: "role",
        text: "이 행사 안내문에서 본인이 직접 작성한 부분은 무엇인가요?",
        evidence: [proof(0)],
      },
    ],
  };
  const update = (
    i: number,
    relation: "complete" | "partial" | "conflict",
  ): SemanticStep => ({
    ...empty,
    updates: [
      {
        question_id: "q1",
        relation,
        text: "현재 문장에서 안내문 작성 범위에 대한 설명을 확인합니다.",
        evidence: [
          proof(0),
          ...(relation === "conflict" && i > 1 ? [proof(i - 1)] : []),
          proof(i),
        ],
      },
    ],
  });
  const input = (i: number) => ({
    job,
    prefix: document.units.slice(0, i + 1),
    questions,
    notes,
    note_retractions: memory.note_retractions,
  });
  const step = (
    i: number,
    value: SemanticStep,
    signal = new AbortController().signal,
  ) =>
    readSemanticPrefix(
      document.units.slice(0, i + 1),
      job,
      { readStep: () => Promise.resolve(value) },
      memory,
      notes,
      questions,
      (e) => events.push(e),
      signal,
    );
  return {
    job,
    document,
    memory,
    notes,
    questions,
    events,
    proof,
    question,
    update,
    input,
    step,
  };
}
describe("semantic reader source and state boundary", () => {
  it("requires the answer being contradicted, not only question and new source", async () => {
    const f = fixture();
    await f.step(0, f.question);
    await f.step(1, f.update(1, "complete"));
    const conflict = f.update(2, "conflict");
    conflict.updates[0]!.evidence = [f.proof(0), f.proof(2)];
    expect(() => validateSemanticStep(conflict, f.input(2))).toThrow(
      "engine_output_invalid",
    );
    try {
      validateSemanticStep(conflict, f.input(2));
    } catch (error) {
      expect(error).toMatchObject({
        validationReason: "reader_conflict_answer_quote_missing",
      });
    }
    expect(validateSemanticStep(f.update(2, "conflict"), f.input(2))).toEqual(
      f.update(2, "conflict"),
    );
  });
  it("links a standalone withdrawal without changing the original evidence", async () => {
    const f = fixture();
    await f.step(0, empty);
    await f.step(1, {
      ...empty,
      evidence: [
        {
          requirement_ids: ["r1"],
          text: "안내문의 일정 부분을 직접 작성했다고 설명했습니다.",
          evidence: [f.proof(1)],
        },
      ],
    });
    expect(semanticInput(f.input(2)).notes[0]!.anchor_quote).toBe(
      f.proof(1).quote,
    );
    const original = structuredClone(f.notes[0]);
    const event = structuredClone(f.events[0]);
    const correction: SemanticStep = {
      ...empty,
      retractions: [
        {
          note_id: "n1",
          text: "앞선 직접 작성 서술을 동료가 작성한 것으로 정정했습니다.",
          evidence: [f.proof(1), f.proof(2)],
        },
      ],
    };
    await f.step(2, correction);
    expect(f.notes[0]).toEqual(original);
    expect(f.events[0]).toEqual(event);
    expect(f.questions).toEqual([]);
    expect(f.notes[1]).toMatchObject({
      kind: "observation",
      unit_id: "u3",
      evidence_unit_ids: ["u2", "u3"],
      requirement_ids: ["r1"],
    });
    expect(f.notes[1]).not.toHaveProperty("question_id");
    expect(f.memory.note_retractions).toEqual([
      { note_id: "n1", at_unit_id: "u3" },
    ]);
    expect(f.events.at(-1)).toEqual({ type: "note", note: f.notes[1] });
  });
  it("rejects missing, repeated, already withdrawn and question-linked targets atomically", async () => {
    const f = fixture();
    await f.step(0, empty);
    await f.step(1, {
      ...empty,
      evidence: [
        {
          requirement_ids: ["r1"],
          text: "일정 부분을 직접 작성했다고 설명했습니다.",
          evidence: [f.proof(1)],
        },
      ],
    });
    const item = {
      note_id: "n1",
      text: "앞선 작성 설명을 동료의 작업으로 정정했습니다.",
      evidence: [f.proof(1), f.proof(2)],
    };
    const before = JSON.stringify([f.memory, f.notes, f.questions, f.events]);
    for (const retractions of [
      [{ ...item, note_id: "missing" }],
      [item, item],
      [{ ...item, evidence: [f.proof(2)] }],
      [{ ...item, evidence: [f.proof(1)] }],
      [
        {
          ...item,
          evidence: [f.proof(1), { unit_id: "u3", quote: "없는 정정" }],
        },
      ],
    ]) {
      await expect(f.step(2, { ...empty, retractions })).rejects.toThrow(
        "engine_output_invalid",
      );
      expect(JSON.stringify([f.memory, f.notes, f.questions, f.events])).toBe(
        before,
      );
    }
    const input = {
      ...f.input(2),
      prefix: [
        ...f.document.units,
        { ...f.document.units[2]!, id: "u4", order: 3 },
      ],
      note_retractions: [{ note_id: "n1", at_unit_id: "u3" }],
    };
    expect(() =>
      validateSemanticStep(
        {
          ...empty,
          retractions: [
            {
              ...item,
              evidence: [
                f.proof(1),
                { unit_id: "u4", quote: f.proof(2).quote },
              ],
            },
          ],
        },
        input,
      ),
    ).toThrow("engine_output_invalid");
    const linked = fixture();
    await linked.step(0, linked.question);
    await linked.step(1, linked.update(1, "complete"));
    linked.notes[1]!.kind = "evidence";
    await expect(
      linked.step(2, { ...empty, retractions: [{ ...item, note_id: "n2" }] }),
    ).rejects.toMatchObject({
      validationReason: "reader_retraction_reference_invalid",
    });
  });
  it("does not withdraw one clause using another clause from the same unit", async () => {
    const f = fixture();
    await f.step(0, empty);
    await f.step(1, {
      ...empty,
      evidence: [
        {
          requirement_ids: ["r1"],
          text: "안내문의 일정 부분을 직접 작성했다고 설명했습니다.",
          evidence: [
            { unit_id: "u2", quote: "일정 부분을 직접 작성했습니다." },
          ],
        },
      ],
    });
    const correction = {
      note_id: "n1",
      text: "앞선 작성 주체 설명을 정정했습니다.",
      evidence: [{ unit_id: "u2", quote: "😀 저는 행사 안내문의" }, f.proof(2)],
    };
    expect(() =>
      validateSemanticStep({ ...empty, retractions: [correction] }, f.input(2)),
    ).toThrow("engine_output_invalid");
    try {
      validateSemanticStep({ ...empty, retractions: [correction] }, f.input(2));
    } catch (e) {
      expect(e).toMatchObject({
        validationReason: "reader_retraction_anchor_quote_missing",
      });
    }
    correction.evidence[0] = {
      unit_id: "u2",
      quote: "일정 부분을 직접 작성했습니다.",
    };
    expect(
      validateSemanticStep({ ...empty, retractions: [correction] }, f.input(2))
        .retractions,
    ).toHaveLength(1);
  });
  it("rejects future or impossible private retraction history before model input", async () => {
    const f = fixture();
    await f.step(0, empty);
    await f.step(1, {
      ...empty,
      evidence: [
        {
          requirement_ids: ["r1"],
          text: "일정 부분을 직접 작성했다고 설명했습니다.",
          evidence: [f.proof(1)],
        },
      ],
    });
    for (const note_retractions of [
      [{ note_id: "n1", at_unit_id: "u3" }],
      [{ note_id: "n1", at_unit_id: "u1" }],
      [{ note_id: "missing", at_unit_id: "u2" }],
    ])
      expect(() => semanticInput({ ...f.input(2), note_retractions })).toThrow(
        "reader_state_invalid",
      );
    f.notes.push(structuredClone(f.notes[0]!));
    expect(() => semanticInput(f.input(2))).toThrow("reader_state_invalid");
  });
  it("discloses the actual reader and all-text cloud processing in Codex reports", () => {
    const f = fixture();
    const report = validateGroundedReport(
      { items: [] },
      f.document,
      f.job,
      [],
      [],
      "codex_cli",
    );
    expect(report.limitations.join(" ")).toContain(
      "추출된 원문 전체의 순차 독해",
    );
    expect(report.limitations.join(" ")).not.toContain("Laya");
    expect(
      validateGroundedReport(
        { items: [] },
        f.document,
        f.job,
        [],
        [],
      ).limitations.join(" "),
    ).toContain("Laya 기본 모델");
  });
  it("keeps decimal measurements and dotted names in the same causal unit", () => {
    const doc = buildDocument(
      textBlocks(
        "1. 저는 Node.js로 문의를 집계했습니다. 평균 처리시간은 12.5분에서 10분으로 줄었습니다. 기록 기간은 2024.03부터 2024.04까지입니다.",
      ),
      "txt",
    );
    expect(doc.units.map((u) => u.text.trim())).toEqual([
      "1. 저는 Node.js로 문의를 집계했습니다.",
      "평균 처리시간은 12.5분에서 10분으로 줄었습니다.",
      "기록 기간은 2024.03부터 2024.04까지입니다.",
    ]);
    for (const u of doc.units)
      expect(doc.blocks[0]!.text.slice(u.start, u.end)).toBe(u.text);
  });
  it("changing future source leaves earlier serialized model input unchanged", () => {
    const f = fixture();
    const before = JSON.stringify(semanticInput(f.input(0)));
    f.document.units[1]!.text = "미래의 설명을 다른 사건으로 완전히 바꿉니다.";
    f.document.units[2]!.text = "앞선 답을 부정하는 전혀 다른 정정입니다.";
    expect(JSON.stringify(semanticInput(f.input(0)))).toBe(before);
  });
  it("preserves original annotations while later answers resolve and corrections reopen", async () => {
    const f = fixture();
    await f.step(0, f.question);
    const original = structuredClone(f.events[0]);
    await f.step(1, f.update(1, "complete"));
    await f.step(2, f.update(2, "conflict"));
    expect(f.questions[0]).toMatchObject({
      status: "reopened",
      state_version: 3,
      evidence_unit_ids: ["u2", "u3"],
    });
    expect(f.events[0]).toEqual(original);
    expect(f.notes.map((n) => n.kind)).toEqual([
      "question",
      "resolves",
      "hold",
    ]);
    expect(f.notes[0]!.text).toContain(f.questions[0]!.text);
    for (const n of f.notes) {
      const block = f.document.blocks.find((b) => b.id === n.span.block_id)!;
      expect(block.text.slice(n.span.start, n.span.end)).toBe(
        f.document.units.find((u) => u.id === n.unit_id)!.text,
      );
    }
  });
  it("leaves no partial state after a malformed quote or reference", async () => {
    const f = fixture();
    const bad = structuredClone(f.question);
    bad.questions[0]!.evidence[0]!.quote = "문서에 없는 내용";
    await expect(f.step(0, bad)).rejects.toMatchObject({
      validationReason: "reader_quote_invalid",
    });
    expect(f.memory.units).toHaveLength(0);
    expect(f.notes).toEqual([]);
    expect(f.questions).toEqual([]);
    expect(f.events).toEqual([]);
    await f.step(0, f.question);
    const snap = JSON.stringify([f.memory, f.notes, f.questions, f.events]);
    const update = f.update(1, "complete");
    update.updates.push({ ...update.updates[0]!, question_id: "missing" });
    await expect(f.step(1, update)).rejects.toThrow("engine_output_invalid");
    expect(JSON.stringify([f.memory, f.notes, f.questions, f.events])).toBe(
      snap,
    );
  });
  it("requires both original and current literal sources for transitions", async () => {
    const f = fixture();
    await f.step(0, f.question);
    const bad = f.update(1, "complete");
    bad.updates[0]!.evidence = [f.proof(1)];
    expect(() => validateSemanticStep(bad, f.input(1))).toThrow(
      "engine_output_invalid",
    );
    bad.updates[0]!.evidence = [f.proof(0)];
    expect(() => validateSemanticStep(bad, f.input(1))).toThrow(
      "engine_output_invalid",
    );
  });
  it("rejects future state references and unsupported criterion before calling a model", async () => {
    const f = fixture();
    await f.step(0, f.question);
    f.questions[0]!.candidate_unit_ids = ["u3"];
    expect(() => semanticInput(f.input(1))).toThrow("reader_state_invalid");
    f.questions[0]!.candidate_unit_ids = [];
    f.notes[0]!.evidence_unit_ids = ["u3"];
    expect(() => semanticInput(f.input(1))).toThrow("reader_state_invalid");
    f.notes[0]!.evidence_unit_ids = ["u1"];
    f.questions[0]!.criterion_id = "fake";
    expect(() => semanticInput(f.input(1))).toThrow("reader_state_invalid");
  });
  it("allows a distinct experience question in the same structural scope", async () => {
    const f = fixture();
    await f.step(0, f.question);
    const second = structuredClone(f.question);
    second.questions[0]!.text =
      "다른 행사 안내문에서는 직접 어떤 부분을 작성했나요?";
    second.questions[0]!.evidence = [f.proof(1)];
    await f.step(1, second);
    expect(f.questions).toHaveLength(2);
  });
  it("rejects replay, changed prefix and cancellation without committing a new unit", async () => {
    const f = fixture();
    await f.step(0, f.question);
    await expect(f.step(0, f.question)).rejects.toThrow(
      "reader_prefix_invalid",
    );
    const c = new AbortController();
    c.abort();
    await expect(f.step(1, empty, c.signal)).rejects.toThrow("cancelled");
    f.memory.engine = "laya";
    await expect(f.step(1, empty)).rejects.toThrow("reader_prefix_invalid");
    f.memory.engine = "codex_cli";
    f.document.units[0]!.text += "수정";
    await expect(f.step(1, empty)).rejects.toThrow("reader_prefix_invalid");
    expect(f.memory.units).toHaveLength(1);
  });
  it("emits the final unanswered state without rewriting question text", async () => {
    const f = fixture();
    await f.step(0, f.question);
    finishReading(f.memory, f.questions, (e) => f.events.push(e));
    expect(f.questions[0]!.status).toBe("open_at_end");
    expect(f.events.at(-1)).toMatchObject({
      previous_status: "open",
      status: "open_at_end",
      question: { text: f.question.questions[0]!.text },
    });
  });
});
function outputs(values: unknown[]) {
  vi.mocked(runCommand).mockImplementation(async ({ cwd }) => {
    if (!values.length) throw Error("unexpected_call");
    await writeFile(join(cwd, "output.json"), JSON.stringify(values.shift()));
    return '{"type":"turn.completed"}';
  });
}
describe("actual CLI prompt boundary and bounded audit", () => {
  it("audits an empty step and repairs a missed standalone withdrawal", async () => {
    const f = fixture();
    await f.step(0, empty);
    await f.step(1, {
      ...empty,
      evidence: [
        {
          requirement_ids: ["r1"],
          text: "일정 부분을 직접 작성했다고 설명했습니다.",
          evidence: [f.proof(1)],
        },
      ],
    });
    const fixed = {
      ...empty,
      retractions: [
        {
          note_id: "n1",
          text: "직접 작성했다는 앞선 설명이 동료의 작성으로 정정됐습니다.",
          evidence: [f.proof(1), f.proof(2)],
        },
      ],
    };
    outputs([
      empty,
      { valid: false, issues: ["명시적인 작성 주체 정정을 누락함"] },
      fixed,
      { valid: true, issues: [] },
    ]);
    expect(
      await new CodexReasoner().readStep(
        f.input(2),
        new AbortController().signal,
      ),
    ).toEqual(fixed);
    expect(runCommand).toHaveBeenCalledTimes(4);
  });
  it("does not commit rejected or cancelled withdrawal drafts", async () => {
    const f = fixture();
    await f.step(0, empty);
    await f.step(1, {
      ...empty,
      evidence: [
        {
          requirement_ids: ["r1"],
          text: "일정 부분을 직접 작성했다고 설명했습니다.",
          evidence: [f.proof(1)],
        },
      ],
    });
    const draft = {
      ...empty,
      retractions: [
        {
          note_id: "n1",
          text: "앞선 서술이 정정됐다고 판단했습니다.",
          evidence: [f.proof(1), f.proof(2)],
        },
      ],
    };
    const before = JSON.stringify([f.memory, f.notes, f.questions, f.events]);
    outputs([
      draft,
      { valid: false, issues: ["다른 경험이라 철회 아님"] },
      draft,
      { valid: false, issues: ["구체화이며 철회 아님"] },
    ]);
    await expect(
      readSemanticPrefix(
        f.document.units,
        f.job,
        new CodexReasoner(),
        f.memory,
        f.notes,
        f.questions,
        (e) => f.events.push(e),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      validationReason: "reader_semantic_review_failed",
    });
    expect(JSON.stringify([f.memory, f.notes, f.questions, f.events])).toBe(
      before,
    );
    const controller = new AbortController();
    await expect(
      readSemanticPrefix(
        f.document.units,
        f.job,
        {
          readStep: () => {
            controller.abort();
            return Promise.resolve(draft);
          },
        },
        f.memory,
        f.notes,
        f.questions,
        (e) => f.events.push(e),
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(JSON.stringify([f.memory, f.notes, f.questions, f.events])).toBe(
      before,
    );
  });
  it("retries a timeout once with exactly the same evidence in a fresh CLI directory", async () => {
    const f = fixture();
    outputs([empty]);
    vi.mocked(runCommand).mockRejectedValueOnce(
      new LabError("engine_timeout", 503),
    );
    await expect(
      new CodexReasoner().readStep(f.input(0), new AbortController().signal),
    ).resolves.toEqual(empty);
    const calls = vi.mocked(runCommand).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].input).toBe(calls[1]![0].input);
    expect(calls[0]![0].cwd).not.toBe(calls[1]![0].cwd);
    expect(calls[0]![0].timeoutMs).toBe(45000);
  });
  it("bounds repeated timeouts and never retries an externally aborted call", async () => {
    const f = fixture();
    vi.mocked(runCommand).mockRejectedValue(
      new LabError("engine_timeout", 503),
    );
    await expect(
      new CodexReasoner().readStep(f.input(0), new AbortController().signal),
    ).rejects.toThrow("engine_timeout");
    expect(runCommand).toHaveBeenCalledTimes(2);
    vi.mocked(runCommand).mockReset();
    const controller = new AbortController();
    vi.mocked(runCommand).mockImplementation(() => {
      controller.abort();
      return Promise.reject(new LabError("engine_timeout", 503));
    });
    await expect(
      new CodexReasoner().readStep(f.input(0), controller.signal),
    ).rejects.toThrow("engine_timeout");
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it("uses only current prefix and repairs a semantic rejection", async () => {
    const f = fixture();
    outputs([
      f.question,
      { valid: false, issues: ["질문 문장을 더 명확히 작성"] },
      f.question,
      { valid: true, issues: [] },
    ]);
    const result = await new CodexReasoner().readStep(
      f.input(0),
      new AbortController().signal,
    );
    expect(result).toEqual(f.question);
    expect(runCommand).toHaveBeenCalledTimes(4);
    for (const [call] of vi.mocked(runCommand).mock.calls) {
      expect(call.input).not.toContain("😀");
      expect(call.input).not.toContain(
        "정정하면 이 부분을 작성한 사람은 동료입니다.",
      );
    }
    expect(vi.mocked(runCommand).mock.calls[2]![0].input).toContain(
      "더 명확히",
    );
    const repair = JSON.parse(
      vi
        .mocked(runCommand)
        .mock.calls[2]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
    ) as { correction: { rejected_draft: unknown } };
    expect(repair.correction.rejected_draft).toEqual(f.question);
  });
  it("refuses both rejected drafts rather than silently losing required feedback", async () => {
    const f = fixture();
    outputs([
      f.question,
      { valid: false, issues: ["actor"] },
      f.question,
      { valid: false, issues: ["actor"] },
    ]);
    await expect(
      new CodexReasoner().readStep(f.input(0), new AbortController().signal),
    ).rejects.toMatchObject({
      validationReason: "reader_semantic_review_failed",
    });
    expect(runCommand).toHaveBeenCalledTimes(4);
  });
});

describe("sequential pipeline lifecycle", () => {
  it("distinguishes a deadline from user cancellation and preserves partial progress", async () => {
    const f = fixture();
    await expect(
      readSemanticDocument(
        f.document,
        f.job,
        {
          readStep: (input, signal) =>
            input.prefix.length === 1
              ? Promise.resolve(f.question)
              : new Promise((_resolve, reject) =>
                  signal.addEventListener(
                    "abort",
                    () => reject(new Error("aborted")),
                    { once: true },
                  ),
                ),
          report: vi.fn<Reasoner["report"]>(),
        },
        (e) => f.events.push(e),
        new AbortController().signal,
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow("engine_timeout");
    expect(f.events.at(-1)).toEqual({
      type: "failed",
      error: "engine_timeout",
      partial: true,
    });
  });
  it("publishes progress and passes the complete ledger to final reporting", async () => {
    const f = fixture();
    const report = vi.fn<Reasoner["report"]>(
      (_document, _job, _notes, questions) =>
        Promise.resolve({
          items: [],
          questions: structuredClone(questions),
          limitations: [],
        }),
    );
    const result = await readSemanticDocument(
      f.document,
      f.job,
      {
        readStep: (input) =>
          Promise.resolve(
            input.prefix.length === 1
              ? f.question
              : f.update(
                  input.prefix.length - 1,
                  input.prefix.length === 2 ? "complete" : "conflict",
                ),
          ),
        report,
      },
      (e) => f.events.push(e),
      new AbortController().signal,
    );
    expect(f.events.filter((e) => e.type === "window_completed")).toHaveLength(
      3,
    );
    expect(f.events.at(-1)!.type).toBe("report_completed");
    expect(report.mock.calls[0]![3][0]).toMatchObject({ status: "reopened" });
    expect(result.memory.units).toEqual(f.document.units);
    expect(result.metrics.first_useful_ms).not.toBeNull();
  });
  it("reports a partial failure without marking the unread suffix completed", async () => {
    const f = fixture();
    const report = vi.fn<Reasoner["report"]>();
    await expect(
      readSemanticDocument(
        f.document,
        f.job,
        {
          readStep: (input) => {
            if (input.prefix.length === 2)
              return Promise.reject(new Error("failed_model"));
            return Promise.resolve(f.question);
          },
          report,
        },
        (e) => f.events.push(e),
        new AbortController().signal,
      ),
    ).rejects.toThrow("failed_model");
    expect(f.events.at(-1)).toMatchObject({ type: "failed", partial: true });
    expect(f.events.filter((e) => e.type === "window_completed")).toHaveLength(
      1,
    );
    expect(report).not.toHaveBeenCalled();
  });
  it("cancellation during a model call discards that step and skips reporting", async () => {
    const f = fixture(),
      controller = new AbortController(),
      report = vi.fn<Reasoner["report"]>();
    await expect(
      readSemanticDocument(
        f.document,
        f.job,
        {
          readStep: () => {
            controller.abort();
            return Promise.resolve(f.question);
          },
          report,
        },
        (e) => f.events.push(e),
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(f.events.map((e) => e.type)).toEqual([
      "window_started",
      "cancelled",
    ]);
    expect(report).not.toHaveBeenCalled();
  });
});
