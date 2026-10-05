// Runtime secrets are supplied by an owner-only file outside the release tree.
// Neither their values nor file contents are included in errors or logs.
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { installModelShutdown } from "../src/services/readme-lab/process.js";

const absolutePath = z.string().refine(isAbsolute);
const runtimeConfig = z
  .object({
    README_LAB_ENABLED: z.literal("1"),
    README_LAB_ENGINE: z.literal("jev"),
    README_LAB_INVITES: z.string().min(16),
    TYPESAFE_API_KEY: z.string().min(16).max(1000),
    README_CODEX_BIN: absolutePath,
    README_CODEX_MODEL: z.string().min(1).optional(),
    README_JEV_PYTHON: absolutePath,
    README_JEV_SCRIPT: absolutePath,
    TMPDIR: absolutePath,
  })
  .strict();

try {
  const filename = process.argv[2];
  if (!filename || !isAbsolute(filename)) throw new Error();
  const info = await stat(filename);
  if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.())
    throw new Error();
  const config = runtimeConfig.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  Object.assign(process.env, config);
} catch {
  process.stderr.write("README Lab protected runtime configuration rejected\n");
  process.exit(1);
}

installModelShutdown();
await import("../src/server.js");
