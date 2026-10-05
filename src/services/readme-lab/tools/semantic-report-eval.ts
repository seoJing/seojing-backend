/** Complete reports from retained actual synthetic sequential-run artifacts. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { CodexReasoner } from "../codex.js";
import type {
  JobPosting,
  Note,
  Question,
  ResumeDocument,
} from "../contracts.js";
import type { ReaderMemory } from "../reader.js";
const inputDir = resolve(process.argv[2]!);
const outputDir = resolve(process.argv[3]!);
if (!process.argv[2] || !process.argv[3])
  throw Error("usage: input-artifacts output-new-directory");
await mkdir(outputDir);
const dataset = JSON.parse(
  await readFile(resolve(inputDir, "dataset.json"), "utf8"),
) as {
  synthetic: boolean;
  human_reviewed: boolean;
  cases: { id: string; full_report: boolean }[];
};
if (dataset.synthetic !== true || dataset.human_reviewed !== false)
  throw Error("synthetic_only");
const sources: Record<string, string> = {};
for (const f of ["codex.ts", "report-v2.ts", "tools/semantic-report-eval.ts"]) {
  const raw = await readFile(resolve("src/services/readme-lab", f), "utf8");
  sources[f] = createHash("sha256").update(raw).digest("hex");
  await writeFile(resolve(outputDir, f.replaceAll("/", "_")), raw);
}
let requestedModel: string | null = null;
const selected = process.env.README_EVAL_CASES?.split(",");
const controller = new AbortController();
const rows: unknown[] = [];
for (const fixture of dataset.cases.filter(
  (c) => c.full_report && (!selected || selected.includes(c.id)),
)) {
  const reasoner = new CodexReasoner(
    process.env.README_CODEX_BIN,
    process.env.README_CODEX_MODEL,
    120000,
    "low",
    undefined,
    (review) =>
      writeFileSync(
        resolve(
          outputDir,
          `${fixture.id}-review-${review.stage}-${review.at_unit_id ?? "final"}-${review.attempt}.json`,
        ),
        JSON.stringify(review, null, 2) + "\n",
      ),
  );
  requestedModel = reasoner.model;
  const source = await readFile(
    resolve(inputDir, `${fixture.id}.json`),
    "utf8",
  );
  const r = JSON.parse(source) as {
    error: string | null;
    synthetic: boolean;
    human_reviewed: boolean;
    engine: string;
    document: ResumeDocument;
    job: JobPosting;
    notes: Note[];
    questions: Question[];
    memory: ReaderMemory;
    elapsed_ms: number;
    preparation_ms?: number;
    report_ms?: number | null;
    steps?: { elapsed_ms: number }[];
  };
  if (r.synthetic !== true || r.human_reviewed !== false)
    throw Error("synthetic_only");
  if (r.error || r.memory.units.length !== r.document.units.length)
    throw Error(`incomplete_reading:${fixture.id}`);
  if (r.engine !== "codex_cli") throw Error("source_engine_mismatch");
  // Legacy baseline artifacts identify the engine at the envelope, before it was added to memory.
  r.memory.engine = "codex_cli";
  const start = Date.now();
  const stepDurations = r.steps?.map((step) => step.elapsed_ms);
  const readingMs =
    stepDurations?.length === r.document.units.length &&
    stepDurations.length > 0 &&
    stepDurations.every((ms) => Number.isFinite(ms) && ms >= 0)
      ? stepDurations.reduce((total, ms) => total + ms, 0)
      : null;
  try {
    const report = await reasoner.report(
      r.document,
      r.job,
      r.notes,
      r.questions,
      controller.signal,
      r.memory,
    );
    if (JSON.stringify(report.questions) !== JSON.stringify(r.questions))
      throw Error("ledger_changed");
    const row = {
      id: fixture.id,
      source_sha256: createHash("sha256").update(source).digest("hex"),
      synthetic: true,
      human_reviewed: false,
      engine: "codex_cli",
      report_ms: Date.now() - start,
      reading_ms: readingMs,
      reading_time_basis:
        readingMs === null ? "unavailable" : "sum_of_prefix_step_durations",
      source_elapsed_ms: r.elapsed_ms,
      source_preparation_ms: r.preparation_ms ?? null,
      source_report_ms: r.report_ms ?? null,
      resumed_report_only: true,
      report,
      document: r.document,
      job: r.job,
      notes: r.notes,
      questions: r.questions,
      semantic_review: "pending_independent_artifact_review",
    };
    await writeFile(
      resolve(outputDir, `${fixture.id}.json`),
      JSON.stringify(row, null, 2) + "\n",
    );
    rows.push({
      id: fixture.id,
      completed: true,
      items: report.items.length,
      report_ms: row.report_ms,
    });
  } catch (e) {
    const row = {
      id: fixture.id,
      completed: false,
      error:
        e instanceof Error
          ? `${e.message}: ${(e as { validationReason?: string }).validationReason ?? ""}`
          : String(e),
    };
    rows.push(row);
    await writeFile(
      resolve(outputDir, `${fixture.id}.json`),
      JSON.stringify(row, null, 2) + "\n",
    );
  }
  console.log(JSON.stringify(rows.at(-1)));
}
const sourceChanged: string[] = [];
for (const [file, sha] of Object.entries(sources)) {
  const current = await readFile(
    resolve("src/services/readme-lab", file),
    "utf8",
  );
  if (createHash("sha256").update(current).digest("hex") !== sha)
    sourceChanged.push(file);
}
await writeFile(
  resolve(outputDir, "run.json"),
  JSON.stringify(
    {
      synthetic: true,
      human_reviewed: false,
      inputDir,
      requested_model: requestedModel,
      subset: selected ?? null,
      resolved_model: null,
      source_hashes: sources,
      source_changed_during_run: sourceChanged,
      rows,
    },
    null,
    2,
  ) + "\n",
);
