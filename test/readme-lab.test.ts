import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { registerReadmeLabRoutes } from "../src/routes/readme-lab.js";
import {
  buildDocument,
  extractDocument,
  textBlocks,
} from "../src/services/readme-lab/document.js";
import {
  CodexReasoner,
  codexArgs,
  validateProfile,
  validateReport,
  reportOutputSchema,
  type Reasoner,
} from "../src/services/readme-lab/codex.js";
import type { Classifier, Decision } from "../src/services/readme-lab/laya.js";
import type {
  JobPosting,
  LayaMetadata,
  Note,
  Question,
} from "../src/services/readme-lab/contracts.js";
import { judgePrefix } from "../src/services/readme-lab/judgment.js";
import { ReadmeLab } from "../src/services/readme-lab/service.js";
import {
  emptyReading,
  mergeJob,
} from "../src/services/readme-lab/browser-client.js";
import {
  modelEnvironment,
  runCommand,
} from "../src/services/readme-lab/process.js";
import { parseDocument } from "../src/services/readme-lab/parser.js";

const invite = "synthetic-invitation-for-tests-only";
const text =
  "# 프로젝트 A\n성과 향상에 기여했습니다. 제가 안내문과 일정표를 작성했습니다.\n# 프로젝트 B\n제가 다른 팀의 보고서를 작성했습니다.";
const input = {
  job_text: "필수: 안내문 작성 경험과 일정 조정 경험을 요구합니다.",
  resume_filename: "synthetic.md",
  resume_media_type: "text/markdown",
  resume_base64: Buffer.from(text).toString("base64"),
};
const metadata: LayaMetadata = {
  model: "convaiinnovations/laya-multilingual",
  revision: "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67",
  sdk: "0.3.25",
  device: "test_double",
  weights_sha256: "0".repeat(64),
  finetuned: false,
  calibrated_for_readme: false,
};
const job: JobPosting = {
  source: "user_paste",
  text: input.job_text,
  requirements: [
    {
      id: "r1",
      kind: "required",
      label: "안내문 작성",
      quote: "안내문 작성 경험",
      start: 4,
      end: 13,
    },
  ],
  warnings: [],
};
function classifier(): Classifier {
  return {
    metadata,
    close: vi.fn(),
    predict: vi.fn((kind: string, state: unknown) => {
      const current = (state as { current: string }).current;
      const value: Decision =
        kind === "unit"
          ? {
              signal: {
                label: current.includes("기여")
                  ? "claim"
                  : current.startsWith("#")
                    ? "context"
                    : "concrete",
                confidence: 0.99,
              },
              missing: {
                label: current.includes("기여") ? "role" : "none",
                confidence: 0.99,
              },
            }
          : kind === "relation"
            ? { relation: { label: "answers", confidence: 0.99 } }
            : { relevance: { label: "supports", confidence: 0.99 } };
      return Promise.resolve(value);
    }),
  };
}
const reasoner: Reasoner = {
  model: "test_double",
  profile: () => Promise.resolve(job),
  report: (document, posting, notes, questions) =>
    Promise.resolve(
      validateReport(
        {
          items: notes.slice(0, 1).map((n) => ({
            category: "open",
            text: n.text,
            reason: "원문 확인",
            note_ids: [n.id],
            requirement_ids: [],
          })),
        },
        document,
        posting,
        notes,
        questions,
      ),
    ),
};
function makeLab(
  options: Partial<ConstructorParameters<typeof ReadmeLab>[0]> = {},
) {
  return new ReadmeLab({
    invitations: [invite],
    reasoner,
    classifier: () => Promise.resolve(classifier()),
    parse: () => Promise.resolve(buildDocument(textBlocks(text), "md")),
    ...options,
  });
}
async function ready(
  lab: ReadmeLab,
  session: ReturnType<ReadmeLab["authenticate"]>,
) {
  const prep = lab.prepare(session, input);
  await vi.waitFor(() =>
    expect(lab.getPrepare(session, prep.prepare_id).status).toBe("ready"),
  );
  return lab.getPrepare(session, prep.prepare_id);
}

