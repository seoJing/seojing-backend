/** Synthetic-only end-to-end runner. No user files, secrets or API keys. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { CodexReasoner } from "../codex.js";
import type { JobView, PrepareView } from "../contracts.js";
import { openLaya } from "../laya.js";
import { parseDocument } from "../parser.js";
import { ReadmeLab } from "../service.js";
import { designFixtures } from "./design-fixtures.js";
import { v2DesignFixture } from "./design-fixtures-v2.js";

const jobText =
  "필수 요건: 참여자 일정 조정 및 안내문 작성 경험. 우대 사항: 프로그램 결과 보고서 작성 경험.";
const shortText =
  "프로그램 운영에 기여했습니다. 제가 참가자 일정을 조정하고 매주 안내문을 작성했습니다. 만족도가 높아졌습니다.";
const longText = Array.from({ length: 40 }, (_, i) =>
  i % 2
    ? `제가 ${i + 1}차 참가자 안내문을 작성했습니다.`
    : `${i + 1}차 프로그램 운영에 기여했습니다.`,
).join(" ");
async function run(text: string) {
  const started = Date.now();
  const samples: JobView[] = [];
  const lab = new ReadmeLab({
    invitations: ["synthetic-local-smoke-invite"],
    reasoner: new CodexReasoner(
      process.env.README_CODEX_BIN,
      process.env.README_CODEX_MODEL,
    ),
    classifier: openLaya,
    parse: parseDocument,
  });
  try {
    const session = lab.authenticate(
      lab.session("synthetic-local-smoke-invite", true).access_token,
    );
    let prepare: PrepareView = lab.prepare(session, {
      job_text: jobText,
      resume_filename: "synthetic-smoke.txt",
      resume_media_type: "text/plain",
      resume_base64: Buffer.from(text).toString("base64"),
    });
    while (["queued", "extracting", "analyzing_job"].includes(prepare.status)) {
      await pause(100);
      prepare = lab.getPrepare(session, prepare.prepare_id);
    }
    if (prepare.status !== "ready") throw new Error(`prepare_${prepare.error}`);
    const prepareMs = Date.now() - started;
    let reading = lab.start(
      session,
      prepare.prepare_id,
      prepare.input_hash,
      true,
    );
    let cursor = 0;
    while (true) {
      samples.push(reading);
      cursor = reading.next_seq;
      if (["completed", "failed", "cancelled"].includes(reading.status)) break;
      await pause(100);
      reading = lab.getJob(session, reading.job_id, cursor);
    }
    const final = lab.getJob(session, reading.job_id, 0);
    return {
      synthetic: true,
      fixture: false,
      prepare_ms: prepareMs,
      total_ms: Date.now() - started,
      prepare,
      snapshots: samples,
      final,
    };
  } finally {
    lab.close();
  }
}

const fixture = process.argv.includes("--fixtures");
const directory = resolve(
  fixture ? "docs/fixtures/readme-lab" : ".local/readme-laya",
);
await mkdir(directory, { recursive: true });
if (fixture) {
  const { format } = await import("prettier");
  for (const [name, result] of Object.entries({
    ...designFixtures(),
    "v2-transitions": v2DesignFixture(),
  })) {
    await writeFile(
      resolve(directory, `${name}.json`),
      await format(JSON.stringify(result), { parser: "json" }),
    );
    console.log(JSON.stringify({ fixture: name, authored: true }));
  }
} else {
  const long = process.argv.includes("--long");
  const result = await run(long ? longText : shortText);
  const customOutput = process.argv
    .find((arg) => arg.startsWith("--out="))
    ?.slice(6);
  await writeFile(
    customOutput
      ? resolve(customOutput)
      : resolve(directory, long ? "e2e-long.json" : "e2e.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      codex_binary: process.env.README_CODEX_BIN ?? "/opt/homebrew/bin/codex",
      status: result.final.status,
      error: result.final.error,
      prepare_ms: result.prepare_ms,
      total_ms: result.total_ms,
      units: result.final.progress.read_unit_count,
      notes: result.final.events.filter((e) => e.type === "note").length,
      report_items: result.final.report?.items.length ?? 0,
      generation: result.final.generation,
    }),
  );
  if (result.final.status !== "completed") process.exitCode = 1;
}
