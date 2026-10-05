import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { CodexReasoner } from "../codex.js";
import { buildDocument, textBlocks } from "../document.js";
import { readSemanticDocument } from "../semantic-pipeline.js";
import type { EventPayload } from "../contracts.js";
const inputPath = resolve(
  process.argv[2] ?? "test/fixtures/readme/semantic-full-flow.json",
);
const out = resolve(
  process.argv[3] ?? `.local/readme-laya/semantic-flow-${Date.now()}`,
);
const source = await readFile(inputPath, "utf8");
const fixture = JSON.parse(source) as {
  synthetic: boolean;
  human_reviewed: boolean;
  job_text: string;
  text: string;
  checks: string[];
};
if (fixture.synthetic !== true || fixture.human_reviewed !== false)
  throw Error("synthetic_only");
await mkdir(out);
const hashes: Record<string, string> = {};
for (const file of [
  "codex.ts",
  "document.ts",
  "semantic-reader.ts",
  "reader.ts",
  "semantic-pipeline.ts",
  "report-v2.ts",
  "errors.ts",
  "tools/semantic-flow-eval.ts",
]) {
  const raw = await readFile(resolve("src/services/readme-lab", file), "utf8");
  hashes[file] = createHash("sha256").update(raw).digest("hex");
  await writeFile(resolve(out, file.replaceAll("/", "_")), raw);
}
await writeFile(resolve(out, "dataset.json"), source);
const reasoner = new CodexReasoner(
  process.env.README_CODEX_BIN,
  process.env.README_CODEX_MODEL,
  120000,
  "low",
  (event) => console.log(JSON.stringify({ model_attempt: event })),
  (event) => {
    // Synthetic fixture only; serving never installs this diagnostic hook.
    writeFileSync(
      resolve(
        out,
        `review-${event.stage}-${event.at_unit_id ?? "final"}-${event.attempt}.json`,
      ),
      JSON.stringify(event, null, 2),
    );
    console.log(
      JSON.stringify({ review_rejected: event.reason, attempt: event.attempt }),
    );
  },
);
const signal = new AbortController().signal;
const document = buildDocument(textBlocks(fixture.text), "txt"),
  events: EventPayload[] = [];
const started = Date.now();
try {
  const job = await reasoner.profile(fixture.job_text, signal);
  const preparation_ms = Date.now() - started;
  await writeFile(
    resolve(out, "prepared.json"),
    JSON.stringify(
      { job, document, preparation_ms, source_hashes: hashes },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      prepared: true,
      preparation_ms,
      units: document.units.length,
    }),
  );
  const result = await readSemanticDocument(
    document,
    job,
    reasoner,
    (event) => {
      events.push(structuredClone(event));
      console.log(
        JSON.stringify({
          event: event.type,
          elapsed_ms: Date.now() - started,
          ...(event.type === "window_completed"
            ? { window_id: event.window_id }
            : {}),
        }),
      );
    },
    signal,
  );
  await writeFile(
    resolve(out, "run.json"),
    JSON.stringify(
      {
        synthetic: true,
        human_reviewed: false,
        engine: "codex_cli",
        requested_model: reasoner.model,
        resolved_model: null,
        source_hashes: hashes,
        fixture,
        document,
        job,
        events,
        ...result,
        preparation_ms,
        end_to_end_ms: Date.now() - started,
        semantic_review: "pending_independent_artifact_review",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ completed: true, ...result.metrics, out }));
} catch (error) {
  await writeFile(
    resolve(out, "failed.json"),
    JSON.stringify(
      {
        events,
        document,
        error:
          error instanceof Error
            ? `${error.message}: ${(error as { validationReason?: string }).validationReason ?? ""}`
            : String(error),
      },
      null,
      2,
    ),
  );
  throw error;
}
