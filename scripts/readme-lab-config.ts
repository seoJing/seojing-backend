import { isAbsolute } from "node:path";
import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute);
const common = {
  README_LAB_ENABLED: z.literal("1"),
  README_LAB_INVITES: z.string().min(16),
  TYPESAFE_API_KEY: z.string().min(16).max(1000),
  README_CODEX_BIN: absolutePath,
  README_CODEX_MODEL: z.string().min(1).optional(),
  README_JEV_PYTHON: absolutePath,
  TMPDIR: absolutePath,
};

// Production pins the worker to its immutable release, with no protocol fallback.
export const readmeRuntimeConfig = z.discriminatedUnion("README_LAB_ENGINE", [
  z
    .object({
      ...common,
      README_LAB_ENGINE: z.literal("jev"),
      README_JEV_SCRIPT: absolutePath,
    })
    .strict(),
  z
    .object({
      ...common,
      README_LAB_ENGINE: z.literal("jev-focus"),
      README_FOCUS_JEV_SCRIPT: absolutePath,
    })
    .strict(),
]);
