/** Actual protected-stdin worker + validated final report; synthetic-only opt-in. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { openFocusJev, type FocusReader } from "../focus-jev.js";
import { ReadmeLab } from "../service.js";
import { CodexReasoner } from "../codex.js";
import { errorCode } from "../errors.js";
import type { ResumeDocument, Unit, JobPosting } from "../contracts.js";
const arg = (key: string) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
if (
  !process.argv.includes("--allow-remote-synthetic") ||
  !arg("config") ||
  !arg("prepared") ||
  !arg("out")
)
  throw new Error("explicit_flags_required");
const fixture = JSON.parse(
  await readFile(
    arg("fixture") ?? "test/fixtures/readme/focus-reader-v1.json",
    "utf8",
  ),
) as {
  purpose: string;
  cases: Array<{ id: string; units: string[]; role_context: string }>;
};
if (!fixture.purpose.startsWith("Synthetic"))
  throw new Error("synthetic_required");
const selected = fixture.cases.find(
  (c) => c.id === (arg("case") ?? "resolved_then_corrected"),
);
if (!selected) throw new Error("case_missing");
const config = JSON.parse(await readFile(arg("config")!, "utf8")) as Record<
  string,
  string
>;
const { job, synthetic } = JSON.parse(
  await readFile(arg("prepared")!, "utf8"),
) as {
  job: JobPosting;
  synthetic: boolean;
};
if (synthetic !== true) throw new Error("synthetic_required");
const out = resolve(arg("out")!);
await mkdir(out, { recursive: false });
const save = (name: string, value: unknown) =>
  writeFile(resolve(out, name), JSON.stringify(value, null, 2) + "\n");
let scope = 0;
const units: Unit[] = selected.units.map((text, i) => {
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
  doc_id: `synthetic-${selected.id}`,
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
const started = Date.now();
let reader: FocusReader | undefined;
let readingMs: number | null = null;
const reasoner = new CodexReasoner(
  config.README_CODEX_BIN,
  config.README_CODEX_MODEL,
);
const invitation = randomBytes(24).toString("hex");
const hashes = Object.fromEntries(
  await Promise.all(
    [
      "python/jev_focus_reader.py",
      "focus-contract.ts",
      "focus-jev.ts",
      "focus-report.ts",
      "report-v2.ts",
      "service.ts",
    ].map(
      async (file): Promise<[string, string]> => [
        file,
        createHash("sha256")
          .update(await readFile(resolve("src/services/readme-lab", file)))
          .digest("hex"),
      ],
    ),
  ),
);
const lab = new ReadmeLab({
  invitations: [invitation],
  parse: () => Promise.resolve(document),
  reasoner: {
    model: reasoner.model,
    profile: () => Promise.resolve(job),
    report: reasoner.report.bind(reasoner),
  },
  focus: async (signal, total) => {
    reader = await openFocusJev(signal, total, {
      apiKey: config.TYPESAFE_API_KEY!,
    });
    return reader;
  },
  onReadingDiagnostic: (event) => {
    if (event.phase === "reading_completed") readingMs = event.reading_ms;
  },
});
try {
  const session = lab.authenticate(
    lab.session(invitation, true, "readme-jev-v1").access_token,
  );
  let prepared = lab.prepare(session, {
    job_text: job.text,
    resume_filename: "synthetic.md",
    resume_media_type: "text/markdown",
    resume_base64: Buffer.from(selected.units.join("\n")).toString("base64"),
  });
  while (["queued", "extracting", "analyzing_job"].includes(prepared.status)) {
    await delay(100);
    prepared = lab.getPrepare(session, prepared.prepare_id);
  }
  if (prepared.status !== "ready")
    throw new Error(prepared.error ?? "prepare_failed");
  let view = lab.start(session, prepared.prepare_id, prepared.input_hash, true);
  while (["queued", "reading", "reporting"].includes(view.status)) {
    await delay(100);
    view = lab.getJob(session, view.job_id, 0);
  }
  await save("view.json", { synthetic: true, view });
  if (!reader || view.status !== "completed" || !view.report)
    throw new Error(view.error ?? "incomplete");
  await save("reading.json", {
    synthetic: true,
    pipeline:
      "ReadmeLab.focus -> Jev worker -> validated ledger -> Codex report",
    hashes,
    document,
    job,
    ledger: reader.ledger,
    metrics: reader.metrics,
    reading_ms: readingMs,
  });
  console.log(
    JSON.stringify({
      stage: "reading_completed",
      metrics: reader.metrics,
      elapsed_ms: Date.now() - started,
    }),
  );
  const report = view.report;
  await save("report.json", {
    synthetic: true,
    report,
    elapsed_ms: Date.now() - started,
  });
  await writeFile(
    resolve(out, "REPORT.md"),
    [
      "# 실제 Jev → GPT 검증본",
      "",
      "합성 문서 · 보호된 stdin 런타임과 원문 검증기를 통과한 결과입니다.",
      "",
      ...report.items.flatMap((item) => [
        "### " + item.text,
        "",
        item.reason,
        "",
        "원문: " + item.citations.map((c) => c.unit_id).join(", "),
        "",
      ]),
      ...report.limitations.map((t) => "- " + t),
      "",
      "## 원문",
      "",
      ...units.map((u) => `**${u.id}** ${u.text}\n`),
    ].join("\n"),
  );
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
    metrics: reader?.metrics,
  });
  console.log(JSON.stringify({ stage: "failed", error: errorCode(error) }));
  process.exitCode = 1;
} finally {
  lab.close();
  reader?.close();
}