describe("README lab document contract", () => {
  it("reads every soft-break line even without terminal punctuation", () => {
    const content =
      "본인이 맡은 핵심 업무를 첫 줄에 작성했습니다\n뒤 문장에 보조 업무를 작성했습니다.";
    const document = buildDocument(
      [{ type: "paragraph", text: content }],
      "docx",
    );
    expect(document.units.map((unit) => unit.text)).toEqual(
      content.split("\n"),
    );
    for (const unit of document.units)
      expect(content.slice(unit.start, unit.end)).toBe(unit.text);
  });
  it("keeps text, headings, lists and exact UTF16 slices without splitting emoji", () => {
    const content = `# 제목\n- ${"가".repeat(397)}😀나.\n다른 설명입니다.`;
    const document = buildDocument(textBlocks(content), "md");
    expect(document.blocks.map((b) => b.text).join("\n")).toBe(content);
    expect(document.blocks.map((b) => b.type)).toEqual([
      "heading",
      "list_item",
      "paragraph",
    ]);
    for (const unit of document.units) {
      expect(
        document.blocks
          .find((b) => b.id === unit.block_id)!
          .text.slice(unit.start, unit.end),
      ).toBe(unit.text);
      expect(
        new TextDecoder().decode(new TextEncoder().encode(unit.text)),
      ).toBe(unit.text);
    }
  });
  it("rejects excess content instead of silently dropping a tail", () => {
    expect(() =>
      buildDocument(textBlocks("문장입니다.\n".repeat(121)), "txt"),
    ).toThrow("document_too_long");
    expect(() => buildDocument(textBlocks("가".repeat(24001)), "txt")).toThrow(
      "document_too_long",
    );
  });
  it("extracts existing synthetic PDF/DOCX and surfaces fidelity warnings", async () => {
    const directory = new URL("./fixtures/readme/", import.meta.url);
    const { readdir } = await import("node:fs/promises");
    for (const file of (await readdir(directory)).filter((n) =>
      /\.(pdf|docx)$/u.test(n),
    )) {
      const bytes = await readFile(new URL(file, directory));
      const document = await extractDocument({
        ...input,
        resume_filename: file,
        resume_media_type: "",
        resume_base64: bytes.toString("base64"),
      });
      expect(document.warnings.length).toBeGreaterThan(0);
      expect(document.units.length).toBeGreaterThan(0);
    }
  });
  it("isolates parser cancellation and timeouts", async () => {
    await expect(
      parseDocument(input, new AbortController().signal, 0),
    ).rejects.toMatchObject({ code: "engine_timeout" });
    await expect(
      parseDocument(input, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("sequential judgment boundary", () => {
  it("preserves new job evidence even when a different earlier question has the same facet", async () => {
    const document = buildDocument(
      textBlocks(
        "프로그램 만족도를 높였습니다. 제가 안내문을 직접 작성해 접수 오류를 줄였습니다.",
      ),
      "txt",
    );
    const engine = classifier();
    engine.predict = (kind, value) =>
      Promise.resolve<Decision>(
        kind === "unit"
          ? {
              signal: {
                label: (value as { current: string }).current.includes("제가")
                  ? "concrete"
                  : "claim",
                confidence: 0.99,
              },
              missing: { label: "basis", confidence: 0.99 },
            }
          : kind === "relevance"
            ? { relevance: { label: "supports", confidence: 0.99 } }
            : { relation: { label: "unrelated", confidence: 0.99 } },
      );
    const notes: Note[] = [];
    const questions: Question[] = [];
    for (let i = 0; i < 2; i++)
      await judgePrefix(
        document.units.slice(0, i + 1),
        job,
        engine,
        notes,
        questions,
        () => undefined,
      );
    expect(questions).toHaveLength(1);
    expect(questions[0]?.status).toBe("open");
    expect(notes[1]).toMatchObject({
      kind: "evidence",
      unit_id: "u2",
      requirement_ids: ["r1"],
    });
    expect(notes.filter((n) => n.kind === "question")).toHaveLength(1);
  });
  it("does not turn low confidence or repeated questions into per-sentence cards", async () => {
    const document = buildDocument(
      textBlocks(
        "성과 향상에 기여했습니다. 운영 개선에 기여했습니다. 새로운 업무를 배웠습니다.",
      ),
      "txt",
    );
    const engine = classifier();
    const notes: Note[] = [];
    const questions: Question[] = [];
    const emit = vi.fn();
    for (let i = 0; i < 2; i++)
      await judgePrefix(
        document.units.slice(0, i + 1),
        job,
        engine,
        notes,
        questions,
        emit,
      );
    engine.predict = () =>
      Promise.resolve({
        signal: { label: "claim", confidence: 0.4 },
        missing: { label: "role", confidence: 0.4 },
      });
    await judgePrefix(document.units, job, engine, notes, questions, emit);
    expect(notes).toHaveLength(1);
    expect(questions).toHaveLength(1);
    expect(notes[0]?.text).toContain(document.units[0]!.text);
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it("asks for missing measurement basis even when an action is concrete", async () => {
    const engine = classifier();
    engine.predict = () =>
      Promise.resolve({
        signal: { label: "concrete", confidence: 0.99 },
        missing: { label: "basis", confidence: 0.99 },
      });
    const notes: Note[] = [];
    const questions: Question[] = [];
    await judgePrefix(
      buildDocument(
        textBlocks("제가 절차를 개선해 효율을 40% 향상시켰습니다."),
        "txt",
      ).units,
      { ...job, requirements: [] },
      engine,
      notes,
      questions,
      () => undefined,
    );
    expect(notes[0]?.kind).toBe("question");
    expect(questions[0]?.text).toContain("측정 근거");
  });
  it("makes identical prefix decisions regardless of future content", async () => {
    const document = buildDocument(textBlocks(text), "md");
    const first = classifier();
    const second = classifier();
    const notesA: Note[] = [];
    const notesB: Note[] = [];
    await judgePrefix(
      document.units.slice(0, 2),
      job,
      first,
      notesA,
      [],
      () => undefined,
    );
    const changedFuture = [
      ...document.units.slice(0, 2),
      { ...document.units[2]!, text: "FUTURE SECRET ANSWER" },
    ];
    await judgePrefix(
      changedFuture.slice(0, 2),
      job,
      second,
      notesB,
      [],
      () => undefined,
    );
    expect(notesA).toEqual(notesB);
    expect(vi.mocked(first.predict).mock.calls).toEqual(
      vi.mocked(second.predict).mock.calls,
    );
    expect(JSON.stringify(vi.mocked(second.predict).mock.calls)).not.toContain(
      "FUTURE",
    );
  });
  it("holds same-scope answer candidates and never resolves from another project", async () => {
    const document = buildDocument(textBlocks(text), "md");
    const engine = classifier();
    const notes: Note[] = [];
    const questions: Question[] = [];
    for (let i = 0; i < document.units.length; i++)
      await judgePrefix(
        document.units.slice(0, i + 1),
        job,
        engine,
        notes,
        questions,
        () => undefined,
      );
    expect(questions[0]?.status).toBe("held");
    expect(questions[0]?.candidate_unit_ids).toEqual(["u3"]);
    // Removing a duplicate evidence card must not drop its posting linkage.
    expect(notes.filter((n) => n.unit_id === "u3")).toHaveLength(1);
    expect(notes.find((n) => n.unit_id === "u3")?.requirement_ids).toEqual([
      "r1",
    ]);
    expect(
      vi.mocked(engine.predict).mock.calls.filter((c) => c[0] === "relation"),
    ).toHaveLength(1);
    for (const note of notes)
      for (const id of note.evidence_unit_ids)
        expect(
          document.units.find((u) => u.id === id)!.order,
        ).toBeLessThanOrEqual(
          document.units.find((u) => u.id === note.unit_id)!.order,
        );
    expect(notes.every((n) => n.review_required)).toBe(true);
  });
  it("rejects unknown model labels", async () => {
    const engine = classifier();
    engine.predict = () =>
      Promise.resolve({ signal: { label: "hire", confidence: 1 } });
    await expect(
      judgePrefix(
        buildDocument(textBlocks(text), "md").units.slice(0, 1),
        job,
        engine,
        [],
        [],
        () => undefined,
      ),
    ).rejects.toThrow("engine_output_invalid");
  });
});

describe("Codex boundary", () => {
  it("limits report generation to actual note links and categories", () => {
    const note: Note = {
      id: "n1",
      unit_id: "u1",
      span: { block_id: "b1", start: 0, end: 10 },
      kind: "observation",
      text: "판단 보류",
      evidence_unit_ids: ["u1"],
      requirement_ids: [],
      review_required: true,
    };
    const item = {
      category: "open",
      text: "원문 확인",
      reason: "판단 보류",
      note_ids: ["n1"],
      requirement_ids: [],
    };
    const schema = reportOutputSchema([note]);
    expect(schema.safeParse({ items: [item] }).success).toBe(true);
    expect(
      schema.safeParse({ items: [{ ...item, category: "explained" }] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ items: [{ ...item, requirement_ids: ["r1"] }] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ items: [{ ...item, note_ids: ["n2"] }] }).success,
    ).toBe(false);
  });
  it("requires literal source quotes and allows no extracted requirements", () => {
    expect(
      validateProfile({ requirements: [] }, input.job_text).warnings,
    ).toHaveLength(1);
    expect(() =>
      validateProfile(
        {
          requirements: [
            { kind: "required", label: "가짜", quote: "없는 내용" },
          ],
        },
        input.job_text,
      ),
    ).toThrow("engine_output_invalid");
  });
  it("rejects invented report references and claimed explanations without evidence", () => {
    const document = buildDocument(textBlocks(text), "md");
    expect(() =>
      validateReport(
        {
          items: [
            {
              category: "explained",
              text: "통과",
              reason: "왜",
              note_ids: ["fake"],
              requirement_ids: [],
            },
          ],
        },
        document,
        job,
        [],
        [],
      ),
    ).toThrow("engine_output_invalid");
  });
  it("disables tools and never passes server secrets to the CLI", () => {
    vi.stubEnv("OPENAI_API_KEY", "not-a-real-key");
    vi.stubEnv("DATABASE_URL", "not-a-real-db");
    try {
      const env = modelEnvironment();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      const args = codexArgs("/tmp/test");
      expect(args).toContain("--ephemeral");
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("read-only");
      expect(args).toContain("shell_tool");
      expect(args.at(-1)).toBe("-");
      expect(new CodexReasoner().model).toBe("cli_default");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("terminates a hung process and honors pre-cancellation", async () => {
    const command = {
      binary: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      input: "",
      timeoutMs: 20,
      signal: new AbortController().signal,
    };
    await expect(runCommand(command)).rejects.toMatchObject({
      code: "engine_timeout",
    });
    await expect(
      runCommand({ ...command, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("lab workflow and transport", () => {
  it("reclaims a cancelled queued reading while retaining an active aborting slot", async () => {
    const open = vi.fn(
      (signal: AbortSignal) =>
        new Promise<Classifier>((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          ),
        ),
    );
    const lab = makeLab({ classifier: open, dailyLimit: 10 });
    try {
      const session = lab.authenticate(lab.session(invite, true).access_token);
      const prepared: Awaited<ReturnType<typeof ready>>[] = [];
      for (let i = 0; i < 6; i++) prepared.push(await ready(lab, session));
      const start = (index: number) =>
        lab.start(
          session,
          prepared[index]!.prepare_id,
          prepared[index]!.input_hash,
          true,
        );
      const first = start(0);
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      const queued = start(1);
      start(2);
      start(3);
      expect(() => start(4)).toThrow("queue_full");
      lab.cancel(session, queued.job_id);
      expect(lab.getJob(session, queued.job_id, 0).status).toBe("cancelled");
      expect(start(4).status).toBe("queued");
      expect(open).toHaveBeenCalledTimes(1);
      lab.cancel(session, first.job_id);
      // Abort does not release the active slot until its promise settles.
      expect(() => start(5)).toThrow("queue_full");
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
      expect(start(5).status).toBe("queued");
      expect(
        lab.getJob(session, queued.job_id, 0).events.map((e) => e.type),
      ).toEqual(["cancelled"]);
    } finally {
      lab.close();
    }
  });
  it("bounds the queue and starts only one parser at a time", async () => {
    const parse = vi.fn(
      (_input: typeof input, signal: AbortSignal) =>
        new Promise<ReturnType<typeof buildDocument>>((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          ),
        ),
    );
    const lab = makeLab({ parse, dailyLimit: 10 });
    try {
      const session = lab.authenticate(lab.session(invite, true).access_token);
      const first = lab.prepare(session, input);
      const queued = lab.prepare(session, input);
      for (let i = 0; i < 2; i++) lab.prepare(session, input);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(() => lab.prepare(session, input)).toThrow("queue_full");
      lab.cancelPrepare(session, queued.prepare_id);
      expect(lab.getPrepare(session, queued.prepare_id).status).toBe(
        "cancelled",
      );
      expect(lab.prepare(session, input).status).toBe("queued");
      expect(parse).toHaveBeenCalledTimes(1);
      expect(() => lab.prepare(session, input)).toThrow("queue_full");
      lab.cancelPrepare(session, first.prepare_id);
      await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(2));
      expect(lab.getPrepare(session, first.prepare_id).status).toBe(
        "cancelled",
      );
    } finally {
      lab.close();
    }
  });
  it("preserves request error semantics instead of reporting a model outage", async () => {
    const app = Fastify();
    const lab = makeLab();
    registerReadmeLabRoutes(app, lab);
    try {
      const malformed = await app.inject({
        method: "POST",
        url: "/readme/lab/session",
        headers: { "content-type": "application/json" },
        payload: "{",
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: "invalid_input" });
      const oversized = await app.inject({
        method: "POST",
        url: "/readme/lab/session",
        payload: { invite_code: "x".repeat(600), cloud_consent: true },
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toEqual({ error: "request_too_large" });
      const media = await app.inject({
        method: "POST",
        url: "/readme/lab/session",
        headers: { "content-type": "application/xml" },
        payload: "<x/>",
      });
      expect(media.statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });
  it("requires consent, auth, ownership, unchanged input and explicit start", async () => {
    const lab = makeLab();
    try {
      expect(() => lab.session(invite, false)).toThrow(
        "cloud_consent_required",
      );
      expect(() => lab.session("wrong", true)).toThrow("invite_invalid");
      const a = lab.authenticate(lab.session(invite, true).access_token);
      const b = lab.authenticate(lab.session(invite, true).access_token);
      const prep = await ready(lab, a);
      expect(() => lab.getPrepare(b, prep.prepare_id)).toThrow("not_found");
      expect(() =>
        lab.start(a, prep.prepare_id, prep.input_hash, false),
      ).toThrow("confirmation_required");
      expect(() => lab.start(a, prep.prepare_id, "changed", true)).toThrow(
        "prepare_input_changed",
      );
      const reading = lab.start(a, prep.prepare_id, prep.input_hash, true);
      expect(lab.start(a, prep.prepare_id, prep.input_hash, true).job_id).toBe(
        reading.job_id,
      );
      await vi.waitFor(() =>
        expect(lab.getJob(a, reading.job_id, 0).status).toBe("completed"),
      );
      const all = lab.getJob(a, reading.job_id, 0);
      expect(lab.getJob(a, reading.job_id, 0)).toEqual(all);
      expect(lab.getJob(a, reading.job_id, all.next_seq).events).toEqual([]);
      expect(() => lab.getJob(a, reading.job_id, all.next_seq + 1)).toThrow(
        "invalid_cursor",
      );
      const merged = mergeJob(emptyReading(), all);
      expect(mergeJob(merged, all).events).toEqual(all.events);
      expect(() =>
        mergeJob(emptyReading(), { ...all, events: all.events.slice(1) }),
      ).toThrow("event_gap");
    } finally {
      lab.close();
    }
  });
  it("shares daily budget across renewed sessions", async () => {
    const lab = makeLab({ dailyLimit: 1 });
    try {
      const a = lab.authenticate(lab.session(invite, true).access_token);
      await ready(lab, a);
      const b = lab.authenticate(lab.session(invite, true).access_token);
      expect(() => lab.prepare(b, input)).toThrow("daily_limit_reached");
    } finally {
      lab.close();
    }
  });
  it("keeps partial notes when the report fails without a fake final result", async () => {
    const lab = makeLab({
      reasoner: {
        ...reasoner,
        report: () => Promise.reject(new Error("private-error-must-not-leak")),
      },
    });
    try {
      const session = lab.authenticate(lab.session(invite, true).access_token);
      const prep = await ready(lab, session);
      const reading = lab.start(
        session,
        prep.prepare_id,
        prep.input_hash,
        true,
      );
      await vi.waitFor(() =>
        expect(lab.getJob(session, reading.job_id, 0).status).toBe("failed"),
      );
      const failed = lab.getJob(session, reading.job_id, 0);
      expect(failed.report).toBeNull();
      expect(failed.events.some((e) => e.type === "note")).toBe(true);
      expect(JSON.stringify(failed)).not.toContain("private-error");
    } finally {
      lab.close();
    }
  });
  it("cancels abandoned work and expires documents", () => {
    let now = 0;
    const lab = makeLab({
      now: () => now,
      ttlMs: 1000,
      leaseMs: 100,
      parse: (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          ),
        ),
    });
    try {
      const token = lab.session(invite, true).access_token;
      const session = lab.authenticate(token);
      const prep = lab.prepare(session, input);
      now = 101;
      lab.sweep();
      expect(lab.getPrepare(session, prep.prepare_id).status).toBe("cancelled");
      now = 1001;
      lab.sweep();
      expect(() => lab.authenticate(token)).toThrow("invite_invalid");
    } finally {
      lab.close();
    }
  });
  it("enforces HTTP access controls and noindex/no-store", async () => {
    const app = Fastify();
    const lab = makeLab();
    registerReadmeLabRoutes(app, lab);
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/readme/lab/prepare",
        payload: input,
      });
      expect(denied.statusCode).toBe(401);
      const auth = await app.inject({
        method: "POST",
        url: "/readme/lab/session",
        payload: { invite_code: invite, cloud_consent: true },
      });
      expect(auth.headers["x-robots-tag"]).toContain("noindex");
      expect(auth.headers["cache-control"]).toContain("no-store");
      const token = auth.json<{ access_token: string }>().access_token;
      const prep = await app.inject({
        method: "POST",
        url: "/readme/lab/prepare",
        headers: { authorization: `Bearer ${token}` },
        payload: input,
      });
      expect(prep.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
});
