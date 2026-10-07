/** Synthetic actual Jev trace -> validated ledger -> actual Codex source report. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { CodexReasoner } from "../codex.js";
import { validateFocusStep, type FocusLedger } from "../focus-contract.js";
import { focusReportState } from "../focus-report.js";
import { errorCode } from "../errors.js";
import type { ResumeDocument, Unit } from "../contracts.js";

const arg = (key: string) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
if (
  !process.argv.includes("--allow-remote-synthetic") ||
  !arg("trace") ||
  !arg("out") ||
  !arg("config")
)
  throw new Error("explicit_synthetic_arguments_required");
const raw = await readFile(arg("trace")!, "utf8");
const trace = JSON.parse(raw) as {
  synthetic_input: { id: string; units: string[]; role_context: string };
  trace: unknown[];
  metrics: object;
  error: string | null;
};
if (
  !trace.synthetic_input ||
  !Array.isArray(trace.synthetic_input.units) ||
  !Array.isArray(trace.trace) ||
  trace.error
)
  throw new Error("completed_synthetic_trace_required");
const config = JSON.parse(await readFile(arg("config")!, "utf8")) as Record<
  string,
  string
>;
const out = resolve(arg("out")!);
await mkdir(out, { recursive: false });
const save = (name: string, value: unknown) =>
  writeFile(resolve(out, name), JSON.stringify(value, null, 2) + "\n");
let scope = 0;
const units: Unit[] = trace.synthetic_input.units.map((text, i) => {
  if (text.startsWith("#")) scope++;
  return {
    id: `u${i + 1}`,
    block_id: `b${i + 1}`,
    order: i,
    scope_id: `s${scope}`,
    start: 0,
    end: text.length,
    text,
  };
});
const document: ResumeDocument = {
  doc_id: "synthetic-focus",
  source_kind: "md",
  units,
  blocks: units.map((u) => ({
    id: u.block_id,
    type: u.text.startsWith("#") ? "heading" : "paragraph",
    text: u.text,
    unit_ids: [u.id],
  })),
  warnings: [],
  truncated: false,
};
const ledger: FocusLedger = {
  version: "focus-reader-v1",
  steps: [],
  questions: [],
  units: [],
  complete: false,
};
for (let i = 0; i < trace.trace.length; i++)
  validateFocusStep(trace.trace[i], units.slice(0, i + 1), ledger);
ledger.complete = trace.trace.length === document.units.length;
const jobText =
  "업무: 웹 서비스 기능 개발과 운영 문제 해결. 필수: 본인이 수행한 개발 업무를 설명할 수 있는 경험. 우대: 서비스 개선의 결과와 비교 근거를 설명할 수 있는 경험.";
const started = Date.now();
const attempts: object[] = [];
const reasoner = new CodexReasoner(
  config.README_CODEX_BIN || "/opt/homebrew/bin/codex",
  config.README_CODEX_MODEL,
  120000,
  "low",
  (e) => {
    attempts.push(e);
    console.log(JSON.stringify({ stage: "codex_attempt", ...e }));
  },
);
const signal = AbortSignal.timeout(10 * 60 * 1000);
try {
  const job = await reasoner.profile(jobText, signal);
  await save("prepared.json", {
    synthetic: true,
    document,
    job,
    trace_sha256: createHash("sha256").update(raw).digest("hex"),
  });
  console.log(
    JSON.stringify({
      stage: "profile_completed",
      elapsed_ms: Date.now() - started,
    }),
  );
  const { notes, questions, memory } = focusReportState(document, job, ledger);
  const report = await reasoner.report(
    document,
    job,
    notes,
    questions,
    signal,
    memory,
  );
  await save("report.json", {
    synthetic: true,
    report,
    jev_metrics: trace.metrics,
    codex_attempts: attempts,
    elapsed_ms: Date.now() - started,
  });
  const lines = [
    "# 의문 중심 독해 · 실제 모델 검증본",
    "",
    "합성 이력서입니다. Jev의 실제 독해 기록을 검증한 뒤 GPT가 전체 원문과 모집 요건을 다시 대조했습니다.",
    "",
    "## 최종 보고서",
    "",
    ...report.items.flatMap((item) => [
      "### " + item.text,
      "",
      item.reason,
      "",
      "원문: " + item.citations.map((c) => c.unit_id).join(", "),
      "",
    ]),
    "## 남은 의문",
    "",
    ...questions.map((q) => `- ${q.text} (${q.status}, 원문 ${q.unit_id})`),
    "",
    "## 원문",
    "",
    ...units.map((u) => `**${u.id}** ${u.text}\n`),
    "## 검증 범위",
    "",
    ...report.limitations.map((t) => "- " + t),
    "",
    "프로덕션 배포와 프런트 연결 여부는 이 모델 검증과 별개입니다.",
  ];
  await writeFile(resolve(out, "REPORT.md"), lines.join("\n"));
  console.log(
    JSON.stringify({
      stage: "completed",
      items: report.items.length,
      elapsed_ms: Date.now() - started,
    }),
  );
} catch (error) {
  await save("failed.json", {
    error: errorCode(error),
    attempts,
    elapsed_ms: Date.now() - started,
  });
  console.log(JSON.stringify({ stage: "failed", error: errorCode(error) }));
  process.exitCode = 1;
}
