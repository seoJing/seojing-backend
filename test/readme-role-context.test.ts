import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CodexReasoner,
  validateProfile,
} from "../src/services/readme-lab/codex.js";
import { validateReaderProfile } from "../src/services/readme-lab/profile.js";
import { validateRoleContext } from "../src/services/readme-lab/role-context.js";
import { runCommand } from "../src/services/readme-lab/process.js";
import type { SemanticInput } from "../src/services/readme-lab/semantic-reader.js";
import { LabError } from "../src/services/readme-lab/errors.js";

vi.mock("../src/services/readme-lab/process.js", () => ({
  runCommand: vi.fn(),
}));
afterEach(() => vi.mocked(runCommand).mockReset());
function fixture() {
  const job = validateProfile(
    {
      requirements: [{ kind: "duty", label: "자막 검수", quote: "자막 검수" }],
    },
    "자막 검수",
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
              sufficient: "본인 업무",
              insufficient: "계획만 있음",
            },
          ],
        },
      ],
    },
    job,
  );
  const texts = [
    "자막 제작에 참여했습니다.",
    "맞춤법 검수는 제가 맡을 예정이었습니다.",
    "제가 직접 이 작업을 마쳤습니다.",
  ];
  const input: SemanticInput = {
    job,
    prefix: texts.map((text, i) => ({
      id: `u${i + 1}`,
      block_id: `b${i + 1}`,
      order: i,
      start: 0,
      end: text.length,
      text,
      scope_id: `s${i + 1}`,
    })),
    notes: [],
    questions: [
      {
        id: "q1",
        unit_id: "u1",
        scope_id: "s1",
        criterion_id: "c_r1",
        facet: "role",
        text: "본인이 수행한 업무는 무엇인가요?",
        label: "본인 역할",
        status: "open",
        candidate_unit_ids: [],
        evidence_unit_ids: [],
      },
    ],
  };
  const draft = {
    verdict: "complete" as const,
    task: "맞춤법 검수",
    actor: "applicant" as const,
    modality: "performed" as const,
    task_unit_ids: ["u2"],
    performance_unit_ids: ["u3"],
    evidence: input.prefix
      .slice(1)
      .map((u) => ({ unit_id: u.id, quote: u.text })),
  };
  const audit = {
    same_experience: true,
    same_task: true,
    applicant_performed: true,
    not_retracted: true,
    evidence_sufficient: true,
    issues: [],
  };
  return { input, draft, audit };
}
function outputs(values: unknown[]) {
  vi.mocked(runCommand).mockImplementation(async ({ cwd }) => {
    if (!values.length) throw new Error("unexpected_call");
    await writeFile(join(cwd, "output.json"), JSON.stringify(values.shift()));
    return JSON.stringify({ type: "turn.completed" });
  });
}
describe("bounded role-context confirmation", () => {
  it("retains task and performed links across structural scopes with exact prefix citations", async () => {
    const { input, draft, audit } = fixture();
    outputs([draft, audit]);
    const result = await new CodexReasoner().reassessRole(
      input,
      "q1",
      new AbortController().signal,
    );
    expect(result).toEqual(draft);
    expect(runCommand).toHaveBeenCalledTimes(2);
    for (const [call] of vi.mocked(runCommand).mock.calls) {
      const payload = JSON.parse(
        call.input.split("UNTRUSTED_DATA_JSON:\n")[1]!,
      ) as { units: { id: string }[] };
      expect(payload.units.map((u: { id: string }) => u.id)).toEqual([
        "u1",
        "u2",
        "u3",
      ]);
      expect(payload).not.toHaveProperty("expected_state");
    }
  });
  it.each([
    "same_experience",
    "same_task",
    "applicant_performed",
    "not_retracted",
    "evidence_sufficient",
  ])("rejects an exact quote whose %s semantic audit fails", async (field) => {
    const { input, draft, audit } = fixture();
    outputs([draft, { ...audit, [field]: false }]);
    expect(
      await new CodexReasoner().reassessRole(
        input,
        "q1",
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
  it("never repairs or retries a timed out reassessment", async () => {
    const { input } = fixture();
    vi.mocked(runCommand).mockRejectedValue(
      new LabError("engine_timeout", 503),
    );
    await expect(
      new CodexReasoner().reassessRole(
        input,
        "q1",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "engine_timeout" });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it("rejects fabricated/future/missing linkage and plans before auditing", () => {
    const { input, draft } = fixture();
    for (const altered of [
      { ...draft, evidence: [{ unit_id: "u4", quote: "미래 문장" }] },
      { ...draft, evidence: [{ unit_id: "u3", quote: "변형한 문장" }] },
      { ...draft, task_unit_ids: ["u1"] },
      { ...draft, performance_unit_ids: [] },
      { ...draft, modality: "planned" },
      { ...draft, evidence: [...draft.evidence, draft.evidence[0]] },
    ])
      expect(() => validateRoleContext(altered, input, "q1")).toThrow(
        "engine_output_invalid",
      );
  });
});
