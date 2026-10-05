/** Seeded synthetic prefix evaluation; no labels enter either model. */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CodexReasoner, validateProfile } from "../codex.js";
import { validateReaderProfile } from "../profile.js";
import { openJev } from "../jev.js";
import { createMemory } from "../reader.js";
import { readSemanticPrefix } from "../semantic-reader.js";
import type { Unit, Note, Question, EventPayload } from "../contracts.js";
import { errorCode } from "../errors.js";

const arg = (name: string) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
if (
  !process.argv.includes("--allow-remote-synthetic") ||
  !arg("out") ||
  !arg("data")
)
  throw new Error("explicit_synthetic_arguments_required");
const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("jev_key_missing");
const fixture = z
  .object({
    synthetic: z.literal(true),
    human_reviewed: z.literal(false),
    cases: z.array(
      z.object({
        id: z.string(),
        scenario: z.string(),
        question: z.string(),
        sufficient: z.string(),
        insufficient: z.string(),
        units: z.array(z.string()),
        scopes: z.array(z.string()).optional(),
        current_index: z.number().int(),
        expected_state: z.string(),
      }),
    ),
  })
  .parse(JSON.parse(await readFile(arg("data")!, "utf8")));
const out = resolve(arg("out")!);
await mkdir(out, { recursive: false });
const save = (name: string, data: unknown) =>
  writeFile(resolve(out, name), JSON.stringify(data, null, 2) + "\n");
const hashes: Record<string, string> = {};
async function freeze(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "__pycache__") await freeze(path);
    else if (entry.isFile() && /\.(ts|py)$/u.test(entry.name)) {
      const name = relative(resolve("src/services/readme-lab"), path),
        bytes = await readFile(path);
      hashes[name] = createHash("sha256").update(bytes).digest("hex");
      await mkdir(dirname(resolve(out, "source", name)), { recursive: true });
      await writeFile(resolve(out, "source", name), bytes);
    }
  }
}
await freeze("src/services/readme-lab");
const baseline = process.argv.includes("--baseline");
const pythonRoot = arg("python-source")
  ? resolve(arg("python-source")!)
  : resolve(out, "source/python");
const pythonHashes: Record<string, string> = {};
for (const file of await readdir(pythonRoot))
  if (file.endsWith(".py"))
    pythonHashes[file] = createHash("sha256")
      .update(await readFile(resolve(pythonRoot, file)))
      .digest("hex");
await save("freeze.json", {
  synthetic: true,
  human_reviewed: false,
  baseline,
  data: fixture,
  source_sha256: hashes,
  executed_python_sha256: pythonHashes,
  limits:
    "Seeded questions; no parser/profile/report/HTTP or general accuracy measurement.",
});
const groups = new Map<string, typeof fixture.cases>();
for (const item of fixture.cases)
  groups.set(item.scenario, [...(groups.get(item.scenario) ?? []), item]);
const results = [];
for (const [scenario, cases] of groups) {
  const seed = cases[0]!;
  if (cases.some((c) => JSON.stringify(c.units) !== JSON.stringify(seed.units)))
    throw new Error("mixed_scenario");
  const job = validateProfile(
    {
      requirements: [
        { kind: "duty", label: seed.units[0], quote: seed.units[0] },
      ],
    },
    seed.units[0]!,
  );
  job.reader_profile = validateReaderProfile(
    {
      criteria: [
        {
          requirement_id: "r1",
          checks: [
            {
              facet: "role",
              trigger: "본인 역할 설명",
              sufficient: seed.sufficient,
              insufficient: seed.insufficient,
            },
          ],
        },
      ],
    },
    job,
  );
  const units: Unit[] = seed.units.map((text, i) => ({
    id: `u${i + 1}`,
    block_id: `b${i + 1}`,
    order: i,
    start: 0,
    end: text.length,
    text,
    scope_id: seed.scopes?.[i] ?? "s1",
  }));
  const memory = createMemory(job, "jev"),
    notes: Note[] = [],
    events: EventPayload[] = [];
  const questions: Question[] = [
    {
      id: "q1",
      unit_id: "u1",
      scope_id: units[0]!.scope_id,
      criterion_id: "c_r1",
      facet: "role",
      label: "본인 역할",
      text: seed.question,
      status: "open",
      candidate_unit_ids: [],
      evidence_unit_ids: [],
      state_version: 1,
    },
  ];
  const attempts: unknown[] = [],
    reviews: unknown[] = [],
    recovery: unknown[] = [],
    retries: unknown[] = [],
    failures: string[] = [];
  const codex = new CodexReasoner(
    "/opt/homebrew/bin/codex",
    undefined,
    40000,
    "low",
    (e) => attempts.push(e),
    (e) => reviews.push(e),
  );
  const started = Date.now(),
    signal = AbortSignal.timeout(180000);
  const reader = await openJev(signal, {
    apiKey: key,
    script: resolve(pythonRoot, "jev_runtime.py"),
    ...(!baseline ? { reassessRole: codex.reassessRole } : {}),
    onRecovery: (e) => recovery.push(e),
    onRetry: (e) => retries.push(e),
    onFailure: (e) => failures.push(e),
  });
  const checkpoints = [];
  let error: string | undefined;
  try {
    await reader.readStep(
      { job, prefix: units.slice(0, 1), questions: [], notes: [] },
      signal,
    );
    memory.units.push(units[0]!);
    for (let i = 1; i < units.length; i++) {
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
      for (const expected of cases.filter((c) => c.current_index === i))
        checkpoints.push({
          id: expected.id,
          at: i,
          expected_state: expected.expected_state,
          actual_state: questions[0]!.status,
          pass:
            expected.expected_state === "not_resolved"
              ? questions[0]!.status !== "resolved"
              : questions[0]!.status === expected.expected_state,
          question: structuredClone(questions[0]),
        });
    }
  } catch (e) {
    error = errorCode(e);
  } finally {
    reader.close();
  }
  const result = {
    scenario,
    completed: !error,
    error,
    elapsed_ms: Date.now() - started,
    usage: reader.metrics,
    context_reviews: reader.contextReviews,
    checkpoints,
    questions,
    notes,
    events,
    attempts,
    reviews,
    recovery,
    retries,
    failures,
  };
  results.push(result);
  await save(`${scenario}.json`, result);
  console.log(
    JSON.stringify({
      scenario,
      completed: !error,
      matches: checkpoints.filter((c) => c.pass).length,
      total: cases.length,
      reassessments: recovery.length,
      elapsed_ms: result.elapsed_ms,
    }),
  );
}
await save("run.json", {
  synthetic: true,
  human_reviewed: false,
  baseline,
  results,
  completed: results.every((r) => r.completed),
  matches: results.flatMap((r) => r.checkpoints).filter((c) => c.pass).length,
  total: fixture.cases.length,
});
