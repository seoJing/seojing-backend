import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  auditMdxRetirement,
  auditRetainedCorpus,
} from "../src/services/mdx-retirement-readiness.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const corpusOnly = args.includes("--corpus-only");
const flags = new Map<string, string>();
for (let index = 0; index < args.length; index++) {
  const key = args[index]!;
  if (key === "--corpus-only") continue;
  if (
    !["--content-root", "--manifest", "--evidence"].includes(key) ||
    !args[index + 1] ||
    args[index + 1]!.startsWith("--") ||
    flags.has(key)
  )
    throw new Error(`Invalid argument: ${key}`);
  flags.set(key, args[++index]!);
}
const root = flags.get("--content-root"),
  manifest = flags.get("--manifest"),
  evidencePath = flags.get("--evidence");
if (!root || !manifest || (corpusOnly && evidencePath))
  throw new Error(
    "Usage: --content-root PATH --manifest PATH [--corpus-only | --evidence PATH]",
  );
let corpusReady = false;
try {
  const expected = auditRetainedCorpus(
    root,
    JSON.parse(readFileSync(manifest, "utf8")),
  );
  corpusReady = true;
  const evidence: unknown = evidencePath
    ? JSON.parse(readFileSync(evidencePath, "utf8"))
    : undefined;
  const report = auditMdxRetirement(expected, evidence, (path) =>
    readFileSync(resolve(dirname(resolve(evidencePath!)), path)),
  );
  console.log(
    JSON.stringify(
      { corpusReady: true, retirementReady: report.ready, ...report },
      null,
      2,
    ),
  );
  process.exitCode = corpusOnly || report.ready ? 0 : 1;
} catch (error) {
  console.log(
    JSON.stringify(
      {
        corpusReady,
        retirementReady: false,
        blockers: [error instanceof Error ? error.message : String(error)],
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
