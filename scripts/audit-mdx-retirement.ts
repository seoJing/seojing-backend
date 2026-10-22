import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  auditMdxRetirement,
  auditRetainedCorpus,
} from "../src/services/mdx-retirement-readiness.js";

const EXPECTED_ARCHIVE_SHA256 =
  "7c7405b719a647b9aa61a28800bd5e84734fc342e659eab05242e13cb8987fc4";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const corpusOnly = args.includes("--corpus-only");
const flags = new Map<string, string>();
for (let index = 0; index < args.length; index++) {
  const key = args[index]!;
  if (key === "--corpus-only") continue;
  if (
    !["--archive", "--evidence"].includes(key) ||
    !args[index + 1] ||
    args[index + 1]!.startsWith("--") ||
    flags.has(key)
  )
    throw new Error("Invalid argument: " + key);
  flags.set(key, args[++index]!);
}
const archivePath = flags.get("--archive");
const evidencePath = flags.get("--evidence");
if (!archivePath || (corpusOnly && evidencePath))
  throw new Error("Usage: --archive PATH [--corpus-only | --evidence PATH]");

let corpusReady = false;
let archiveVerified = false;
const extraction = mkdtempSync(resolve(tmpdir(), "seojing-mdx-retirement-"));
try {
  const archive = readFileSync(archivePath);
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  if (archiveSha256 !== EXPECTED_ARCHIVE_SHA256)
    throw new Error("Pre-retirement archive SHA-256 mismatch.");
  execFileSync("tar", ["-xzf", resolve(archivePath), "-C", extraction], {
    stdio: "pipe",
  });
  archiveVerified = true;
  const root = resolve(extraction, "frontend/apps/web/content");
  const manifestPath = resolve(
    extraction,
    "frontend/apps/web/src/shared/content/mdx-migration-manifest.json",
  );
  const expected = auditRetainedCorpus(
    root,
    JSON.parse(readFileSync(manifestPath, "utf8")),
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
      {
        archiveVerified,
        archiveSha256,
        corpusReady: true,
        exhaustive201VisualEvidence: "WAIVED_NOT_COMPLETED",
        retirementReady: report.ready,
        ...report,
      },
      null,
      2,
    ),
  );
  process.exitCode = corpusOnly || report.ready ? 0 : 1;
} catch (error) {
  console.log(
    JSON.stringify(
      {
        archiveVerified,
        corpusReady,
        exhaustive201VisualEvidence: "WAIVED_NOT_COMPLETED",
        retirementReady: false,
        blockers: [error instanceof Error ? error.message : String(error)],
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  rmSync(extraction, { recursive: true, force: true });
}
