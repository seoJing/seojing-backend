import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReadmeLabRoutes } from "../src/routes/readme-lab.js";
import {
  buildDocument,
  textBlocks,
} from "../src/services/readme-lab/document.js";
import {
  labUploadSchema,
  normalizeLabInput,
  type LabUploadInput,
} from "../src/services/readme-lab/input.js";
import { ReadmeLab } from "../src/services/readme-lab/service.js";
import type { JobPosting } from "../src/services/readme-lab/contracts.js";

const invite = "synthetic-essay-input-invitation";
const input: LabUploadInput = {
  job_text: "행사 참가자 문의 분류와 안내문 작성을 담당합니다.",
  resume_filename: "synthetic.md",
  resume_media_type: "text/markdown",
  resume_base64: Buffer.from(
    "저는 행사 참가자에게 전달할 안내문을 직접 작성했습니다.",
  ).toString("base64"),
};
const job: JobPosting = {
  source: "user_paste",
  text: input.job_text,
  requirements: [],
  warnings: [],
};
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function setup(
  options: { dailyLimit?: number; now?: () => number; ttlMs?: number } = {},
) {
  const document = buildDocument(
    textBlocks("저는 행사 참가자에게 전달할 안내문을 직접 작성했습니다."),
    "md",
  );
  const parse = vi.fn(() => Promise.resolve(document));
  const profile = vi.fn(() => Promise.resolve(job));
  const lab = new ReadmeLab({
    invitations: [invite],
    parse,
    reasoner: { model: "test-double", profile, report: vi.fn() },
    classifier: () => Promise.reject(new Error("reading not expected")),
    dailyLimit: 50,
    ...options,
  });
  cleanups.push(() => lab.close());
  const token = lab.session(invite, true).access_token;
  const session = lab.authenticate(token);
  const prepare = async (data: LabUploadInput) => {
    const p = lab.prepare(session, data);
    await vi.waitFor(() =>
      expect(lab.getPrepare(session, p.prepare_id).status).toBe("ready"),
    );
    return lab.getPrepare(session, p.prepare_id);
  };
  return { lab, session, token, prepare, parse, profile, document };
}

