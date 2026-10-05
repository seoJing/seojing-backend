/** Synthetic diagnostic only: current CLI prompts, no training or serving changes. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodexReasoner, validateProfile } from "../codex.js";
import { buildDocument, textBlocks } from "../document.js";
import type { Note, Question } from "../contracts.js";

const reasoner = new CodexReasoner(
  process.env.README_CODEX_BIN,
  process.env.README_CODEX_MODEL,
);
const directory = resolve(
  process.argv[2] ?? ".local/readme-laya/codex-quality-20261004",
);
await mkdir(directory); // Refuse to overwrite an earlier diagnostic run.
const profiles = [
  {
    id: "benefits-not-requirements",
    text: "지역 프로그램 운영 담당자를 모집합니다. 담당 업무는 참여자 일정 조정과 안내문 작성입니다. 경력은 무관합니다. 점심 식사와 교육비를 제공합니다.",
    expected:
      "담당 업무를 추출하고, 식사·교육비를 요건으로 만들지 않음. 경력 무관을 경력 필요로 뒤집지 않음.",
  },
  {
    id: "required-versus-preferred",
    text: "담당 업무: Java 서버 API 개발. 필수: Java를 이용한 개발 경험. 우대: 운영 서비스의 성능 개선 경험. 자격증은 필수가 아닙니다.",
    expected:
      "Java 개발 경험은 필수, 성능 개선은 우대. 자격증을 필수로 추출하지 않음.",
  },
  {
    id: "empty-job",
    text: "함께 배우며 성장할 동료를 찾습니다. 자세한 업무와 지원 자격은 추후 안내합니다.",
    expected: "불충분한 공고에서 기술·경력 기준을 임의 생성하지 않음.",
  },
];
for (const fixture of profiles) {
  const started = Date.now();
  const result = await reasoner.profile(
    fixture.text,
    new AbortController().signal,
  );
  await writeFile(
    resolve(directory, `${fixture.id}.json`),
    JSON.stringify(
      {
        synthetic: true,
        human_reviewed: false,
        ...fixture,
        result,
        elapsed_ms: Date.now() - started,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      case: fixture.id,
      requirements: result.requirements.length,
    }),
  );
}
const reports = [
  {
    id: "test-users-are-not-real-users",
    source:
      "제가 k6로 가상 사용자 500명의 요청을 보내는 부하 테스트를 실행했습니다. 실제 고객을 대상으로 운영한 서비스는 아닙니다.",
    note: "가상 사용자 500명으로 수행한 부하 테스트의 구체적인 행동이 적혀 있습니다. 실제 고객 운영 경험은 확인되지 않았습니다.",
    kind: "evidence" as const,
    expected:
      "가상 사용자를 실제 고객으로 바꾸지 않고, 부하 테스트를 운영 서비스 경력으로 확정하지 않음.",
  },
  {
    id: "question-is-not-a-fact",
    source: "우리 팀이 행사 보고서를 작성했습니다.",
    note: "팀 보고서에서 본인이 직접 작성한 부분은 어디인가요?",
    kind: "question" as const,
    expected:
      "질문을 개인 담당 업무가 확인됐다는 긍정 사실로 바꾸지 않고, 문서의 미설명을 실제 능력 부족으로 단정하지 않음.",
  },
];
for (const fixture of reports) {
  const document = buildDocument(textBlocks(fixture.source), "txt");
  const unit = document.units[0]!;
  const notes: Note[] = [
    {
      id: "n1",
      unit_id: unit.id,
      span: { block_id: unit.block_id, start: unit.start, end: unit.end },
      kind: fixture.kind,
      text: fixture.note,
      evidence_unit_ids: document.units.map((u) => u.id),
      requirement_ids: [],
      review_required: true,
      ...(fixture.kind === "question" ? { question_id: "q1" } : {}),
    },
  ];
  const questions: Question[] =
    fixture.kind === "question"
      ? [
          {
            id: "q1",
            unit_id: unit.id,
            scope_id: unit.scope_id,
            text: fixture.note,
            status: "open_at_end",
            candidate_unit_ids: [],
          },
        ]
      : [];
  const started = Date.now();
  const result = await reasoner.report(
    document,
    validateProfile({ requirements: [] }, "담당 업무는 추후 안내합니다."),
    notes,
    questions,
    new AbortController().signal,
  );
  await writeFile(
    resolve(directory, `${fixture.id}.json`),
    JSON.stringify(
      {
        synthetic: true,
        human_reviewed: false,
        ...fixture,
        document,
        notes,
        questions,
        result,
        elapsed_ms: Date.now() - started,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ case: fixture.id, report_items: result.items.length }),
  );
}
await writeFile(
  resolve(directory, "run.json"),
  JSON.stringify(
    {
      synthetic: true,
      production_approved: false,
      codex_binary: process.env.README_CODEX_BIN ?? "/opt/homebrew/bin/codex",
      requested_model: reasoner.model,
      resolved_model: null,
      reasoning_effort: "low",
      limitation:
        "Current serving prompt sanity checks only; no independent human review, repeated trials, or comparison to a stronger prompt/effort. CLI default does not identify a pinned resolved model.",
    },
    null,
    2,
  ) + "\n",
);
