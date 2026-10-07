/** Transport tests replay recorded synthetic Jev output; not new quality measurements. */
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReadmeLabRoutes } from "../src/routes/readme-lab.js";
import { ReadmeLab } from "../src/services/readme-lab/service.js";
import { openFocusJev } from "../src/services/readme-lab/focus-jev.js";
import { LabError } from "../src/services/readme-lab/errors.js";
import type { Reasoner } from "../src/services/readme-lab/codex.js";
import type {
  JobPosting,
  JobView,
  PrepareView,
  ResumeDocument,
} from "../src/services/readme-lab/contracts.js";

const invite = "synthetic-focus-invite-not-for-production";
const texts = (
  JSON.parse(
    readFileSync("test/fixtures/readme/focus-recorded-v1.json", "utf8"),
  ) as { cases: Array<{ units: string[] }> }
).cases[0]!.units;
const document: ResumeDocument = {
  doc_id: "synthetic",
  source_kind: "md",
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
    type: text.startsWith("#") ? "heading" : "paragraph",
    text,
    unit_ids: [`u${i + 1}`],
  })),
};
const input = {
  job_text: "개발 업무 경험을 확인하는 합성 검증용 공고입니다.",
  resume_filename: "synthetic.md",
  resume_media_type: "text/markdown",
  resume_base64: Buffer.from(texts.join("\n")).toString("base64"),
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function setup(mode: "normal" | "fail" | "finish-fail" | "stall" = "normal") {
  const job: JobPosting = {
    source: "user_paste",
    text: input.job_text,
    requirements: [
      {
        id: "r1",
        kind: "duty",
        label: "개발",
        quote: "개발",
        start: 0,
        end: 2,
      },
      {
        id: "r2",
        kind: "required",
        label: "not-sent-to-reader",
        quote: "경험",
        start: 6,
        end: 8,
      },
    ],
    warnings: [],
    reader_profile: { id: "p1", version: "reader-profile-v2", criteria: [] },
  };
  const report = vi.fn<Reasoner["report"]>(
    (doc, posting, _notes, questions, _signal, memory) => {
      expect(doc).toEqual(document);
      expect(posting).toEqual(job);
      expect(memory?.focus?.questions[0]?.status).toBe("resolved");
      return Promise.resolve({
        items: [],
        questions,
        limitations: ["synthetic report stub"],
      });
    },
  );
  const readContexts: string[] = [];
  const open = vi.fn(async (signal: AbortSignal, total: number) => {
    const worker = await openFocusJev(signal, total, {
      apiKey: "synthetic-no-remote-credential",
      script: resolve("test/fixtures/readme/focus-worker-stub.py"),
      timeoutMs: 3000,
    });
    const read = worker.readStep.bind(worker);
    worker.readStep = (prefix, context) => {
      readContexts.push(context);
      return read(
        prefix,
        mode === "normal" || mode === "finish-fail" ? context : mode,
      );
    };
    if (mode === "finish-fail")
      worker.finish = () => Promise.reject(new LabError("reader_not_complete"));
    return worker;
  });
  const parse = vi.fn(() => Promise.resolve(document));
  const lab = new ReadmeLab({
    invitations: [invite],
    parse,
    reasoner: {
      model: "test-double",
      profile: () => Promise.resolve(job),
      report,
    },
    focus: open,
  });
  const app = Fastify();
  apps.push(app);
  registerReadmeLabRoutes(app, lab);
  return { app, open, parse, report, readContexts };
}
async function start(app: FastifyInstance) {
  const login = await app.inject({
    method: "POST",
    url: "/readme/lab/session",
    payload: {
      invite_code: invite,
      cloud_consent: true,
      consent_version: "readme-jev-v1",
    },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    authorization: `Bearer ${login.json<{ access_token: string }>().access_token}`,
  };
  const preparation = await app.inject({
    method: "POST",
    url: "/readme/lab/prepare",
    headers,
    payload: input,
  });
  expect(preparation.statusCode, preparation.body).toBe(202);
  let prepared = preparation.json<PrepareView>();
  await vi.waitFor(async () => {
    prepared = (
      await app.inject({
        url: `/readme/lab/prepare/${prepared.prepare_id}`,
        headers,
      })
    ).json<PrepareView>();
    expect(prepared.status).toBe("ready");
  });
  const created = await app.inject({
    method: "POST",
    url: "/readme/lab/jobs",
    headers,
    payload: {
      prepare_id: prepared.prepare_id,
      input_hash: prepared.input_hash,
      confirmed: true,
    },
  });
  expect(created.statusCode).toBe(202);
  const job = created.json<JobView>();
  return { headers, url: `/readme/lab/jobs/${job.job_id}` };
}
describe("opt-in focus HTTP stream", () => {
  it("requires existing remote consent before model work", async () => {
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
  it("streams validated windows, completes before reporting, and reconnects without new events", async () => {
    const { app, report, readContexts, open } = setup(),
      { headers, url } = await start(app);
    let view: JobView;
    await vi.waitFor(async () => {
      view = (await app.inject({ url, headers })).json<JobView>();
      expect(view.status).toBe("completed");
    });
    const full = view!;
    expect(full.generation.policy_version).toBe("readme-focus-v1");
    expect(full.progress.read_unit_count).toBe(3);
    expect(full.events.map((e) => e.seq)).toEqual(
      full.events.map((_, i) => i + 1),
    );
    expect(full.events.filter((e) => e.type === "updated")).toHaveLength(1);
    expect(
      full.events.some(
        (e) => e.type === "question_updated" || e.type === "note",
      ),
    ).toBe(false);
    expect(full.events.slice(-2).map((e) => e.type)).toEqual([
      "reading_completed",
      "report_completed",
    ]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(readContexts).toEqual(["개발", "개발", "개발"]);
    const after = 4;
    const replay = (
      await app.inject({ url: `${url}?after_seq=${after}`, headers })
    ).json<JobView>();
    expect(replay.events).toEqual(full.events.filter((e) => e.seq > after));
    expect(replay.next_seq).toBe(full.next_seq);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("does not publish a failed window or run a partial report", async () => {
    const { app, report } = setup("fail"),
      { headers, url } = await start(app);
    await vi.waitFor(async () => {
      const view = (await app.inject({ url, headers })).json<JobView>();
      expect(view.status).toBe("failed");
      expect(view.progress.read_unit_count).toBe(1);
      expect(view.events.at(-1)).toMatchObject({
        type: "failed",
        partial: true,
        error: "engine_unavailable",
      });
      expect(
        view.events.filter((e) => e.type === "window_completed"),
      ).toHaveLength(1);
      expect(
        view.events.some(
          (e) => e.type === "inquiry" || e.type === "reading_completed",
        ),
      ).toBe(false);
    });
    expect(report).not.toHaveBeenCalled();
  });
  it("does not equate the last window with a confirmed final ledger", async () => {
    const { app, report } = setup("finish-fail"),
      { headers, url } = await start(app);
    await vi.waitFor(async () => {
      const view = (await app.inject({ url, headers })).json<JobView>();
      expect(view.status).toBe("failed");
      expect(view.progress.read_unit_count).toBe(3);
      expect(view.events.some((e) => e.type === "reading_completed")).toBe(
        false,
      );
    });
    expect(report).not.toHaveBeenCalled();
  });
  it("cancels an in-flight worker and suppresses later report/events", async () => {
    const { app, report, readContexts } = setup("stall"),
      { headers, url } = await start(app);
    await vi.waitFor(() => expect(readContexts).toHaveLength(1));
    const response = await app.inject({ method: "DELETE", url, headers });
    expect(response.statusCode).toBe(204);
    await vi.waitFor(async () => {
      const view = (await app.inject({ url, headers })).json<JobView>();
      expect(view.status).toBe("cancelled");
      expect(view.events.at(-1)?.type).toBe("cancelled");
      expect(view.progress.read_unit_count).toBe(0);
    });
    expect(report).not.toHaveBeenCalled();
  });
});
