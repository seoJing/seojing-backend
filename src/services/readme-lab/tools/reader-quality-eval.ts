/** Synthetic development comparison, never a human-reviewed promotion gate. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { CodexReasoner, validateProfile } from "../codex.js";
import { openLaya } from "../laya.js";
import { buildDocument, textBlocks } from "../document.js";
import { validateReaderProfile } from "../profile.js";
import type { Note, Question, ReaderCheck } from "../contracts.js";

const datasetSchema = z.object({
  synthetic: z.literal(true),
  human_reviewed: z.literal(false),
  label_status: z.literal("provisional_agent_authored"),
  cases: z.array(
    z.object({
      id: z.string(),
      group: z.string(),
      text: z.string(),
      facet: z.enum(["role", "method", "result", "basis"]),
      expected: z.array(
        z.enum(["complete", "partial", "conflict", "unrelated", "unknown"]),
      ),
      question: z.string(),
      sufficient: z.string(),
      insufficient: z.string(),
      previously_resolved: z.boolean().optional(),
    }),
  ),
});
const path = resolve("test/fixtures/readme/reader-prefix-cases.json");
const source = await readFile(path, "utf8");
const dataset = datasetSchema.parse(JSON.parse(source));
const out = resolve(
  process.argv[2] ?? ".local/readme-laya/reader-v2-eval-20261004",
);
await mkdir(out);
const controller = new AbortController();
const reasoner = new CodexReasoner(
  process.env.README_CODEX_BIN,
  process.env.README_CODEX_MODEL,
);
const classifier = await openLaya(controller.signal);
const rows: unknown[] = [];
try {
  for (const fixture of dataset.cases) {
    const document = buildDocument(textBlocks(fixture.text), "txt");
    const current = document.units.at(-1)!;
    const question: Question = {
      id: "q1",
      unit_id: document.units[0]!.id,
      scope_id: current.scope_id,
      text: fixture.question,
      facet: fixture.facet,
      status: fixture.previously_resolved ? "resolved" : "open",
      candidate_unit_ids: [],
      evidence_unit_ids: fixture.previously_resolved
        ? [document.units[1]!.id]
        : [],
    };
    const check: ReaderCheck = {
      facet: fixture.facet,
      trigger: fixture.question,
      sufficient: fixture.sufficient,
      insufficient: fixture.insufficient,
    };
    const layaInput = {
      question: question.text,
      sufficient: check.sufficient,
      insufficient: check.insufficient,
      original: document.units[0]!.text,
      current: current.text,
      evidence: document.units.slice(1, -1).map((u) => u.text),
    };
    const started = Date.now();
    const laya = await classifier.predict("reader_relation", layaInput);
    const layaMs = Date.now() - started;
    const codexStarted = Date.now();
    const codex = await reasoner.verifyReading(
      { question, check, prefix: document.units, current, relation: "partial" },
      controller.signal,
    );
    const codexMs = Date.now() - codexStarted;
    const layaVerdict =
      laya.scope!.label === "different" && laya.scope!.confidence >= 0.75
        ? "unrelated"
        : laya.scope!.label === "same" &&
            laya.scope!.confidence >= 0.75 &&
            laya.relation!.confidence >= 0.75
          ? laya.relation!.label
          : "unknown";
    const row = {
      id: fixture.id,
      expected: fixture.expected,
      laya,
      laya_policy_candidate: layaVerdict,
      laya_match: fixture.expected.includes(
        layaVerdict as (typeof fixture.expected)[number],
      ),
      codex,
      codex_match: fixture.expected.includes(codex.verdict),
      laya_ms: layaMs,
      codex_ms: codexMs,
      laya_input: layaInput,
      document,
      question,
      check,
    };
    rows.push(row);
    await writeFile(
      resolve(out, `${fixture.id}.json`),
      JSON.stringify(row, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        case: fixture.id,
        laya: layaVerdict,
        codex: codex.verdict,
        codex_ms: codexMs,
      }),
    );
  }
} finally {
  classifier.close();
}

// Compare the exact same source and original question-only note. V1 cannot see
// the later evidence; V2 performs an explicit final source review without rewriting q1.
const document = buildDocument(
  textBlocks(
    "행사 운영에 기여했습니다. 저는 이 행사에서 참가자 일정표를 작성하고 안내문을 직접 배포했습니다. 실제 고객 서비스 운영 경험을 주장하는 것은 아닙니다.",
  ),
  "txt",
);
const job = validateProfile(
  {
    requirements: [
      {
        kind: "duty",
        label: "행사 일정·안내",
        quote: "행사 일정 조정과 안내문 작성",
      },
    ],
  },
  "담당업무: 행사 일정 조정과 안내문 작성",
);
const question: Question = {
  id: "q1",
  unit_id: "u1",
  scope_id: "b1",
  text: "행사에서 본인이 맡은 역할은 무엇인가요?",
  status: "held",
  candidate_unit_ids: [],
};
const notes: Note[] = [
  {
    id: "n1",
    unit_id: "u1",
    span: {
      block_id: "b1",
      start: document.units[0]!.start,
      end: document.units[0]!.end,
    },
    kind: "question",
    text: question.text,
    question_id: "q1",
    evidence_unit_ids: ["u1"],
    requirement_ids: ["r1"],
    review_required: true,
  },
];
const before = await reasoner.report(
  document,
  job,
  notes,
  [question],
  controller.signal,
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
            sufficient: "본인의 담당 업무",
            insufficient: "팀 성과만 설명",
          },
        ],
      },
    ],
  },
  job,
);
const after = await reasoner.report(
  document,
  job,
  notes,
  [question],
  controller.signal,
);
await writeFile(
  resolve(out, "report-comparison.json"),
  JSON.stringify(
    {
      synthetic: true,
      human_reviewed: false,
      document,
      job,
      notes,
      question,
      before,
      after,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  resolve(out, "run.json"),
  JSON.stringify(
    {
      synthetic: true,
      human_reviewed: false,
      production_approved: false,
      dataset_sha256: createHash("sha256").update(source).digest("hex"),
      model: classifier.metadata,
      requested_codex_model: reasoner.model,
      resolved_codex_model: null,
      effort: "low",
      rows,
      limitations: [
        "Provisional agent-authored labels, single run, no independent human accuracy.",
        "Laya and Codex see the same source prefix/check conditions, in engine-specific serialization.",
        "Laya policy candidates are not production resolved states; verifier is offline.",
        "Comparison changes report source packing/prompt/validation together; it does not isolate model capability.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    complete: true,
    cases: rows.length,
    before_items: before.items.length,
    after_items: after.items.length,
  }),
);
