/** Authored protocol replay: HTTP invariants, not actual-model quality. */
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReadmeLabRoutes } from "../src/routes/readme-lab.js";
import {
  ReadmeLab,
  type LabOptions,
} from "../src/services/readme-lab/service.js";
import { openSituationJev } from "../src/services/readme-lab/situation-jev.js";
import { LabError } from "../src/services/readme-lab/errors.js";
import type { Reasoner } from "../src/services/readme-lab/codex.js";
import type {
  JobPosting,
  JobView,
  PrepareView,
  ResumeDocument,
} from "../src/services/readme-lab/contracts.js";
const policy = "readme-situation-v1";
const invite = "synthetic-situation-invite";
const texts = (
  JSON.parse(
    readFileSync("test/fixtures/readme/situation-contract-v1.json", "utf8"),
  ) as { cases: { id: string; units: string[] }[] }
).cases.find((c) => c.id === "partial_and_new")!.units;
const document: ResumeDocument = {
  doc_id: "synthetic",
  source_kind: "txt",
  truncated: false,
  warnings: [],
  units: texts.map((text, i) => ({
    id: `u${i + 1}`,
    block_id: `b${i + 1}`,
    order: i,
    scope_id: "s1",
    text,
    start: 0,
    end: text.length,
  })),
  blocks: texts.map((text, i) => ({
    id: `b${i + 1}`,
    type: "paragraph",
    text,
    unit_ids: [`u${i + 1}`],
  })),
};
const input = {
  job_text: "개발 업무 경험을 확인하는 합성 검증용 공고입니다.",
  resume_filename: "synthetic.txt",
  resume_media_type: "text/plain",
  resume_base64: Buffer.from(texts.join("\n")).toString("base64"),
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function setup(mode = "normal", supported = true) {
  const posting: JobPosting = {
    source: "user_paste",
    text: input.job_text,
    requirements: [],
    warnings: [],
    reader_profile: { id: "p1", version: "reader-profile-v2", criteria: [] },
  };
  const report = vi.fn<Reasoner["report"]>(
    (_doc, _posting, _notes, questions, _signal, memory) => {
      expect(memory?.situation?.is_deficiency).toBe(false);
      expect(
        memory?.situation?.expectations.every(
          (q) => q.status === "unresolved_at_end",
        ),
      ).toBe(true);
      expect(questions).toEqual([]);
      expect(JSON.stringify(memory?.situation)).not.toContain('"prompt"');
      return Promise.resolve({
        items: [],
        questions,
        limitations: ["synthetic report stub"],
      });
    },
  );
  const diagnostics = vi.fn<NonNullable<LabOptions["onReadingDiagnostic"]>>();
  const enteredFinish = vi.fn();
  const open = vi.fn<NonNullable<LabOptions["situation"]>>(
    async (signal, units) => {
      const worker = await openSituationJev(signal, units, {
        apiKey: "synthetic-not-remote-key",
        script: resolve("test/fixtures/readme/situation-worker-stub.py"),
        timeoutMs: 3000,
      });
      const read = worker.readStep.bind(worker),
        finish = worker.finish.bind(worker);
      worker.readStep = (prefix) => read(prefix, `partial_and_new:${mode}`);
      worker.finish = () => {
        enteredFinish();
        return finish();
      };
      return worker;
    },
  );
  // The existing focus HTTP suite verifies fallback completion. This spy makes
  // selecting the wrong engine unmistakable without using a remote provider.
  const focus = vi.fn<NonNullable<LabOptions["focus"]>>(() =>
    Promise.reject(new LabError("engine_unavailable")),
  );
  const parse = vi.fn<LabOptions["parse"]>(() => Promise.resolve(document));
  const lab = new ReadmeLab({
    invitations: [invite],
    parse,
    reasoner: {
      model: "test-double",
      profile: () => Promise.resolve(posting),
      report,
    },
    focus,
    ...(supported ? { situation: open } : {}),
    onReadingDiagnostic: diagnostics,
  });
  const app = Fastify();
  apps.push(app);
  registerReadmeLabRoutes(app, lab);
  return { app, open, focus, report, parse, diagnostics, enteredFinish };
}
async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/readme/lab/session",
    payload: {
      invite_code: invite,
      cloud_consent: true,
      consent_version: "readme-jev-v1",
    },
  });
  expect(response.statusCode).toBe(200);
  return {
    authorization: `Bearer ${response.json<{ access_token: string }>().access_token}`,
  };
}
async function prepare(app: FastifyInstance) {
  const headers = await login(app);
  const response = await app.inject({
    method: "POST",
    url: "/readme/lab/prepare",
    headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(202);
  let prepared = response.json<PrepareView>();
  await vi.waitFor(async () => {
    prepared = (
      await app.inject({
        url: `/readme/lab/prepare/${prepared.prepare_id}`,
        headers,
      })
    ).json<PrepareView>();
    expect(prepared.status).toBe("ready");
  });
  const create = (readerPolicy: unknown = policy) =>
    app.inject({
      method: "POST",
      url: "/readme/lab/jobs",
      headers,
      payload: {
        prepare_id: prepared.prepare_id,
        input_hash: prepared.input_hash,
        confirmed: true,
        ...(readerPolicy === undefined || readerPolicy === "omit"
          ? {}
          : { reader_policy: readerPolicy }),
      },
    });
  return { headers, create };
}
async function start(app: FastifyInstance) {
  const prepared = await prepare(app),
    created = await prepared.create();
  expect(created.statusCode, created.body).toBe(202);
  return {
    ...prepared,
    url: `/readme/lab/jobs/${created.json<JobView>().job_id}`,
  };
}
async function completed(
  app: FastifyInstance,
  headers: Record<string, string>,
  url: string,
) {
  let view: JobView | undefined;
  await vi.waitFor(async () => {
    view = (await app.inject({ url, headers })).json<JobView>();
    expect(view.status).toBe("completed");
  });
  return view!;
}
describe("explicit situation HTTP policy", () => {
  it("completes final events outside windows, strips conditions, and preserves cursor/ownership", async () => {
    const { app, open, focus, report, diagnostics } = setup(),
      { headers, url, create } = await start(app);
    const view = await completed(app, headers, url);
    expect(view.generation.policy_version).toBe(policy);
    expect(view.generation.engine).toBe("jev");
    expect(view.progress.read_unit_count).toBe(2);
    expect(view.progress.current_window).toBeNull();
    expect(view.events.map((e) => e.seq)).toEqual(
      view.events.map((_, i) => i + 1),
    );
    const end = view.events.map((e) => e.type).lastIndexOf("window_completed"),
      reading = view.events.findIndex((e) => e.type === "reading_completed");
    expect(view.events.slice(end + 1, reading).map((e) => e.type)).toEqual([
      "expectation_finished",
      "expectation_finished",
    ]);
    expect(view.events.slice(-2).map((e) => e.type)).toEqual([
      "reading_completed",
      "report_completed",
    ]);
    expect(JSON.stringify(view.events)).not.toContain('"sufficient"');
    expect(JSON.stringify(view.events)).not.toContain('"prompt"');
    const replay = (
      await app.inject({ url: `${url}?after_seq=3`, headers })
    ).json<JobView>();
    expect(replay.events).toEqual(view.events.filter((e) => e.seq > 3));
    expect(replay.next_seq).toBe(view.next_seq);
    expect((await create()).json<JobView>().job_id).toBe(view.job_id);
    expect(open).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(
      (await app.inject({ url, headers: await login(app) })).statusCode,
    ).toBe(404);
    expect(diagnostics.mock.calls.map(([d]) => d.phase)).toEqual([
      "reading_completed",
      "finished",
    ]);
    for (const [d] of diagnostics.mock.calls) {
      expect(d.decisions).toHaveProperty("situation");
      for (const text of texts) expect(JSON.stringify(d)).not.toContain(text);
    }
  });
  it("keeps omission on focus and rejects a policy change on the same preparation", async () => {
    const { app, open, focus } = setup(),
      { create } = await prepare(app);
    const first = await create("omit");
    expect(first.statusCode).toBe(202);
    expect(first.json<JobView>().generation.policy_version).toBe(
      "readme-focus-v1",
    );
    await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    expect((await create("omit")).json<JobView>().job_id).toBe(
      first.json<JobView>().job_id,
    );
    const switched = await create();
    expect(switched.statusCode).toBe(409);
    expect(switched.json()).toEqual({ error: "reader_policy_changed" });
    expect(open).not.toHaveBeenCalled();
  });
  it("rejects omission after situation policy selection", async () => {
    const { app } = setup(),
      { create } = await start(app);
    const switched = await create("omit");
    expect(switched.statusCode).toBe(409);
    expect(switched.json()).toEqual({ error: "reader_policy_changed" });
  });
  it("rejects explicit situation when the server factory is unavailable", async () => {
    const { app, open, focus } = setup("normal", false),
      { create } = await prepare(app);
    const response = await create();
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "reader_policy_unsupported" });
    expect(open).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
  for (const invalid of [null, "readme-focus-v1", "unknown", 1])
    it(`rejects malformed reader policy ${JSON.stringify(invalid)}`, async () => {
      const { app, open } = setup(),
        { create } = await prepare(app);
      const response = await create(invalid);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_input" });
      expect(open).not.toHaveBeenCalled();
    });
  for (const mode of ["fail", "finish-fail"])
    it(`retains the validated prefix and suppresses final/report on ${mode}`, async () => {
      const { app, report } = setup(mode),
        { url, headers } = await start(app);
      await vi.waitFor(async () => {
        const view = (await app.inject({ url, headers })).json<JobView>();
        expect(view.status).toBe("failed");
        expect(view.progress.read_unit_count).toBe(mode === "fail" ? 1 : 2);
        expect(
          view.events.filter((e) => e.type === "window_completed"),
        ).toHaveLength(mode === "fail" ? 1 : 2);
        expect(
          view.events.some((e) =>
            [
              "expectation_finished",
              "reading_completed",
              "report_completed",
            ].includes(e.type),
          ),
        ).toBe(false);
        expect(view.events.at(-1)).toMatchObject({
          type: "failed",
          partial: true,
        });
      });
      expect(report).not.toHaveBeenCalled();
    });
  it("cancels pending finish without synthesizing unresolved states or a report", async () => {
    const { app, report, enteredFinish } = setup("finish-stall"),
      { url, headers } = await start(app);
    await vi.waitFor(() => expect(enteredFinish).toHaveBeenCalledTimes(1));
    expect(
      (await app.inject({ method: "DELETE", url, headers })).statusCode,
    ).toBe(204);
    await vi.waitFor(async () => {
      const view = (await app.inject({ url, headers })).json<JobView>();
      expect(view.status).toBe("cancelled");
      expect(view.progress.read_unit_count).toBe(2);
      expect(
        view.events.some((e) =>
          [
            "expectation_finished",
            "reading_completed",
            "report_completed",
          ].includes(e.type),
        ),
      ).toBe(false);
      expect(view.events.at(-1)?.type).toBe("cancelled");
    });
    expect(report).not.toHaveBeenCalled();
  });
  it("requires the existing remote consent before parsing/model work", async () => {
    const { app, open, parse } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/readme/lab/session",
      payload: { invite_code: invite, cloud_consent: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "cloud_consent_required" });
    expect(open).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });
});
