import { writeFileSync } from "node:fs";
/** Re-evaluate reports from fully completed synthetic readings; never claim continuous timing. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { CodexReasoner } from "../codex.js";
import { createMemory } from "../reader.js";
import type {
  EventPayload,
  JobPosting,
  ResumeDocument,
  Question,
} from "../contracts.js";
const sourceDir = resolve(process.argv[2]!);
const out = resolve(process.argv[3]!);
if (!process.argv[2] || !process.argv[3])
  throw Error("usage: full-flow-directory new-output [failed.json|run.json]");
const dataset = JSON.parse(
  await readFile(resolve(sourceDir, "dataset.json"), "utf8"),
) as { synthetic: boolean; human_reviewed: boolean };
if (dataset.synthetic !== true || dataset.human_reviewed !== false)
  throw Error("synthetic_only");
const prepared = JSON.parse(
  await readFile(resolve(sourceDir, "prepared.json"), "utf8"),
) as { job: JobPosting; document: ResumeDocument; preparation_ms: number };
const sourceFile = process.argv[4] ?? "failed.json";
if (!["failed.json", "run.json"].includes(sourceFile))
  throw Error("source_file_invalid");
const sourceRaw = await readFile(resolve(sourceDir, sourceFile), "utf8");
const sourceRun = JSON.parse(sourceRaw) as { events: EventPayload[] };
const { document, job } = prepared,
  events = sourceRun.events;
const completed = events.flatMap((e) =>
  e.type === "window_completed" ? e.unit_ids : [],
);
if (
  JSON.stringify(completed) !==
    JSON.stringify(document.units.map((u) => u.id)) ||
  !events.some((e) => e.type === "reading_completed")
)
  throw Error("reading_incomplete");
const notes = events.flatMap((e) => (e.type === "note" ? [e.note] : []));
const qmap = new Map<string, Question>();
const memory = createMemory(job, "codex_cli");
memory.units = structuredClone(document.units);
for (const event of events)
  if (event.type === "question_updated") {
    qmap.set(event.question_id, event.question);
    memory.transitions.push(event);
  }
const questions = [...qmap.values()];
await mkdir(out);
const hashes: Record<string, string> = {};
for (const f of [
  "codex.ts",
  "report-v2.ts",
  "reader.ts",
  "tools/semantic-resume-report.ts",
]) {
  const s = await readFile(resolve("src/services/readme-lab", f), "utf8");
  hashes[f] = createHash("sha256").update(s).digest("hex");
  await writeFile(resolve(out, f.replaceAll("/", "_")), s);
}
await writeFile(
  resolve(out, "input.json"),
  JSON.stringify({ document, job, notes, questions, memory }, null, 2) + "\n",
);
const reasoner = new CodexReasoner(
  process.env.README_CODEX_BIN,
  process.env.README_CODEX_MODEL,
  120000,
  "low",
  (event) => console.log(JSON.stringify({ model_attempt: event })),
  (event) => {
    writeFileSync(
      resolve(out, `review-${event.attempt}.json`),
      JSON.stringify(event, null, 2),
    );
    console.log(
      JSON.stringify({ review_rejected: event.reason, attempt: event.attempt }),
    );
  },
);
const start = Date.now();
try {
  const report = await reasoner.report(
    document,
    job,
    notes,
    questions,
    new AbortController().signal,
    memory,
  );
  if (JSON.stringify(report.questions) !== JSON.stringify(questions))
    throw Error("ledger_changed");
  await writeFile(
    resolve(out, "run.json"),
    JSON.stringify(
      {
        synthetic: true,
        human_reviewed: false,
        resumed_report_only: true,
        source_artifact: resolve(sourceDir, sourceFile),
        source_artifact_sha256: createHash("sha256")
          .update(sourceRaw)
          .digest("hex"),
        source_hashes: hashes,
        report_ms: Date.now() - start,
        document,
        job,
        notes,
        questions,
        memory,
        report,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      completed: true,
      report_ms: Date.now() - start,
      items: report.items.length,
    }),
  );
} catch (error) {
  await writeFile(
    resolve(out, "failed.json"),
    JSON.stringify(
      {
        elapsed_ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  throw error;
}
