/** Explicit synthetic live integration probe. Key is process memory only. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CodexReasoner } from "../codex.js";
import { parseDocument } from "../parser.js";
import { readJevDocument } from "../jev-pipeline.js";
import { errorCode } from "../errors.js";
import type { EventPayload } from "../contracts.js";

if (!process.argv.includes("--allow-remote-synthetic"))
  throw new Error("explicit_remote_flag_required");
const outArg = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
if (!outArg) throw new Error("output_directory_required");
const out = resolve(outArg);
await mkdir(out, { recursive: false });
const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("jev_key_missing");
const fixture = JSON.parse(
  await readFile("test/fixtures/readme/jev-stream-v1.json", "utf8"),
) as { synthetic: boolean; units: string[] };
if (!fixture.synthetic) throw new Error("synthetic_only");
const short = process.argv.includes("--short");
let text = short
  ? "시립 체험관 방문객 안내에 참여했습니다. 제가 방문객 예약 번호를 조회하고 체험실까지 동선을 안내했습니다. 체험관 예약 문의 응답 시간이 줄었습니다. 같은 창구의 같은 문의 유형을 전후 각각 30건씩 기록한 평균 응답 시간이 12분에서 10분으로 줄었습니다."
  : fixture.units.join("\n");
let jobText =
  "업무: 체험관 방문객 안내 및 예약 문의 응대. 필수: 본인이 담당한 안내 업무를 설명할 수 있는 경험. 우대: 응대 시간 개선 결과와 전후 비교 근거를 설명할 수 있는 경험.";
let sourceKind = "txt";
const fixturePath = process.argv
  .find((arg) => arg.startsWith("--fixture="))
  ?.slice(10);
if (fixturePath) {
  const custom: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  if (
    !custom ||
    typeof custom !== "object" ||
    !("synthetic" in custom) ||
    custom.synthetic !== true ||
    !("human_reviewed" in custom) ||
    custom.human_reviewed !== false ||
    !("text" in custom) ||
    typeof custom.text !== "string" ||
    !("job_text" in custom) ||
    typeof custom.job_text !== "string"
  )
    throw new Error("synthetic_fixture_required");
  text = custom.text;
  jobText = custom.job_text;
  if ("source_kind" in custom) {
    if (custom.source_kind !== "txt" && custom.source_kind !== "md")
      throw new Error("synthetic_fixture_kind_invalid");
    sourceKind = custom.source_kind;
  }
}
const started = Date.now();
const signal = AbortSignal.timeout(15 * 60 * 1000);
const events: EventPayload[] = [];
const hashes: Record<string, string> = {};
for (const file of [
  "python/jev_reader.py",
  "python/jev_runtime.py",
  "python/jev_grounded.py",
  "python/atomic_decisions.py",
  "jev.ts",
  "jev-pipeline.ts",
  "semantic-reader.ts",
  "report-v2.ts",
  "codex.ts",
  "tools/jev-flow-eval.ts",
]) {
  const bytes = await readFile(resolve("src/services/readme-lab", file));
  hashes[file] = createHash("sha256").update(bytes).digest("hex");
  const frozen = resolve(out, "source", file);
  await mkdir(dirname(frozen), { recursive: true });
  await writeFile(frozen, bytes);
}
const save = (name: string, value: unknown) =>
  writeFile(resolve(out, name), JSON.stringify(value, null, 2) + "\n");
await save("freeze.json", {
  synthetic: true,
  human_reviewed: false,
  text,
  job_text: jobText,
  source_kind: sourceKind,
  source_sha256: hashes,
});
try {
  const document = await parseDocument(
    {
      job_text: jobText,
      resume_filename: `synthetic-jev-flow.${sourceKind}`,
      resume_media_type: sourceKind === "md" ? "text/markdown" : "text/plain",
      resume_base64: Buffer.from(text).toString("base64"),
    },
    signal,
  );
  const reasoner = new CodexReasoner(
    process.env.README_CODEX_BIN ?? "/opt/homebrew/bin/codex",
    process.env.README_CODEX_MODEL,
  );
  const job = await reasoner.profile(jobText, signal);
  await save("prepared.json", {
    document,
    job,
    prepare_ms: Date.now() - started,
  });
  console.log(
    JSON.stringify({
      stage: "prepared",
      units: document.units.length,
      prepare_ms: Date.now() - started,
    }),
  );
  const result = await readJevDocument(
    document,
    job,
    reasoner,
    (event) => {
      events.push(event);
      if (
        event.type === "window_completed" ||
        event.type === "reading_completed"
      )
        console.log(
          JSON.stringify({
            stage: event.type,
            elapsed_ms: Date.now() - started,
            ...("window_id" in event ? { window: event.window_id } : {}),
          }),
        );
    },
    signal,
    { apiKey: key },
  );
  await save("run.json", {
    synthetic: true,
    human_reviewed: false,
    auto_questions: true,
    http_serving_tested: false,
    ...result,
    events,
    total_with_prepare_ms: Date.now() - started,
  });
  console.log(
    JSON.stringify({
      stage: "completed",
      questions: result.questions.length,
      items: result.report.items.length,
      usage: result.usage,
      total_ms: Date.now() - started,
    }),
  );
} catch (error) {
  await save("failed.json", {
    error: errorCode(error),
    events,
    elapsed_ms: Date.now() - started,
  });
  console.log(JSON.stringify({ stage: "failed", error: errorCode(error) }));
  process.exitCode = 1;
}
