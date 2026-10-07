// Runtime secrets are supplied by an owner-only file outside the release tree.
// Neither their values nor file contents are included in errors or logs.
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { installModelShutdown } from "../src/services/readme-lab/process.js";
import { readmeRuntimeConfig } from "./readme-lab-config.js";

try {
  const filename = process.argv[2];
  if (!filename || !isAbsolute(filename)) throw new Error();
  const info = await stat(filename);
  if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.())
    throw new Error();
  const config = readmeRuntimeConfig.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  Object.assign(process.env, config);
} catch {
  process.stderr.write("README Lab protected runtime configuration rejected\n");
  process.exit(1);
}

installModelShutdown();
await import("../src/server.js");
