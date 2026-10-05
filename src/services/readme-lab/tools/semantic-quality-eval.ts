/** Actual ChatGPT-login CLI run of fixed synthetic behavior specs. No promotion claim. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { CodexReasoner, validateProfile } from "../codex.js";
import { validateReaderProfile, readerProfileSchema } from "../profile.js";
import { buildDocument, textBlocks } from "../document.js";
import { createMemory, finishReading } from "../reader.js";
import {
  readSemanticPrefix,
  semanticInput,
  type SemanticInput,
} from "../semantic-reader.js";
import type { ReaderMemory } from "../reader.js";
import type {
  EventPayload,
  JobPosting,
  Note,
  Question,
  Report,
} from "../contracts.js";

const expectation = z.object({
  at: z.number().int().positive(),
  question_count: z.number().int().optional(),
  origin: z.number().int().positive().optional(),
  status: z.array(z.string()).optional(),
  min_evidence: z.number().int().optional(),
  max_new_notes: z.number().int().optional(),
  forbid_resolved: z.boolean().optional(),
  correction_visible: z.boolean().optional(),
  standalone_retractions: z.number().int().nonnegative().optional(),
});
const schema = z.object({
  synthetic: z.literal(true),
  human_reviewed: z.literal(false),
  purpose: z.string(),
  cases: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9_]+$/u),
      requirement: z.string(),
      profile_job_text: z.string().min(20).max(18000).optional(),
      checks: readerProfileSchema.shape.criteria.element.shape.checks,
      text: z.string(),
      expect: z.array(expectation),
      critical: z.boolean(),
      full_report: z.boolean(),
    }),
  ),
});
const datasetPath = resolve(
  process.argv[2] ?? "test/fixtures/readme/semantic-behavior-v1.json",
);
const source = await readFile(datasetPath, "utf8");
const dataset = schema.parse(JSON.parse(source));
if (new Set(dataset.cases.map((c) => c.id)).size !== dataset.cases.length)
  throw Error("duplicate_cases");
const out = resolve(
  process.argv[3] ?? `.local/readme-laya/semantic-${Date.now()}`,
);
await mkdir(out); // Deliberately refuse to overwrite evidence.
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const snapshotFiles = [
  "codex.ts",
  "document.ts",
  "process.ts",
  "contracts.ts",
  "errors.ts",
  "semantic-reader.ts",
  "reader.ts",
  "report-v2.ts",
  "profile.ts",
  "tools/semantic-quality-eval.ts",
];
const hashes: Record<string, string> = {};
for (const name of snapshotFiles) {
  const content = await readFile(
    resolve("src/services/readme-lab", name),
    "utf8",
  );
  hashes[name] = hash(content);
  await writeFile(resolve(out, name.replaceAll("/", "_")), content);
}
await writeFile(resolve(out, "dataset.json"), source);
const controller = new AbortController();
const rows: {
  id: string;
  passed: boolean;
  failures: string[];
  critical: boolean;
  steps: unknown[];
  elapsed_ms: number;
  report_ms: number | null;
  resolution_expected: number;
  resolution_matched: number;
  error: string | null;
}[] = [];
const timings: number[] = [];
const began = Date.now();
const selected = process.env.README_EVAL_CASES?.split(",");
const queue = dataset.cases.filter((c) => !selected || selected.includes(c.id));
async function run() {
  for (;;) {
    const fixture = queue.shift();
    if (!fixture) return;
    // Each concurrent fixture owns its diagnostics; no shared mutable case label.
    // This harness accepts synthetic inputs only. Serving installs no draft hook.
    const reasoner = new CodexReasoner(
      process.env.README_CODEX_BIN,
      process.env.README_CODEX_MODEL,
      120000,
      "low",
      undefined,
      (review) =>
        writeFileSync(
          resolve(
            out,
            `${fixture.id}-review-${review.stage}-${review.at_unit_id ?? "final"}-${review.attempt}.json`,
          ),
          JSON.stringify(review, null, 2) + "\n",
        ),
    );
    const started = Date.now();
    const document = buildDocument(textBlocks(fixture.text), "txt");
    if (fixture.expect.some((e) => e.at > document.units.length))
      throw Error("expectation_out_of_range");
    let job: JobPosting | null = null;
    let memory: ReaderMemory | null = null;
    const notes: Note[] = [],
      questions: Question[] = [],
      events: EventPayload[] = [];
    let preparationMs = 0;
    const steps: unknown[] = [],
      failures: string[] = [];
    let error: string | null = null,
      report: Report | null = null,
      reportMs: number | null = null;
    let firstUsefulMs: number | null = null;
    let resolutionMatched = 0;
    const resolutionExpected = fixture.expect.filter(
      (e) => e.status?.length === 1 && e.status[0] === "resolved",
    ).length;
    try {
      if (fixture.profile_job_text) {
        job = await reasoner.profile(
          fixture.profile_job_text,
          controller.signal,
        );
      } else {
        job = validateProfile(
          {
            requirements: [
              {
                kind: "duty",
                label: fixture.requirement,
                quote: fixture.requirement,
              },
            ],
          },
          `담당업무: ${fixture.requirement}`,
        );
        job.reader_profile = validateReaderProfile(
          { criteria: [{ requirement_id: "r1", checks: fixture.checks }] },
          job,
        );
      }
      memory = createMemory(job, "codex_cli");
      preparationMs = Date.now() - started;
      const readingStarted = Date.now();
      for (let i = 0; i < document.units.length; i++) {
        const before = notes.length;
        let supplied: unknown;
        const stepStart = Date.now();
        await readSemanticPrefix(
          document.units.slice(0, i + 1),
          job,
          {
            readStep: async (input: SemanticInput, signal) => {
              supplied = structuredClone(semanticInput(input));
              return reasoner.readStep(input, signal);
            },
          },
          memory,
          notes,
          questions,
          (event) => events.push(event),
          controller.signal,
        );
        const elapsed = Date.now() - stepStart;
        timings.push(elapsed);
        if (notes.length && firstUsefulMs === null)
          firstUsefulMs = Date.now() - readingStarted;
        for (const e of fixture.expect.filter((e) => e.at === i + 1)) {
          if (
            e.question_count !== undefined &&
            questions.length !== e.question_count
          )
            failures.push(
              `u${i + 1}: question_count ${questions.length} != ${e.question_count}`,
            );
          if (e.origin !== undefined && e.status) {
            const q = questions.find((q) => q.unit_id === `u${e.origin}`);
            if (
              e.status.length === 1 &&
              e.status[0] === "resolved" &&
              q?.status === "resolved"
            )
              resolutionMatched++;
            if (!q || !e.status.includes(q.status))
              failures.push(
                `u${i + 1}: origin u${e.origin} status ${q?.status ?? "missing"} not ${e.status.join("|")}`,
              );
          }
          if (
            e.min_evidence !== undefined &&
            notes.filter((n) => n.kind === "evidence").length < e.min_evidence
          )
            failures.push(`u${i + 1}: insufficient useful evidence`);
          if (
            e.max_new_notes !== undefined &&
            notes.length - before > e.max_new_notes
          )
            failures.push(`u${i + 1}: repeated/unnecessary notes`);
          if (
            e.forbid_resolved &&
            questions.some((q) => q.status === "resolved")
          )
            failures.push(`u${i + 1}: CRITICAL false resolution`);
          const correctionVisible =
            (memory.note_retractions ?? []).some(
              (r) =>
                r.at_unit_id === `u${i + 1}` &&
                notes
                  .slice(before)
                  .some(
                    (n) =>
                      n.kind === "observation" &&
                      n.unit_id === r.at_unit_id &&
                      n.evidence_unit_ids.includes(r.at_unit_id) &&
                      n.evidence_unit_ids.includes(
                        notes.find((original) => original.id === r.note_id)!
                          .unit_id,
                      ),
                  ),
            ) ||
            memory.transitions.some(
              (t) =>
                t.at_unit_id === `u${i + 1}` &&
                t.status === "reopened" &&
                notes
                  .slice(before)
                  .some(
                    (n) =>
                      n.kind === "hold" &&
                      n.unit_id === t.at_unit_id &&
                      n.question_id === t.question_id,
                  ),
            );
          if (
            e.correction_visible !== undefined &&
            correctionVisible !== e.correction_visible
          )
            failures.push(
              `u${i + 1}: correction visibility ${correctionVisible} != ${e.correction_visible}`,
            );
          if (
            e.standalone_retractions !== undefined &&
            (memory.note_retractions ?? []).length !== e.standalone_retractions
          )
            failures.push(`u${i + 1}: standalone retraction count mismatch`);
        }
        for (const n of notes.slice(before)) {
          const u = document.units.find((u) => u.id === n.unit_id)!;
          const block = document.blocks.find((b) => b.id === n.span.block_id)!;
          if (
            n.span.start < u.start ||
            n.span.end > u.end ||
            !u.text.includes(block.text.slice(n.span.start, n.span.end))
          )
            failures.push(`u${i + 1}: CRITICAL invalid source span`);
        }
        steps.push({
          at_unit: i + 1,
          elapsed_ms: elapsed,
          input: supplied,
          questions: structuredClone(questions),
          new_notes: structuredClone(notes.slice(before)),
          note_retractions: structuredClone(memory.note_retractions ?? []),
        });
      }
      finishReading(memory, questions, (event) => events.push(event));
      if (fixture.full_report && process.env.README_EVAL_REPORTS === "1") {
        const reportStart = Date.now();
        report = await reasoner.report(
          document,
          job,
          notes,
          questions,
          controller.signal,
          memory,
        );
        reportMs = Date.now() - reportStart;
        if (JSON.stringify(report.questions) !== JSON.stringify(questions))
          failures.push("CRITICAL report question ledger changed");
        if (!report.items.length)
          failures.push("empty report lacks useful feedback");
      }
    } catch (e) {
      if (!memory) preparationMs = Date.now() - started;
      error =
        e instanceof Error
          ? `${e.message}: ${(e as { validationReason?: string }).validationReason ?? ""}`
          : String(e);
      failures.push(`runtime_error: ${error}`);
    }
    const row = {
      id: fixture.id,
      passed: failures.length === 0,
      failures,
      critical: fixture.critical,
      steps,
      elapsed_ms: Date.now() - started,
      report_ms: reportMs,
      preparation_ms: preparationMs,
      profile_source: fixture.profile_job_text ? "model" : "fixed",
      resolution_expected: resolutionExpected,
      resolution_matched: resolutionMatched,
      error,
    };
    rows.push(row);
    await writeFile(
      resolve(out, `${fixture.id}.json`),
      JSON.stringify(
        {
          ...row,
          synthetic: true,
          human_reviewed: false,
          engine: "codex_cli",
          fixture,
          document,
          job,
          notes,
          questions,
          events,
          memory,
          report,
          first_useful_ms: firstUsefulMs,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      JSON.stringify({
        case: row.id,
        passed: row.passed,
        failures,
        elapsed_ms: row.elapsed_ms,
        notes: notes.length,
        questions: questions.map((q) => ({
          origin: q.unit_id,
          status: q.status,
        })),
      }),
    );
  }
}
await Promise.all([run(), run()]);
const sorted = [...timings].sort((a, b) => a - b);
const result = {
  synthetic: true,
  human_reviewed: false,
  production_approved: false,
  requested_model: process.env.README_CODEX_MODEL ?? "cli_default",
  resolved_model: null,
  effort: "low",
  dataset_sha256: hash(source),
  source_hashes: hashes,
  subset: selected ?? null,
  concurrency: 2,
  cases: rows.length,
  passed: rows.filter((r) => r.passed).length,
  semantic_review: "pending_independent_artifact_review",
  critical_errors: null,
  resolution_expected: rows.reduce((n, r) => n + r.resolution_expected, 0),
  resolution_matched: rows.reduce((n, r) => n + r.resolution_matched, 0),
  critical_behavior_case_failures: rows
    .filter((r) => r.critical && !r.passed)
    .map((r) => r.id),
  step_count: timings.length,
  step_p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  elapsed_ms: Date.now() - began,
  rows,
};
await writeFile(
  resolve(out, "run.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    complete: true,
    cases: result.cases,
    passed: result.passed,
    step_count: result.step_count,
    step_p95_ms: result.step_p95_ms,
    out,
  }),
);
if (result.passed !== result.cases) process.exitCode = 1;
