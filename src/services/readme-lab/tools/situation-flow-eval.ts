/** Synthetic-only local service -> real Jev -> actual Codex report evaluation. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexReasoner } from "../codex.js";
import { ReadmeLab } from "../service.js";
import { openSituationJev, type SituationReader } from "../situation-jev.js";
import { validateReaderProfile } from "../profile.js";
import { LabError, errorCode } from "../errors.js";
import type { JobPosting, ResumeDocument } from "../contracts.js";
const arg = (key: string) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
if (
  !process.argv.includes("--allow-remote-synthetic") ||
  !arg("config") ||
  !arg("out")
)
  throw new Error("explicit_synthetic_flags_required");
const fixtureBytes = await readFile("test/fixtures/readme/situation-v1.json");
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  provenance: string;
  cases: { id: string; units: string[] }[];
};
if (fixture.provenance !== "authored_synthetic_not_model_output")
  throw new Error("synthetic_required");
const selected = fixture.cases.find(
  (c) => c.id === (arg("case") ?? "repeated_undefined_name"),
);
if (!selected) throw new Error("case_missing");
const config = JSON.parse(await readFile(arg("config")!, "utf8")) as Record<
  string,
  string
>;
if (!config.TYPESAFE_API_KEY) throw new Error("provider_key_missing");
const out = resolve(arg("out")!);
await mkdir(out, { recursive: false, mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFile(resolve(out, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const hashes = Object.fromEntries(
  await Promise.all(
    [
      "python/jev_situation_reader.py",
      "situation-contract.ts",
      "situation-jev.ts",
      "situation-report.ts",
      "service.ts",
      "report-v2.ts",
      "codex.ts",
    ].map(
      async (file): Promise<[string, string]> => [
        file,
        hash(await readFile(resolve("src/services/readme-lab", file))),
      ],
    ),
  ),
);
const document: ResumeDocument = {
  doc_id: `synthetic-${selected.id}`,
  source_kind: "md",
  truncated: false,
  warnings: [],
  units: selected.units.map((text, i) => ({
    id: `u${i + 1}`,
    block_id: `b${i + 1}`,
    order: i,
    scope_id: "s1",
    text,
    start: 0,
    end: text.length,
  })),
  blocks: selected.units.map((text, i) => ({
    id: `b${i + 1}`,
    type: text.startsWith("#") ? "heading" : "paragraph",
    text,
    unit_ids: [`u${i + 1}`],
  })),
};
const text = "서비스 개발 경험에서 직접 수행한 업무를 설명해 주세요.";
const job: JobPosting = {
  source: "user_paste",
  text,
  requirements: [
    {
      id: "r1",
      kind: "duty",
      label: "서비스 개발",
      quote: "서비스 개발",
      start: 0,
      end: 6,
    },
  ],
  warnings: [],
};
job.reader_profile = validateReaderProfile(
  {
    criteria: [
      {
        requirement_id: "r1",
        checks: [
          {
            facet: "role",
            trigger: "서비스 개발에 참여하거나 수행했다고 설명함",
            sufficient: "같은 경험에서 본인이 한 구체적인 업무 하나가 설명됨",
            insufficient: "프로젝트 이름이나 참여 사실만 있음",
            question: "본인이 직접 수행한 업무는 무엇인가요?",
          },
        ],
      },
    ],
  },
  job,
);
const started = Date.now(),
  attempts: unknown[] = [],
  diagnostics: unknown[] = [];
const reasoner = new CodexReasoner(
  config.README_CODEX_BIN,
  config.README_CODEX_MODEL,
  120000,
  "low",
  (event) => attempts.push(event),
);
const invitation = randomBytes(24).toString("hex");
let reader: SituationReader | undefined;
let reportMemory: unknown;
const lab = new ReadmeLab({
  invitations: [invitation],
  parse: () => Promise.resolve(document),
  reasoner: {
    model: reasoner.model,
    profile: () => Promise.resolve(job),
    report: (doc, posting, notes, questions, signal, memory) => {
      reportMemory = structuredClone(memory);
      return reasoner.report(doc, posting, notes, questions, signal, memory);
    },
  },
  focus: () => Promise.reject(new LabError("wrong_evaluation_policy")),
  situation: async (signal, units) => {
    reader = await openSituationJev(signal, units, {
      apiKey: config.TYPESAFE_API_KEY!,
      python: config.README_JEV_PYTHON,
    });
    return reader;
  },
  onReadingDiagnostic: (event) => {
    diagnostics.push(event);
    process.stdout.write(
      JSON.stringify({
        phase: event.phase,
        status: event.status,
        read_units: event.read_units,
      }) + "\n",
    );
  },
});
await save("provenance.json", {
  synthetic: true,
  case: selected.id,
  fixture_sha256: hash(fixtureBytes),
  source_sha256: hash(JSON.stringify(selected.units)),
  hashes,
  parser: "authored source units",
  profile: "authored synthetic profile",
  reader: "actual Jev remote",
  report: "actual Codex CLI",
  gold_supplied_to_model: false,
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
    throw new LabError(prepared.error ?? "prepare_failed");
  let view = lab.start(
    session,
    prepared.prepare_id,
    prepared.input_hash,
    true,
    "readme-situation-v1",
  );
  while (["queued", "reading", "reporting"].includes(view.status)) {
    if (Date.now() - started > 600000) {
      lab.cancel(session, view.job_id);
      throw new LabError("evaluation_timeout");
    }
    await delay(100);
    view = lab.getJob(session, view.job_id, 0);
  }
  await save("result.json", {
    synthetic: true,
    document,
    job,
    view,
    ledger: reader?.ledger,
    memory: reportMemory,
    metrics: reader?.metrics,
    diagnostics,
    attempts,
    elapsed_ms: Date.now() - started,
  });
  if (view.status !== "completed" || !view.report)
    throw new LabError(view.error ?? "incomplete");
  process.stdout.write(
    JSON.stringify({
      status: view.status,
      report_items: view.report.items.length,
      elapsed_ms: Date.now() - started,
    }) + "\n",
  );
} catch (error) {
  await save("failed.json", {
    error: errorCode(error),
    metrics: reader?.metrics,
    diagnostics,
    attempts,
  });
  process.exitCode = 1;
} finally {
  lab.close();
  reader?.close();
}
