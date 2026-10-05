import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CodexReasoner,
  validateProfile,
} from "../src/services/readme-lab/codex.js";
import { validateReaderProfile } from "../src/services/readme-lab/profile.js";
import {
  buildDocument,
  textBlocks,
} from "../src/services/readme-lab/document.js";
import { runCommand } from "../src/services/readme-lab/process.js";
import {
  LabError,
  preparationFailureReason,
} from "../src/services/readme-lab/errors.js";
import type { Note } from "../src/services/readme-lab/contracts.js";
import { MAX_JOB_REQUIREMENTS } from "../src/services/readme-lab/profile.js";
import {
  citationRejected,
  mergeGroundedRepairs,
  type GroundedDraft,
} from "../src/services/readme-lab/report-v2.js";

vi.mock("../src/services/readme-lab/process.js", () => ({
  runCommand: vi.fn(),
}));
afterEach(() => vi.mocked(runCommand).mockReset());
// Existing fake audits use terse fixtures. Add the required explanatory field
// only for the citation schema; malformed-explicit-field tests bypass defaults.
async function writeOutput(cwd: string, input: string, value: unknown) {
  const output = structuredClone(value) as {
    checks?: {
      supported: boolean;
      issue: string;
      unsupported_claims?: unknown[];
    }[];
  };
  if (
    (await readFile(join(cwd, "schema.json"), "utf8")).includes(
      '"unsupported_claims"',
    ) &&
    output.checks
  ) {
    const payload = JSON.parse(input.split("UNTRUSTED_DATA_JSON:\n")[1]!) as {
      items: { observation: string }[];
    };
    for (const check of output.checks)
      check.unsupported_claims ??=
        check.supported && check.issue === "none"
          ? []
          : [
              {
                claim: payload.items[0]!.observation,
                reason: "이 문구의 행위 범위가 해당 인용에 없습니다.",
              },
            ];
  }
  await writeFile(join(cwd, "output.json"), JSON.stringify(output));
}
function outputs(values: unknown[]) {
  vi.mocked(runCommand).mockImplementation(async ({ cwd, input }) => {
    if (!values.length) throw new Error("unexpected_extra_model_call");
    await writeOutput(cwd, input, values.shift());
    return JSON.stringify({ type: "turn.completed" });
  });
}
function repairDraft(draft: GroundedDraft, indices = [0]) {
  return {
    repairs: indices.map((index) => ({ index, item: draft.items[index]! })),
  };
}
function fixture() {
  const document = buildDocument(
    textBlocks(
      "팀이 행사 안내문을 작성했습니다. 저는 안내문의 일정 항목을 직접 작성했습니다.",
    ),
    "txt",
  );
  const job = validateProfile(
    {
      requirements: [
        { kind: "duty", label: "안내문 작성", quote: "안내문 작성" },
      ],
    },
    "담당업무: 안내문 작성",
  );
  job.reader_profile = validateReaderProfile(
    {
      criteria: [
        {
          requirement_id: "r1",
          checks: [
            {
              facet: "role",
              trigger: "작성 참여 주장",
              sufficient: "직접 작성한 범위",
              insufficient: "팀 성과만 있음",
            },
          ],
        },
      ],
    },
    job,
  );
  const draft: GroundedDraft = {
    items: [
      {
        category: "explained",
        observation: "일정 항목을 직접 작성했다고 적혀 있습니다.",
        gap: "",
        suggestion: "작성한 항목의 예를 덧붙일 수 있습니다.",
        evidence: [
          {
            unit_id: "u2",
            quote: "저는 안내문의 일정 항목을 직접 작성했습니다.",
          },
        ],
        note_ids: [],
        requirement_ids: ["r1"],
      },
    ],
  };
  return { document, job, draft };
}
describe("targeted report repair boundary", () => {
  it("requires a supported citation repair to change the claim or actual evidence", () => {
    const { draft } = fixture();
    draft.items[0]!.evidence.push({
      unit_id: "u1",
      quote: "팀이 행사 안내문을 작성했습니다.",
    });
    for (const transform of [
      (d: GroundedDraft) => d,
      (d: GroundedDraft) => {
        d.items[0]!.suggestion = "다른 제안입니다.";
        return d;
      },
      (d: GroundedDraft) => {
        d.items[0]!.evidence.reverse();
        return d;
      },
    ]) {
      expect(() =>
        mergeGroundedRepairs(
          repairDraft(transform(structuredClone(draft))),
          draft,
          [0],
          {
            citationIndices: [0],
            deletableIndices: [],
          },
        ),
      ).toThrowError(
        expect.objectContaining({
          validationReason: "report_repair_unchanged",
        }),
      );
    }
  });
  it("requires a rejected phrase and substantive reason from the citation auditor", () => {
    const observation = "일정 항목을 직접 작성했다고 적혀 있습니다.";
    const check = {
      index: 0,
      supported: false,
      issue: "actor",
      unsupported_claims: [
        { claim: "직접 작성", reason: "인용은 팀 수행만 설명합니다." },
      ],
    };
    expect(citationRejected({ checks: [check] }, observation)).toBe(true);
    for (const claims of [
      [],
      [{ claim: "지어낸 문구", reason: "설명" }],
      [{ claim: "직접 작성", reason: " " }],
    ])
      expect(() =>
        citationRejected(
          { checks: [{ ...check, unsupported_claims: claims }] },
          observation,
        ),
      ).toThrow();
    expect(() =>
      citationRejected(
        { checks: [{ ...check, supported: true, issue: "none" }] },
        observation,
      ),
    ).toThrow();
  });
  it("requires each rejected original index once and never edits a neighboring item", () => {
    const { draft } = fixture();
    draft.items.push({
      ...structuredClone(draft.items[0]!),
      observation: "다른 원문 설명입니다.",
    });
    const before = structuredClone(draft);
    const changed = {
      ...structuredClone(draft.items[0]!),
      observation: "수정한 원문 설명입니다.",
    };
    const result = mergeGroundedRepairs(
      { repairs: [{ index: 0, item: changed }] },
      draft,
      [0],
    );
    expect(result.items).toEqual([changed, before.items[1]]);
    result.items[1]!.observation = "후속 변형";
    expect(draft).toEqual(before);
    for (const repairs of [
      [],
      [{ index: 1, item: changed }],
      [
        { index: 0, item: changed },
        { index: 0, item: changed },
      ],
      [
        { index: 0, item: changed },
        { index: 1, item: changed },
      ],
    ])
      expect(() => mergeGroundedRepairs({ repairs }, draft, [0])).toThrow(
        "engine_output_invalid",
      );
    expect(() =>
      mergeGroundedRepairs(
        { repairs: [{ index: 2, item: changed }] },
        draft,
        [2],
      ),
    ).toThrow("engine_output_invalid");
    expect(() =>
      mergeGroundedRepairs(
        { repairs: [{ index: 0, item: changed }] },
        draft,
        [0, 0],
      ),
    ).toThrow("engine_output_invalid");
  });
  it("cannot complete a repair by deleting every feedback item", () => {
    const { draft } = fixture();
    try {
      mergeGroundedRepairs({ repairs: [{ index: 0, item: null }] }, draft, [0]);
      throw Error("unexpected success");
    } catch (error) {
      expect(error).toMatchObject({ validationReason: "report_repair_empty" });
    }
  });
  it("permits deleting only rejected items, without mutating original evidence", () => {
    const { draft } = fixture();
    draft.items.push(structuredClone(draft.items[0]!));
    const before = structuredClone(draft);
    expect(
      mergeGroundedRepairs({ repairs: [{ index: 0, item: null }] }, draft, [0])
        .items,
    ).toEqual([before.items[1]]);
    expect(draft).toEqual(before);
  });
});
describe("Codex v2 bounded verification", () => {
  it("sends all source and repairs a rejected semantic claim before returning", async () => {
    const { document, job, draft } = fixture();
    const bad = structuredClone(draft);
    bad.items[0]!.observation = "보고서 전체를 본인이 작성했습니다.";
    outputs([
      bad,
      { checks: [{ index: 0, supported: false, issue: "scope" }] },
      repairDraft(draft),
      { checks: [{ index: 0, supported: true, issue: "none" }] },
      { checks: [{ index: 0, supported: true, issue: "none" }] },
    ]);
    const report = await new CodexReasoner().report(
      document,
      job,
      [],
      [],
      new AbortController().signal,
    );
    expect(report.items[0]!.text).toContain("일정 항목");
    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(
      vi.mocked(runCommand).mock.calls.map(([call]) => call.timeoutMs),
    ).toEqual([120000, 120000, 120000, 120000, 120000]);
    expect(vi.mocked(runCommand).mock.calls[0]![0].input).toContain(
      "일정 항목을 직접 작성",
    );
    expect(vi.mocked(runCommand).mock.calls[2]![0].input).toContain(
      "rejected_indices",
    );
    const repair = JSON.parse(
      vi
        .mocked(runCommand)
        .mock.calls[2]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
    ) as {
      correction: { rejected_items: { index: number; item: unknown }[] };
      transitions?: unknown;
      questions?: unknown;
      units: unknown[];
    };
    expect(repair.correction.rejected_items[0]).toMatchObject({
      index: 0,
      item: bad.items[0],
    });
    expect(repair.transitions).toBeUndefined();
    expect(repair.questions).toBeUndefined();
    expect(repair.units).toHaveLength(document.units.length);
  });
  it("checks observation against only its own quotations, then gaps against all source", async () => {
    const { document, job, draft } = fixture();
    const ok = { checks: [{ index: 0, supported: true, issue: "none" }] };
    outputs([draft, ok, ok]);
    await new CodexReasoner().report(
      document,
      job,
      [],
      [],
      new AbortController().signal,
    );
    const payload = (i: number) =>
      JSON.parse(
        vi
          .mocked(runCommand)
          .mock.calls[i]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
      ) as { units?: unknown; items?: unknown };
    expect(payload(1)).toEqual({
      items: [
        {
          index: 0,
          observation: draft.items[0]!.observation,
          evidence: draft.items[0]!.evidence,
        },
      ],
    });
    expect(JSON.stringify(payload(1))).not.toContain(document.units[0]!.text);
    expect(payload(2).units).toHaveLength(2);
  });
  it("isolates different report items so another item's quotation cannot support a claim", async () => {
    const { document, job, draft } = fixture();
    draft.items.push({
      ...structuredClone(draft.items[0]!),
      observation: "팀이 행사 안내문을 작성했습니다.",
      evidence: [{ unit_id: "u1", quote: document.units[0]!.text }],
    });
    const ok = { checks: [{ index: 0, supported: true, issue: "none" }] };
    outputs([
      draft,
      ok,
      ok,
      {
        checks: [
          { index: 0, supported: true, issue: "none" },
          { index: 1, supported: true, issue: "none" },
        ],
      },
    ]);
    await new CodexReasoner().report(
      document,
      job,
      [],
      [],
      new AbortController().signal,
    );
    const calls = vi.mocked(runCommand).mock.calls;
    for (const [call] of calls.slice(1, 3)) {
      const payload = JSON.parse(
        call.input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
      ) as { items: { evidence: { quote: string }[] }[] };
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]!.evidence).toHaveLength(1);
      const quote = payload.items[0]!.evidence[0]!.quote;
      expect(call.input).not.toContain(
        document.units.find((u) => u.text !== quote)!.text,
      );
    }
    expect(calls).toHaveLength(4);
  });
  it("reuses exact approved citations across repair but always rechecks changed gaps against all source", async () => {
    const { document, job, draft } = fixture();
    const changedGap = structuredClone(draft);
    changedGap.items[0]!.gap = "작성 과정의 세부 설명은 없습니다.";
    const ok = { checks: [{ index: 0, supported: true, issue: "none" }] };
    const reject = {
      checks: [{ index: 0, supported: false, issue: "unsupported_absence" }],
    };
    const sequence = [changedGap, ok, reject, repairDraft(draft), ok];
    outputs([...sequence, ...sequence]);
    const reasoner = new CodexReasoner();
    for (let run = 0; run < 2; run++) {
      await reasoner.report(
        document,
        job,
        [],
        [],
        new AbortController().signal,
      );
      const calls = vi
        .mocked(runCommand)
        .mock.calls.slice(run * 5, (run + 1) * 5);
      expect(calls).toHaveLength(5); // cache never crosses a report invocation
      const lastPayload = JSON.parse(
        calls[4]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
      ) as { units: unknown[]; draft: unknown };
      expect(lastPayload.units).toHaveLength(2); // full-source audit still ran after repair
      expect(lastPayload.draft).toEqual(draft);
    }
    expect(runCommand).toHaveBeenCalledTimes(10);
  });
  it.each(["observation", "evidence"] as const)(
    "rechecks citations when the repaired %s changes",
    async (field) => {
      const { document, job, draft } = fixture();
      const repair = structuredClone(draft);
      if (field === "observation")
        repair.items[0]!.observation =
          "일정 항목을 본인이 썼다고 설명했습니다.";
      else
        repair.items[0]!.evidence[0]!.quote = "일정 항목을 직접 작성했습니다.";
      const ok = { checks: [{ index: 0, supported: true, issue: "none" }] };
      outputs([
        draft,
        ok,
        { checks: [{ index: 0, supported: false, issue: "other" }] },
        repairDraft(repair),
        ok,
        ok,
      ]);
      await new CodexReasoner().report(
        document,
        job,
        [],
        [],
        new AbortController().signal,
      );
      expect(runCommand).toHaveBeenCalledTimes(6);
      const payload = JSON.parse(
        vi
          .mocked(runCommand)
          .mock.calls[4]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
      ) as {
        items: { observation: string; evidence: unknown }[];
        units?: unknown[];
      };
      expect(payload.items[0]!.observation).toBe(repair.items[0]!.observation);
      expect(payload.items[0]!.evidence).toEqual(repair.items[0]!.evidence);
      expect(payload.units).toBeUndefined();
    },
  );
  it("preserves approved neighbors while repairing only the failed item", async () => {
    const { document, job, draft } = fixture();
    const good = structuredClone(draft.items[0]!);
    const bad = {
      ...structuredClone(good),
      observation: "문서 전체를 본인이 작성했다고 적었습니다.",
    };
    const team = {
      ...structuredClone(good),
      observation: "팀이 행사 안내문을 작성했습니다.",
      evidence: [{ unit_id: "u1", quote: document.units[0]!.text }],
    };
    vi.mocked(runCommand).mockImplementation(async ({ cwd, input }) => {
      const payload = JSON.parse(input.split("UNTRUSTED_DATA_JSON:\n")[1]!) as {
        repair_indices?: number[];
        items?: { observation: string }[];
        draft?: GroundedDraft;
      };
      const response = payload.repair_indices
        ? { repairs: [{ index: 0, item: team }] }
        : payload.draft
          ? {
              checks: payload.draft.items.map((_, index) => ({
                index,
                supported: true,
                issue: "none",
              })),
            }
          : payload.items
            ? {
                checks: [
                  {
                    index: 0,
                    supported:
                      payload.items[0]!.observation !== bad.observation,
                    issue:
                      payload.items[0]!.observation === bad.observation
                        ? "scope"
                        : "none",
                  },
                ],
              }
            : { items: [bad, good] };
      await writeOutput(cwd, input, response);
      return JSON.stringify({ type: "turn.completed" });
    });
    const report = await new CodexReasoner().report(
      document,
      job,
      [],
      [],
      new AbortController().signal,
    );
    expect(report.items.map((item) => item.text)).toEqual([
      team.observation,
      good.observation,
    ]);
    expect(runCommand).toHaveBeenCalledTimes(6);
    const payload = JSON.parse(
      vi
        .mocked(runCommand)
        .mock.calls[4]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
    ) as { items: { observation: string }[] };
    expect(payload.items[0]!.observation).toBe(team.observation);
  });
  it("does not accept an unchanged repair even if the identical citation input once passed", async () => {
    const { document, job, draft } = fixture();
    draft.items.push(structuredClone(draft.items[0]!));
    const ok = { checks: [{ index: 0, supported: true, issue: "none" }] };
    const reject = { checks: [{ index: 0, supported: false, issue: "actor" }] };
    let checks = 0;
    vi.mocked(runCommand).mockImplementation(async ({ cwd, input }) => {
      const payload = JSON.parse(input.split("UNTRUSTED_DATA_JSON:\n")[1]!) as {
        repair_indices?: number[];
        items?: unknown[];
      };
      const response = payload.repair_indices
        ? repairDraft(draft, payload.repair_indices)
        : payload.items
          ? ++checks === 1
            ? ok
            : reject
          : draft;
      await writeOutput(cwd, input, response);
      return JSON.stringify({ type: "turn.completed" });
    });
    await expect(
      new CodexReasoner().report(
        document,
        job,
        [],
        [],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      validationReason: "report_repair_unchanged",
    });
    expect(runCommand).toHaveBeenCalledTimes(4);
  });
  it("fails closed when the writer deletes the only rejected item", async () => {
    const { document, job, draft } = fixture();
    outputs([
      draft,
      { checks: [{ index: 0, supported: false, issue: "actor" }] },
      { repairs: [{ index: 0, item: null }] },
    ]);
    await expect(
      new CodexReasoner().report(
        document,
        job,
        [],
        [],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ validationReason: "report_unique_item_deleted" });
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
  it("removes a semantically redundant item while preserving the approved facts and rechecking full source", async () => {
    const { document, job, draft } = fixture();
    draft.items.push({
      ...structuredClone(draft.items[0]!),
      observation: "본인이 쓴 범위는 일정 항목으로 설명되어 있습니다.",
    });
    const ok = { checks: [{ index: 0, supported: true, issue: "none" }] };
    outputs([
      draft,
      ok,
      ok,
      {
        checks: [
          { index: 0, supported: true, issue: "none" },
          { index: 1, supported: false, issue: "duplicate" },
        ],
      },
      { repairs: [{ index: 1, item: null }] },
      ok,
    ]);
    const report = await new CodexReasoner().report(
      document,
      job,
      [],
      [],
      new AbortController().signal,
    );
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.text).toBe(draft.items[0]!.observation);
    expect(runCommand).toHaveBeenCalledTimes(6);
    const payload = JSON.parse(
      vi
        .mocked(runCommand)
        .mock.calls[5]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
    ) as { units: unknown[]; draft: GroundedDraft };
    expect(payload.units).toHaveLength(2);
    expect(payload.draft.items).toHaveLength(1);
  });
  it("stops assigning queued citation checks after a permanent failure and awaits started work", async () => {
    const { document, job, draft } = fixture();
    draft.items = Array.from({ length: 5 }, () =>
      structuredClone(draft.items[0]!),
    );
    let calls = 0;
    let releaseBoth!: () => void;
    let releaseFailure!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const failureObserved = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let activeCheckFinished = false;
    vi.mocked(runCommand).mockImplementation(async ({ cwd }) => {
      const call = calls++;
      if (call === 0) {
        await writeFile(join(cwd, "output.json"), JSON.stringify(draft));
      } else if (call === 1) {
        await bothStarted;
        throw new LabError("engine_unavailable", 503);
      } else {
        releaseBoth();
        await failureObserved;
        await writeFile(
          join(cwd, "output.json"),
          JSON.stringify({
            checks: [{ index: 0, supported: true, issue: "none" }],
          }),
        );
        activeCheckFinished = true;
      }
      return JSON.stringify({ type: "turn.completed" });
    });
    const reasoner = new CodexReasoner(
      undefined,
      undefined,
      120000,
      "low",
      (event) => {
        if (event.outcome === "engine_unavailable") releaseFailure();
      },
    );
    await expect(
      reasoner.report(document, job, [], [], new AbortController().signal),
    ).rejects.toMatchObject({ code: "engine_unavailable" });
    expect(calls).toBe(3); // writer + only the two already started checks
    expect(activeCheckFinished).toBe(true);
  });
  it("repairs an unfinished sentence instead of exposing or truncating it", async () => {
    const { document, job, draft } = fixture();
    const unfinished = structuredClone(draft);
    unfinished.items[0]!.observation = "행사 날짜와 장소의";
    const ok = { checks: [{ index: 0, supported: true, issue: "none" }] };
    outputs([unfinished, draft, ok, ok]);
    const report = await new CodexReasoner().report(
      document,
      job,
      [],
      [],
      new AbortController().signal,
    );
    expect(report.items[0]!.text).toBe(draft.items[0]!.observation);
    const repair = JSON.parse(
      vi
        .mocked(runCommand)
        .mock.calls[1]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
    ) as { correction: unknown };
    expect(repair.correction).toMatchObject({
      error: "report_sentence_unfinished",
      details: { item_index: 0, fields: ["observation"] },
      rejected_draft: unfinished,
    });
  });
  it("fails closed after the second rejected draft without extra calls", async () => {
    const { document, job, draft } = fixture();
    const reject = { checks: [{ index: 0, supported: false, issue: "actor" }] };
    const changed = structuredClone(draft);
    changed.items[0]!.observation =
      "일정 항목은 본인이 작성한 것으로 설명했습니다.";
    outputs([draft, reject, repairDraft(changed), reject]);
    await expect(
      new CodexReasoner().report(
        document,
        job,
        [],
        [],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      validationReason: "grounded_report_verification_failed",
    });
    expect(runCommand).toHaveBeenCalledTimes(4);
  });
  it("repairs a real note/citation mismatch with the failed item and required source", async () => {
    const { document, job, draft } = fixture();
    const first = document.units[0]!;
    const note: Note = {
      id: "n1",
      unit_id: first.id,
      kind: "question",
      text: "본인이 작성한 부분은 무엇인가요?",
      span: { block_id: first.block_id, start: first.start, end: first.end },
      evidence_unit_ids: [first.id],
      requirement_ids: ["r1"],
      review_required: true,
    };
    const bad = structuredClone(draft);
    bad.items[0]!.note_ids = ["n1"];
    const repaired = structuredClone(bad);
    repaired.items[0]!.evidence.push({ unit_id: first.id, quote: first.text });
    outputs([
      bad,
      repaired,
      { checks: [{ index: 0, supported: true, issue: "none" }] },
      { checks: [{ index: 0, supported: true, issue: "none" }] },
    ]);
    const report = await new CodexReasoner().report(
      document,
      job,
      [note],
      [],
      new AbortController().signal,
    );
    expect(report.items[0]!.citations.map((c) => c.unit_id)).toEqual([
      "u2",
      "u1",
    ]);
    expect(runCommand).toHaveBeenCalledTimes(4);
    const repair = JSON.parse(
      vi
        .mocked(runCommand)
        .mock.calls[1]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
    ) as { correction: unknown };
    expect(repair.correction).toEqual({
      error: "report_note_quote_unlinked",
      rejected_draft: bad,
      details: {
        item_index: 0,
        unlinked_notes: [{ note_id: "n1", required_unit_ids: ["u1"] }],
      },
    });
  });
  it("repairs internal IDs and status instructions in user-facing prose", async () => {
    const { document, job, draft } = fixture();
    const bad = structuredClone(draft);
    bad.items[0]!.suggestion = "q1을 held로 유지하세요.";
    outputs([
      bad,
      draft,
      { checks: [{ index: 0, supported: true, issue: "none" }] },
      { checks: [{ index: 0, supported: true, issue: "none" }] },
    ]);
    const report = await new CodexReasoner().report(
      document,
      job,
      [],
      [],
      new AbortController().signal,
    );
    expect(report.items[0]!.reason).not.toContain("held");
    expect(runCommand).toHaveBeenCalledTimes(4);
  });
  it("does not accept a semantic audit that omitted an item", async () => {
    const { document, job, draft } = fixture();
    outputs([draft, { checks: [] }, draft, { checks: [] }]);
    await expect(
      new CodexReasoner().report(
        document,
        job,
        [],
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow("engine_output_invalid");
  });
  it("rejects a rubric that changes the posting meaning even when quotes exist", async () => {
    outputs([
      {
        requirements: [
          { kind: "required", label: "안내문 작성", quote: "안내문 작성" },
        ],
      },
      {
        criteria: [
          {
            requirement_id: "r1",
            checks: [
              {
                facet: "role",
                trigger: "역할",
                sufficient: "직접 작성",
                insufficient: "팀만 작성",
              },
            ],
          },
        ],
      },
      { valid: false, issues: ["공고의 우대를 필수로 바꿨습니다."] },
    ]);
    await expect(
      new CodexReasoner().profile(
        "우대: 안내문 작성",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      validationReason: "profile_semantic_review_failed",
    });
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
});

describe("whole posting coverage", () => {
  it("repairs duplicate quotes once against the full posting and still performs the semantic audit", async () => {
    const text = "담당 업무: 문의 분류와 처리 절차 안내.";
    const duplicate = {
      requirements: [
        {
          kind: "duty",
          label: "문의 분류",
          quote: "문의 분류와 처리 절차 안내",
        },
        {
          kind: "duty",
          label: "절차 안내",
          quote: "문의 분류와 처리 절차 안내",
        },
      ],
    };
    const corrected = {
      requirements: [
        { kind: "duty", label: "문의 분류", quote: "문의 분류" },
        { kind: "duty", label: "절차 안내", quote: "처리 절차 안내" },
      ],
    };
    outputs([
      duplicate,
      corrected,
      checksFor([{ id: "r1" }, { id: "r2" }]),
      { valid: false, issues: ["조건이 공고보다 강합니다."] },
    ]);
    await expect(
      new CodexReasoner().profile(text, new AbortController().signal),
    ).rejects.toMatchObject({
      validationReason: "profile_semantic_review_failed",
    });
    expect(runCommand).toHaveBeenCalledTimes(4);
    const retry: unknown = JSON.parse(
      vi
        .mocked(runCommand)
        .mock.calls[1]![0].input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
    );
    expect(retry).toEqual({
      job_text: text,
      validation_correction: "profile_quote_duplicate",
    });
    vi.mocked(runCommand).mockReset();
    outputs([duplicate, duplicate]);
    await expect(
      new CodexReasoner().profile(text, new AbortController().signal),
    ).rejects.toMatchObject({ validationReason: "profile_quote_duplicate" });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
  const posting = (n: number) => {
    const requirements = Array.from({ length: n }, (_, i) => ({
      kind: "preferred",
      label: `도구 ${i + 1}`,
      quote: `도구 ${i + 1} 사용 경험.`,
    }));
    return { requirements, text: requirements.map((r) => r.quote).join("\n") };
  };
  const checksFor = (requirements: { id: string }[]) => ({
    criteria: requirements.map((r) => ({
      requirement_id: r.id,
      checks: [
        {
          facet: "role",
          trigger: "실제 경험 주장",
          sufficient: "직접 수행한 부분",
          insufficient: "타인의 업무만 서술",
        },
      ],
    })),
  });
  it("keeps the last of 64 items with exact offsets and rejects overflow or fabricated quotes", () => {
    const f = posting(MAX_JOB_REQUIREMENTS);
    const job = validateProfile({ requirements: f.requirements }, f.text);
    expect(job.requirements).toHaveLength(64);
    expect(
      job.text.slice(job.requirements[63]!.start, job.requirements[63]!.end),
    ).toBe(f.requirements[63]!.quote);
    expect(
      validateReaderProfile(checksFor(job.requirements), job).criteria,
    ).toHaveLength(64);
    const overflow = posting(65);
    expect(() =>
      validateProfile({ requirements: overflow.requirements }, overflow.text),
    ).toThrowError(
      expect.objectContaining({ validationReason: "profile_schema_invalid" }),
    );
    f.requirements[63]!.quote = "원문에 없는 필수 경험";
    expect(() =>
      validateProfile({ requirements: f.requirements }, f.text),
    ).toThrowError(
      expect.objectContaining({ validationReason: "profile_quote_missing" }),
    );
  });
  it("compiles every assigned criterion in ordered batches, with full scope and at most two calls active", async () => {
    const f = posting(19);
    const context = {
      kind: "other",
      label: "인턴 범위",
      quote: "위 업무의 보조 및 일부 기능 개발을 담당합니다.",
    };
    const text = f.text + "\n" + context.quote;
    let active = 0,
      peak = 0,
      compiled = 0;
    vi.mocked(runCommand).mockImplementation(async ({ cwd, input }) => {
      const data = JSON.parse(input.split("UNTRUSTED_DATA_JSON:\n")[1]!) as {
        requirements?: { id: string; kind: string }[];
        job_text?: string;
        reader_profile?: { criteria: unknown[] };
      };
      let result;
      if (!data.requirements)
        result = { requirements: [...f.requirements, context] };
      else if (data.reader_profile) {
        expect(data.reader_profile.criteria).toHaveLength(19);
        result = { valid: true, issues: [] };
      } else {
        expect(data.job_text).toBe(text);
        expect(data.requirements.length).toBeLessThanOrEqual(8);
        expect(
          data.requirements.every((r: { kind: string }) => r.kind !== "other"),
        ).toBe(true);
        active++;
        peak = Math.max(peak, active);
        compiled++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        result = checksFor(data.requirements);
      }
      await writeOutput(cwd, input, result);
      return JSON.stringify({ type: "turn.completed" });
    });
    const job = await new CodexReasoner().profile(
      text,
      new AbortController().signal,
    );
    expect(peak).toBe(2);
    expect(compiled).toBe(3);
    expect(active).toBe(0);
    expect(job.requirements).toHaveLength(20);
    expect(job.reader_profile!.criteria.map((c) => c.requirement_id)).toEqual(
      job.requirements.slice(0, 19).map((r) => r.id),
    );
    expect(runCommand).toHaveBeenCalledTimes(5);
  });
  it("preserves the original batch failure and waits for sibling cancellation before returning", async () => {
    const f = posting(17);
    let secondStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let cleaned = false;
    vi.mocked(runCommand).mockImplementation(async ({ cwd, input, signal }) => {
      const data = JSON.parse(input.split("UNTRUSTED_DATA_JSON:\n")[1]!) as {
        requirements?: { id: string; kind: string }[];
        job_text?: string;
        reader_profile?: { criteria: unknown[] };
      };
      if (!data.requirements) {
        await writeOutput(cwd, input, { requirements: f.requirements });
        return JSON.stringify({ type: "turn.completed" });
      }
      if (data.requirements[0]!.id === "r1") {
        await bothStarted;
        await writeOutput(cwd, input, { criteria: [] });
        return JSON.stringify({ type: "turn.completed" });
      }
      secondStarted();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleaned = true;
      throw new LabError("cancelled");
    });
    await expect(
      new CodexReasoner().profile(f.text, new AbortController().signal),
    ).rejects.toMatchObject({ validationReason: "reader_criterion_missing" });
    expect(cleaned).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
  it("still rejects whole-posting coverage omissions and does not compile context as a skill", async () => {
    const f = posting(10);
    const requirements = f.requirements.slice(0, 9);
    vi.mocked(runCommand).mockImplementation(async ({ cwd, input }) => {
      const payload = JSON.parse(input.split("UNTRUSTED_DATA_JSON:\n")[1]!) as {
        requirements?: { id: string; kind: string }[];
        job_text?: string;
        reader_profile?: { criteria: unknown[] };
      };
      const value = !payload.requirements
        ? { requirements }
        : payload.reader_profile
          ? { valid: false, issues: ["마지막 우대 항목이 누락되었습니다."] }
          : checksFor(payload.requirements);
      await writeOutput(cwd, input, value);
      return JSON.stringify({ type: "turn.completed" });
    });
    await expect(
      new CodexReasoner().profile(f.text, new AbortController().signal),
    ).rejects.toMatchObject({
      validationReason: "profile_semantic_review_failed",
    });
  });
  it("logs only fixed preparation reasons, excluding model issues and arbitrary exception strings", () => {
    expect(
      preparationFailureReason(
        new LabError(
          "engine_output_invalid",
          503,
          "profile_semantic_review_failed",
          { source: "PRIVATE" },
        ),
      ),
    ).toBe("profile_semantic_review_failed");
    expect(
      preparationFailureReason(new LabError("PRIVATE", 503, "PRIVATE")),
    ).toBe("preparation_failed");
    expect(preparationFailureReason(new Error("PRIVATE"))).toBe(
      "preparation_failed",
    );
  });
});