describe("essay input boundary", () => {
  it("normalizes optional fields, preserves duplicate order, and isolates source", () => {
    expect(labUploadSchema.parse(input)).toMatchObject({
      document_type: "resume",
      essay_prompts: [],
    });
    const value = normalizeLabInput({
      ...input,
      document_type: "cover_letter",
      essay_prompts: ["  지원 동기 ", " ", "입사 후 계획", "지원 동기"],
    });
    expect(value.essay_prompts).toEqual([
      "지원 동기",
      "입사 후 계획",
      "지원 동기",
    ]);
    expect(value.source).toEqual(input);
  });
  it.each([
    { document_type: "unknown" },
    { document_type: null },
    { essay_prompts: null },
    { essay_prompts: "제목" },
    { essay_prompts: [null] },
    { essay_prompts: [42] },
    { essay_prompts: Array(11).fill("") },
    { essay_prompts: ["😀".repeat(501)] },
    { essay_prompts: Array(7).fill("가".repeat(1000)) },
  ])("rejects malformed/oversized metadata before work: %j", (invalid) => {
    const data = { ...input, document_type: "cover_letter", ...invalid };
    expect(labUploadSchema.safeParse(data).success).toBe(false);
    expect(() => normalizeLabInput(data as LabUploadInput)).toThrow(
      "invalid_input",
    );
  });
  it("accepts exact UTF16/total limits, but rejects nonempty resume prompts", () => {
    expect(
      labUploadSchema.safeParse({
        ...input,
        document_type: "cover_letter",
        essay_prompts: Array(6).fill("😀".repeat(500)),
      }).success,
    ).toBe(true);
    expect(
      labUploadSchema.safeParse({ ...input, essay_prompts: ["지원 동기"] })
        .success,
    ).toBe(false);
    expect(
      labUploadSchema.safeParse({ ...input, essay_prompts: [" "] }).success,
    ).toBe(true);
    expect(
      labUploadSchema.safeParse({ ...input, unexpected: true }).success,
    ).toBe(false);
  });
  it("hashes canonical mode/prompts and keeps parser/profile input unchanged", async () => {
    const { prepare, parse, profile, document } = setup();
    const old = await prepare(input);
    const explicit = await prepare({
      ...input,
      document_type: "resume",
      essay_prompts: [],
    });
    expect(old.input_hash).toBe(explicit.input_hash);
    expect(old.document).not.toHaveProperty("document_context");
    const blank = await prepare({
      ...input,
      document_type: "cover_letter",
      essay_prompts: [" "],
    });
    expect(blank.input_hash).not.toBe(old.input_hash);
    expect(blank.document?.document_context).toEqual({
      type: "cover_letter",
      prompts: [],
    });
    const first = await prepare({
      ...input,
      document_type: "cover_letter",
      essay_prompts: [" 동기 ", "", "계획"],
    });
    const same = await prepare({
      ...input,
      document_type: "cover_letter",
      essay_prompts: ["동기", "계획"],
    });
    const reversed = await prepare({
      ...input,
      document_type: "cover_letter",
      essay_prompts: ["계획", "동기"],
    });
    expect(first.input_hash).toBe(same.input_hash);
    expect(first.input_hash).not.toBe(reversed.input_hash);
    expect(first.document?.document_context?.prompts).toEqual([
      { id: "ep1", text: "동기" },
      { id: "ep2", text: "계획" },
    ]);
    expect(first.document?.units).toEqual(old.document?.units);
    expect(first.document?.blocks).toEqual(old.document?.blocks);
    expect(document).not.toHaveProperty("document_context");
    for (const [source] of parse.mock.calls as unknown as [unknown][])
      expect(source).toEqual(input);
    for (const [text] of profile.mock.calls as unknown as [unknown][])
      expect(text).toBe(input.job_text);
  });
  it("snapshots caller input and binds confirmation, ownership, cancellation and expiry", async () => {
    let now = 1000;
    const { lab, session, prepare } = setup({ now: () => now, ttlMs: 10000 });
    const data: LabUploadInput = {
      ...input,
      document_type: "cover_letter",
      essay_prompts: ["원래 문항"],
    };
    const pending = lab.prepare(session, data);
    data.essay_prompts![0] = "수정된 문항";
    data.job_text = "수정된 공고";
    await vi.waitFor(() =>
      expect(lab.getPrepare(session, pending.prepare_id).status).toBe("ready"),
    );
    const original = lab.getPrepare(session, pending.prepare_id);
    expect(original.document?.document_context?.prompts[0]?.text).toBe(
      "원래 문항",
    );
    const changed = await prepare({
      ...input,
      document_type: "cover_letter",
      essay_prompts: ["다른 문항"],
    });
    expect(() =>
      lab.start(session, changed.prepare_id, original.input_hash, true),
    ).toThrow("prepare_input_changed");
    const other = lab.authenticate(lab.session(invite, true).access_token);
    expect(() => lab.getPrepare(other, pending.prepare_id)).toThrow(
      "not_found",
    );
    lab.cancelPrepare(session, pending.prepare_id);
    expect(lab.getPrepare(session, pending.prepare_id)).not.toHaveProperty(
      "document",
    );
    expect(() =>
      lab.start(session, pending.prepare_id, original.input_hash, true),
    ).toThrow("prepare_not_ready");
    now += 10001;
    expect(() => lab.getPrepare(session, changed.prepare_id)).toThrow(
      "expired",
    );
  });
  it("rejects invalid HTTP metadata without quota consumption, model calls or raw error text", async () => {
    const { lab, token, parse, profile } = setup({ dailyLimit: 1 });
    const app = Fastify();
    registerReadmeLabRoutes(app, lab);
    cleanups.push(() => app.close());
    const headers = { authorization: `Bearer ${token}` };
    const invalid = await app.inject({
      method: "POST",
      url: "/readme/lab/prepare",
      headers,
      payload: { ...input, essay_prompts: ["SYNTHETIC_PRIVATE_PROMPT"] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_input" });
    expect(parse).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    const good = await app.inject({
      method: "POST",
      url: "/readme/lab/prepare",
      headers,
      payload: { ...input, document_type: "cover_letter", essay_prompts: [] },
    });
    expect(good.statusCode).toBe(202);
  });
});
