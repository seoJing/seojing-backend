import { describe, expect, it } from "vitest";
import { readmeRuntimeConfig } from "../scripts/readme-lab-config.js";

const common = {
  README_LAB_ENABLED: "1",
  README_LAB_INVITES: "synthetic-invitation",
  TYPESAFE_API_KEY: "synthetic-test-key",
  README_CODEX_BIN: "/bin/codex",
  README_JEV_PYTHON: "/usr/bin/python3",
  TMPDIR: "/private/tmp/readme-test",
};
const legacy = {
  ...common,
  README_LAB_ENGINE: "jev",
  README_JEV_SCRIPT: "/release/jev_runtime.py",
};
const focus = {
  ...common,
  README_LAB_ENGINE: "jev-focus",
  README_FOCUS_JEV_SCRIPT: "/release/jev_focus_runtime.py",
};

describe("protected README production configuration", () => {
  it.each([legacy, focus])(
    "accepts the pinned $README_LAB_ENGINE worker",
    (value) => {
      expect(readmeRuntimeConfig.parse(value)).toEqual(value);
    },
  );
  it.each([
    { ...legacy, README_LAB_ENGINE: "jev-focus" },
    { ...focus, README_LAB_ENGINE: "jev" },
    { ...focus, README_JEV_SCRIPT: legacy.README_JEV_SCRIPT },
    { ...legacy, README_FOCUS_JEV_SCRIPT: focus.README_FOCUS_JEV_SCRIPT },
    { ...focus, README_FOCUS_JEV_SCRIPT: "relative/worker.py" },
    { ...focus, README_FOCUS_JEV_SCRIPT: undefined },
    { ...focus, README_LAB_ENGINE: "laya" },
    { ...focus, README_LAB_ENGINE: undefined },
    { ...focus, TYPESAFE_API_KEY: "" },
    { ...focus, DATABASE_URL: "must-not-import-extra-secret" },
  ])("rejects incompatible or incomplete runtime configuration %#", (value) => {
    expect(readmeRuntimeConfig.safeParse(value).success).toBe(false);
  });
});
