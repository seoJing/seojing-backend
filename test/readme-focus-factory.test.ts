/** Exercise the real environment-selected route factory; worker output is recorded synthetic data. */
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReadmeLabRoutes } from "../src/routes/readme-lab.js";
import { CodexReasoner } from "../src/services/readme-lab/codex.js";
import * as parser from "../src/services/readme-lab/parser.js";
import * as focus from "../src/services/readme-lab/focus-jev.js";
import * as legacy from "../src/services/readme-lab/jev.js";
import * as laya from "../src/services/readme-lab/laya.js";
import type {
  JobPosting,
  JobView,
  PrepareView,
  ResumeDocument,
} from "../src/services/readme-lab/contracts.js";

const invite = "synthetic-factory-invitation";
const texts = (
  JSON.parse(
    readFileSync("test/fixtures/readme/focus-recorded-v1.json", "utf8"),
  ) as { cases: Array<{ units: string[] }> }
).cases[0]!.units;
const document: ResumeDocument = {
  doc_id: "synthetic",
  source_kind: "md",
  warnings: [],
  truncated: false,
  units: texts.map((text, i) => ({
    id: `u${i + 1}`,
    block_id: `b${i + 1}`,
    scope_id: "s1",
    order: i,
    start: 0,
    end: text.length,
    text,
  })),
  blocks: texts.map((text, i) => ({
    id: `b${i + 1}`,
    type: i === 0 ? "heading" : "paragraph",
    text,
    unit_ids: [`u${i + 1}`],
  })),
};
const job: JobPosting = {
  source: "user_paste",
  text: "개발 역할을 설명할 수 있는 경험을 확인합니다.",
  requirements: [],
  warnings: [],
  reader_profile: { id: "p1", version: "reader-profile-v2", criteria: [] },
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function create(engine?: string) {
  vi.stubEnv("README_LAB_ENABLED", "1");
  vi.stubEnv("README_LAB_INVITES", invite);
  vi.stubEnv("README_LAB_ENGINE", engine);
  const app = Fastify();
  apps.push(app);
  registerReadmeLabRoutes(app);
  return app;
}
const consent = {
  invite_code: invite,
  cloud_consent: true,
  consent_version: "readme-jev-v1",
};
describe("environment-selected focus engine", () => {
  it("selects the focus worker, ignores the legacy script override, and publishes the accepted policy", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key-never-remote");
    vi.stubEnv("README_JEV_PYTHON", "/usr/bin/python3");
    vi.stubEnv("README_JEV_SCRIPT", "/must-not-use-legacy-script.py");
    const script = resolve("test/fixtures/readme/focus-worker-stub.py");
    vi.stubEnv("README_FOCUS_JEV_SCRIPT", script);
    const open = vi.spyOn(focus, "openFocusJev"),
      old = vi.spyOn(legacy, "openJev"),
      local = vi.spyOn(laya, "openLaya");
    vi.spyOn(parser, "parseDocument").mockResolvedValue(document);
    vi.spyOn(CodexReasoner.prototype, "profile").mockResolvedValue(job);
    const report = vi
      .spyOn(CodexReasoner.prototype, "report")
      .mockImplementation(
        (_document, _job, _notes, questions, _signal, memory) => {
          expect(memory?.focus?.questions[0]?.status).toBe("resolved");
          return Promise.resolve({
            items: [],
            questions,
            limitations: ["synthetic report stub"],
          });
        },
      );
    const app = create("jev-focus");
    const refused = await app.inject({
      method: "POST",
      url: "/readme/lab/session",
      payload: { invite_code: invite, cloud_consent: true },
    });
    expect(refused.json()).toEqual({ error: "cloud_consent_required" });
    expect(open).not.toHaveBeenCalled();
    const session = await app.inject({
      method: "POST",
      url: "/readme/lab/session",
      payload: consent,
    });
    const headers = {
      authorization: `Bearer ${session.json<{ access_token: string }>().access_token}`,
    };
    const prepared = await app.inject({
      method: "POST",
      url: "/readme/lab/prepare",
      headers,
      payload: {
        job_text: job.text,
        resume_filename: "synthetic.md",
        resume_media_type: "text/markdown",
        resume_base64: Buffer.from(texts.join("\n")).toString("base64"),
      },
    });
    expect(prepared.statusCode).toBe(202);
    let pv = prepared.json<PrepareView>();
    await vi.waitFor(async () => {
      pv = (
        await app.inject({
          url: `/readme/lab/prepare/${pv.prepare_id}`,
          headers,
        })
      ).json<PrepareView>();
      expect(pv.status).toBe("ready");
    });
    const started = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: {
        prepare_id: pv.prepare_id,
        input_hash: pv.input_hash,
        confirmed: true,
      },
    });
    expect(started.statusCode).toBe(202);
    const first = started.json<JobView>();
    expect(first.generation).toMatchObject({
      engine: "jev",
      policy_version: "readme-focus-v1",
    });
    await vi.waitFor(async () => {
      const view = (
        await app.inject({ url: `/readme/lab/jobs/${first.job_id}`, headers })
      ).json<JobView>();
      expect(view.status).toBe("completed");
      expect(view.events.some((e) => e.type === "speech")).toBe(true);
    });
    expect(open).toHaveBeenCalledWith(expect.any(AbortSignal), 3, {
      apiKey: "synthetic-key-never-remote",
      python: "/usr/bin/python3",
      script,
    });
    expect(old).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "laya", "jev"])(
    "preserves the consent behavior of existing selection %s",
    async (engine) => {
      const app = create(engine);
      const response = await app.inject({
        method: "POST",
        url: "/readme/lab/session",
        payload: { invite_code: invite, cloud_consent: true },
      });
      expect(response.statusCode).toBe(engine === "jev" ? 400 : 200);
    },
  );
  it("rejects unknown selection and keeps disabled routes unavailable", async () => {
    expect(() => create("unknown-focus")).toThrow("Unknown README Lab engine");
    vi.stubEnv("README_LAB_ENABLED", "0");
    vi.stubEnv("README_LAB_ENGINE", "jev-focus");
    const app = Fastify();
    apps.push(app);
    registerReadmeLabRoutes(app);
    const response = await app.inject({
      method: "POST",
      url: "/readme/lab/session",
      payload: consent,
    });
    expect(response.statusCode).toBe(404);
  });
});
