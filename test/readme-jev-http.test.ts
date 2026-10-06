/** Transport regressions with fake model outputs, not inference quality evidence. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReadmeLabRoutes } from "../src/routes/readme-lab.js";
import {
  validateProfile,
  type Reasoner,
} from "../src/services/readme-lab/codex.js";
import type {
  JobView,
  PrepareView,
} from "../src/services/readme-lab/contracts.js";
import {
  buildDocument,
  textBlocks,
} from "../src/services/readme-lab/document.js";
import { LabError } from "../src/services/readme-lab/errors.js";
import type { JevReader } from "../src/services/readme-lab/jev.js";
import { validateReaderProfile } from "../src/services/readme-lab/profile.js";
import { validateGroundedReport } from "../src/services/readme-lab/report-v2.js";
import {
  ReadmeLab,
  type LabOptions,
} from "../src/services/readme-lab/service.js";

import type { SemanticInput } from "../src/services/readme-lab/semantic-reader.js";

const invite = "synthetic-http-invite-not-for-production";
const consent = {
  invite_code: invite,
  cloud_consent: true,
  consent_version: "readme-jev-v1",
};
const input = {
  job_text: "행사 참가자를 위한 안내문 작성 경험이 필요합니다.",
  resume_filename: "synthetic.txt",
  resume_media_type: "text/plain",
  resume_base64: Buffer.from(
    "행사 안내에 기여했습니다. 제가 행사 안내문을 작성했습니다.",
  ).toString("base64"),
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
});

function setup(overrides: Partial<LabOptions> = {}) {
  const job = validateProfile(
    {
      requirements: [
        { kind: "duty", label: "안내문 작성", quote: "안내문 작성" },
      ],
    },
    input.job_text,
  );
  job.reader_profile = validateReaderProfile(
    {
      criteria: [
        {
          requirement_id: "r1",
          checks: [
            {
              facet: "role",
              trigger: "행사 참여 주장",
              sufficient: "본인이 직접 수행한 구체적인 업무",
              insufficient: "참여만 설명",
            },
          ],
        },
      ],
    },
    job,
  );
  const document = buildDocument(
    textBlocks(Buffer.from(input.resume_base64, "base64").toString()),
    "txt",
  );
  const reader = {
    metadata: {
      model: "jev-1.13.0",
      provider: "typesafe",
      execution: "remote",
      calibrated_for_readme: false,
    },
    metrics: { calls: 0, input_tokens: 0, output_tokens: 0, omitted_proofs: 0 },
    close: vi.fn(),
    readStep: vi.fn<JevReader["readStep"]>(({ prefix }: SemanticInput) => {
      const evidence = prefix.map((u) => ({ unit_id: u.id, quote: u.text }));
      return Promise.resolve({
        questions:
          prefix.length === 1
            ? [
                {
                  criterion_id: "c_r1",
                  facet: "role" as const,
                  text: "본인이 직접 수행한 구체적인 업무는 무엇인가요?",
                  evidence,
                },
              ]
            : [],
        updates:
          prefix.length > 1
            ? [
                {
                  question_id: "q1",
                  relation: "complete" as const,
                  text: "본인이 안내문을 작성했다는 설명을 찾았습니다.",
                  evidence,
                },
              ]
            : [],
        evidence: [],
        retractions: [],
      });
    }),
  } satisfies JevReader;
  const reasoner = {
    model: "test_double",
    profile: vi.fn(() => Promise.resolve(job)),
    report: vi.fn<Reasoner["report"]>(
      (doc, posting, notes, questions, _signal, memory) => {
        expect(memory?.engine).toBe("jev");
        return Promise.resolve(
          validateGroundedReport(
            { items: [] },
            doc,
            posting,
            notes,
            questions,
            "jev",
          ),
        );
      },
    ),
  } satisfies Reasoner;
  const parse = vi.fn(() => Promise.resolve(document)),
    open = vi.fn(() => Promise.resolve(reader));
  const lab = new ReadmeLab({
    invitations: [invite],
    reasoner,
    parse,
    jev: open,
    ...overrides,
  });
  const app = Fastify();
  apps.push(app);
  registerReadmeLabRoutes(app, lab);
  return { app, lab, job, document, reader, reasoner, parse, open };
}
async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/readme/lab/session",
    payload: consent,
  });
  expect(response.statusCode).toBe(200);
  return {
    authorization: `Bearer ${response.json<{ access_token: string }>().access_token}`,
  };
}
async function prepare(
  app: FastifyInstance,
  headers: { authorization: string },
) {
  const response = await app.inject({
    method: "POST",
    url: "/readme/lab/prepare",
    headers,
    payload: input,
  });
  expect(response.statusCode).toBe(202);
  let value = response.json<PrepareView>();
  await vi.waitFor(async () => {
    value = (
      await app.inject({
        url: `/readme/lab/prepare/${value.prepare_id}`,
        headers,
      })
    ).json<PrepareView>();
    expect(value.status).toBe("ready");
  });
  return value;
}
const startBody = (p: PrepareView) => ({
  prepare_id: p.prepare_id,
  input_hash: p.input_hash,
  confirmed: true,
});

describe("acknowledged Jev HTTP contract", () => {
  it("logs only aggregate reading diagnostics and survives a failing log sink", async () => {
    const onReadingDiagnostic = vi.fn<
      NonNullable<LabOptions["onReadingDiagnostic"]>
    >(() => {
      throw new Error("sink unavailable");
    });
    const { app } = setup({ onReadingDiagnostic });
    const headers = await login(app),
      prepared = await prepare(app, headers);
    const created = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: startBody(prepared),
    });
    const id = created.json<JobView>().job_id;
    await vi.waitFor(async () => {
      const view = (
        await app.inject({ url: `/readme/lab/jobs/${id}`, headers })
      ).json<JobView>();
      expect(view.status).toBe("completed");
    });
    expect(onReadingDiagnostic.mock.calls.map(([e]) => e.phase)).toEqual([
      "reading_completed",
      "finished",
    ]);
    const last = onReadingDiagnostic.mock.calls.at(-1)![0];
    expect(last).toMatchObject({
      status: "completed",
      read_units: 2,
      total_units: 2,
      question_count: 1,
      error: null,
    });
    expect(Object.keys(last).sort()).toEqual(
      [
        "job_id",
        "phase",
        "status",
        "read_units",
        "total_units",
        "question_count",
        "note_count",
        "evidence_count",
        "retracted_count",
        "elapsed_ms",
        "reading_ms",
        "error",
        "metrics",
        "decisions",
      ].sort(),
    );
    const logged = JSON.stringify(onReadingDiagnostic.mock.calls);
    for (const secret of [
      invite,
      input.job_text,
      input.resume_filename,
      input.resume_base64,
      "안내문",
    ])
      expect(logged).not.toContain(secret);
  });
  it("requires current explicit consent before any parsing or model work", async () => {
    const { app, parse, reasoner, open } = setup();
    for (const payload of [
      { invite_code: invite, cloud_consent: true },
      { ...consent, consent_version: "old" },
      { ...consent, cloud_consent: false },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/readme/lab/session",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "cloud_consent_required" });
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/readme/lab/session",
          payload: { ...consent, invite_code: "wrong" },
        })
      ).statusCode,
    ).toBe(401);
    await login(app);
    expect(parse).not.toHaveBeenCalled();
    expect(reasoner.profile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it("accepts the optional consent version in Laya mode without opening a model", async () => {
    const classifier = vi.fn();
    const { app } = setup({ jev: undefined, classifier });
    await login(app);
    expect(classifier).not.toHaveBeenCalled();
  });
  it("selects Jev explicitly from deployment configuration and rejects unknown engines", async () => {
    vi.stubEnv("README_LAB_ENABLED", "1");
    vi.stubEnv("README_LAB_INVITES", invite);
    vi.stubEnv("README_LAB_ENGINE", "jev");
    const app = Fastify();
    apps.push(app);
    registerReadmeLabRoutes(app);
    const missing = await app.inject({
      method: "POST",
      url: "/readme/lab/session",
      payload: { invite_code: invite, cloud_consent: true },
    });
    expect(missing.json()).toEqual({ error: "cloud_consent_required" });
    await login(app);
    vi.stubEnv("README_LAB_ENGINE", "misspelled");
    const invalid = Fastify();
    apps.push(invalid);
    expect(() => registerReadmeLabRoutes(invalid)).toThrow(
      "Unknown README Lab engine",
    );
  });
  it("announces Jev before reading, then preserves ordered events, report and ownership", async () => {
    const { app, document, reader } = setup();
    const headers = await login(app),
      prepared = await prepare(app, headers);
    const otherHeaders = await login(app);
    const bad = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: { ...startBody(prepared), input_hash: "0".repeat(64) },
    });
    expect(bad.statusCode).toBe(409);
    const foreign = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers: otherHeaders,
      payload: startBody(prepared),
    });
    expect(foreign.statusCode).toBe(404);
    const response = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: startBody(prepared),
    });
    expect(response.statusCode).toBe(202);
    let view = response.json<JobView>();
    expect(view.generation).toMatchObject({
      engine: "jev",
      policy_version: "readme-prefix-v2",
      model: reader.metadata,
      prepare_engine: "codex_cli",
      report_engine: "codex_cli",
    });
    await vi.waitFor(async () => {
      view = (
        await app.inject({ url: `/readme/lab/jobs/${view.job_id}`, headers })
      ).json<JobView>();
      expect(view.status).toBe("completed");
    });
    expect(view.progress.read_unit_count).toBe(document.units.length);
    expect(view.events.map((e) => e.seq)).toEqual(
      view.events.map((_, i) => i + 1),
    );
    expect(view.report?.questions[0]?.status).toBe("resolved");
    expect(view.report?.limitations.join(" ")).toContain("공고에서 만든 기준");
    expect(view.report?.limitations.join(" ")).not.toMatch(
      /확률 보정|설명됨|순차 독해|Laya/,
    );
    expect(reader.close).toHaveBeenCalledTimes(1);
    const again = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: startBody(prepared),
    });
    expect(again.json<JobView>().job_id).toBe(view.job_id);
    const cursor = await app.inject({
      url: `/readme/lab/jobs/${view.job_id}?after_seq=${view.next_seq}`,
      headers,
    });
    expect(cursor.json<JobView>().events).toEqual([]);
    expect(
      (
        await app.inject({
          url: `/readme/lab/jobs/${view.job_id}`,
          headers: otherHeaders,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("keeps partial events and budget failure, closes Jev and never generates a report", async () => {
    const { app, reader, reasoner } = setup();
    const normal = vi.mocked(reader.readStep).getMockImplementation()!;
    vi.mocked(reader.readStep)
      .mockImplementationOnce(normal)
      .mockRejectedValueOnce(new LabError("engine_budget_exceeded"));
    const headers = await login(app),
      prepared = await prepare(app, headers);
    const response = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: startBody(prepared),
    });
    let view = response.json<JobView>();
    await vi.waitFor(async () => {
      view = (
        await app.inject({ url: `/readme/lab/jobs/${view.job_id}`, headers })
      ).json<JobView>();
      expect(view.status).toBe("failed");
    });
    expect(view.error).toBe("engine_budget_exceeded");
    expect(view.events.at(-1)).toMatchObject({
      type: "failed",
      error: "engine_budget_exceeded",
      partial: true,
    });
    expect(view.progress.read_unit_count).toBe(1);
    expect(view.events.some((event) => event.type === "note")).toBe(true);
    expect(view.report).toBeNull();
    expect(reasoner.report).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalledTimes(1);
  });
  it("cancels a Jev step and ignores results delivered after cancellation", async () => {
    const { app, reader, reasoner } = setup();
    let release!: (value: Awaited<ReturnType<JevReader["readStep"]>>) => void;
    let signal!: AbortSignal;
    vi.mocked(reader.readStep).mockImplementationOnce((_input, incoming) => {
      signal = incoming;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const headers = await login(app),
      prepared = await prepare(app, headers);
    const response = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: startBody(prepared),
    });
    const id = response.json<JobView>().job_id;
    await vi.waitFor(() => expect(reader.readStep).toHaveBeenCalledTimes(1));
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/readme/lab/jobs/${id}`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(signal.aborted).toBe(true);
    const before = (
      await app.inject({ url: `/readme/lab/jobs/${id}`, headers })
    ).json<JobView>();
    release({ questions: [], updates: [], evidence: [], retractions: [] });
    await vi.waitFor(() => expect(reader.close).toHaveBeenCalledTimes(1));
    const after = (
      await app.inject({ url: `/readme/lab/jobs/${id}`, headers })
    ).json<JobView>();
    expect(after.status).toBe("cancelled");
    expect(after.events).toEqual(before.events);
    expect(after.report).toBeNull();
    expect(reasoner.report).not.toHaveBeenCalled();
  });
  it("rejects a profile-less Jev job before opening the reader", async () => {
    const { app, job, open } = setup();
    delete job.reader_profile;
    const headers = await login(app),
      prepared = await prepare(app, headers);
    const response = await app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: startBody(prepared),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "engine_input_invalid" });
    expect(open).not.toHaveBeenCalled();
  });
});
