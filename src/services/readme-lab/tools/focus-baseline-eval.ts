/** Existing serving reader on the same frozen long synthetic units. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openJev } from "../jev.js";
import { readSemanticPrefix } from "../semantic-reader.js";
import { createMemory } from "../reader.js";
import { errorCode } from "../errors.js";
import type {
  Unit,
  Note,
  Question,
  EventPayload,
  JobPosting,
} from "../contracts.js";
const arg = (key: string) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
if (
  !process.argv.includes("--allow-remote-synthetic") ||
  !arg("out") ||
  !arg("config") ||
  !arg("prepared")
)
  throw new Error("explicit_flags_required");
const config = JSON.parse(await readFile(arg("config")!, "utf8")) as Record<
  string,
  string
>;
const fixture = JSON.parse(
  await readFile("test/fixtures/readme/focus-long-v1.json", "utf8"),
) as { purpose: string; cases: Array<{ units: string[] }> };
if (!fixture.purpose.startsWith("Synthetic"))
  throw new Error("synthetic_required");
const { job } = JSON.parse(await readFile(arg("prepared")!, "utf8")) as {
  job: JobPosting;
};
const out = resolve(arg("out")!);
await mkdir(out, { recursive: false });
let scope = 0;
const units: Unit[] = fixture.cases[0]!.units.map((text, i) => {
  if (text.startsWith("#")) scope++;
  return {
    id: `u${i + 1}`,
    block_id: `b${i + 1}`,
    scope_id: `s${scope}`,
    order: i,
    text,
    start: 0,
    end: text.length,
  };
});
const signal = AbortSignal.timeout(10 * 60 * 1000);
const reader = await openJev(signal, { apiKey: config.TYPESAFE_API_KEY! });
const memory = createMemory(job, "jev"),
  notes: Note[] = [],
  questions: Question[] = [],
  events: EventPayload[] = [];
let error: string | null = null,
  read = 0;
const started = Date.now();
try {
  for (let i = 0; i < units.length; i++) {
    await readSemanticPrefix(
      units.slice(0, i + 1),
      job,
      reader,
      memory,
      notes,
      questions,
      (e) => events.push(e),
      signal,
    );
    read++;
    if (read % 20 === 0)
      console.log(
        JSON.stringify({ stage: "baseline", read, metrics: reader.metrics }),
      );
  }
} catch (e) {
  error = errorCode(e);
} finally {
  reader.close();
}
const result = {
  synthetic: true,
  same_source: "test/fixtures/readme/focus-long-v1.json",
  policy: "readme-prefix-v2",
  baseline_head: "3af9f6a2b37534b3dda9f803642d889cfb17232e",
  completed: error === null,
  read_units: read,
  elapsed_ms: Date.now() - started,
  error,
  metrics: reader.metrics,
  question_count: questions.length,
  note_count: notes.length,
};
await writeFile(resolve(out, "summary.json"), JSON.stringify(result, null, 2));
await writeFile(
  resolve(out, "trace.json"),
  JSON.stringify({ job, units, questions, notes, events }, null, 2),
);
console.log(JSON.stringify(result));
