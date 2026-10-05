import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { buildApp } from "../src/app.js";
import { buildUploadedPreview } from "../src/services/readme-upload.js";
import { analyzeReadmeInWorker } from "../src/services/readme-worker.js";
import type { ReadmePreview } from "../src/services/readme.js";

describe("README synthetic preview", () => {
  it("returns cited, sequential events without future evidence", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/readme/preview",
      payload: { case_id: "social-program-operator" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const body = response.json<ReadmePreview>();
    expect(body.mode).toBe("rules_preview");
    expect(body.resume.units).toHaveLength(4);
    const indexById = new Map<string, number>(
      body.resume.units.map((unit: { id: string; index: number }) => [
        unit.id,
        unit.index,
      ]),
    );
    for (const event of body.events) {
      for (const evidenceId of event.evidence_unit_ids ?? []) {
        expect(indexById.get(evidenceId) as number).toBeLessThanOrEqual(
          indexById.get(event.unit_id) as number,
        );
      }
    }
    expect(body.report.open_questions[0]?.unit_ids).toEqual(["u4"]);
    await app.close();
  });

  it("rejects unknown or raw applicant input", async () => {
    const app = await buildApp();
    for (const payload of [
      { case_id: "unknown" },
      { case_id: "social-program-operator", resume_text: "private" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/readme/preview",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });
});

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/readme/", import.meta.url),
);
const jobText =
  "Program operator wanted. Coordinate program schedules and write review checklists for participants.";

describe("README user upload", () => {
  it("terminates a slow analysis without blocking backend health", async () => {
    const app = await buildApp();
    await expect(
      analyzeReadmeInWorker(
        {
          job_text: jobText,
          resume_filename: "resume.txt",
          resume_media_type: "text/plain",
          resume_base64: Buffer.from(
            "Synthetic schedule planning and checklist writing.",
          ).toString("base64"),
        },
        0,
      ),
    ).rejects.toMatchObject({ code: "analysis_timeout", statusCode: 503 });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it("prefers Korean requirement bullets over a company introduction", () => {
    const result = buildUploadedPreview(
      "새로운 경험을 중시하는 지역 운영 회사입니다.\n■ 자격요건\n• 참여자 일정 조정 및 안내문 작성\n• 회의 기록과 결과 문서 작성\n■ 복지\n유연한 근무 시간을 제공합니다.",
      "참여자 일정을 조정하고 안내문을 작성했습니다. 회의 기록과 결과 문서를 작성했습니다.",
    );
    expect(
      result.job.criteria.map((criterion) => criterion.source_quote),
    ).toEqual([
      "참여자 일정 조정 및 안내문 작성",
      "회의 기록과 결과 문서 작성",
    ]);
  });

  it("retains welfare-center requirement bullets and recognizes numbered headings", () => {
    const result = buildUploadedPreview(
      "1. 자격요건\n• 복지관 근무 경력자\n• 참여자 일정 조정 및 안내문 작성\n2. 복지\n유연한 근무 시간을 제공합니다.",
      "복지관에서 근무하며 참여자 일정을 조정하고 안내문을 작성했습니다.",
    );
    expect(
      result.job.criteria.map((criterion) => criterion.source_quote),
    ).toEqual(["복지관 근무 경력자", "참여자 일정 조정 및 안내문 작성"]);
  });

  for (const [extension, mediaType] of [
    ["txt", "text/plain"],
    ["pdf", "application/pdf"],
    [
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  ] as const) {
    it(`extracts synthetic ${extension} in memory and cites only current/past units`, async () => {
      const app = await buildApp();
      const file = await readFile(
        `${fixtureDirectory}/synthetic-resume.${extension}`,
      );
      const response = await app.inject({
        method: "POST",
        url: "/readme/analyze",
        payload: {
          job_text: jobText,
          resume_filename: `synthetic-resume.${extension}`,
          resume_media_type: mediaType,
          resume_base64: file.toString("base64"),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      const body = response.json<{
        mode: string;
        case_id: string;
        resume: { units: Array<{ id: string; index: number }> };
        events: Array<{ unit_id: string; evidence_unit_ids?: string[] }>;
      }>();
      expect(body.mode).toBe("rules_preview");
      expect(body.case_id).toBe("user-upload");
      expect(body.resume.units.length).toBeGreaterThan(0);
      if (extension === "pdf") {
        const pdfText = response.json<{
          resume: { units: Array<{ text: string }> };
        }>();
        expect(
          pdfText.resume.units.map((unit) => unit.text).join(" "),
        ).not.toMatch(/--\s*\d+\s+of\s+\d+\s*--/u);
      }
      const indexById = new Map(
        body.resume.units.map((unit) => [unit.id, unit.index]),
      );
      for (const event of body.events) {
        for (const evidenceId of event.evidence_unit_ids ?? []) {
          expect(indexById.get(evidenceId) as number).toBeLessThanOrEqual(
            indexById.get(event.unit_id) as number,
          );
        }
      }
      await app.close();
    });
  }

  it("rejects a fake PDF and unknown personal-data field", async () => {
    const app = await buildApp();
    const payload = {
      job_text: jobText,
      resume_filename: "resume.pdf",
      resume_media_type: "application/pdf",
      resume_base64: Buffer.from("not a pdf").toString("base64"),
    };
    const invalid = await app.inject({
      method: "POST",
      url: "/readme/analyze",
      payload,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ error: string }>().error).toBe("invalid_pdf");
    const extra = await app.inject({
      method: "POST",
      url: "/readme/analyze",
      payload: { ...payload, contact_email: "do-not-accept@example.invalid" },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json<{ error: string }>().error).toBe("unexpected_field");
    await app.close();
  });

  it("distinguishes malformed base64 from an oversize file", async () => {
    const app = await buildApp();
    const invalid = await app.inject({
      method: "POST",
      url: "/readme/analyze",
      payload: {
        job_text: jobText,
        resume_filename: "resume.txt",
        resume_media_type: "text/plain",
        resume_base64: "###",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toBe("invalid_file");
    await app.close();
  });

  it("rate limits repeated document analysis", async () => {
    const app = await buildApp();
    const file = Buffer.from(
      "Synthetic resume: coordinated events and wrote checklists.",
    );
    const payload = {
      job_text: jobText,
      resume_filename: "resume.txt",
      resume_media_type: "text/plain",
      resume_base64: file.toString("base64"),
    };
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/readme/analyze",
        payload,
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/readme/analyze",
      payload,
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it("does not make another visitor share the first visitor's quota", async () => {
    const app = await buildApp();
    const payload = {
      job_text: jobText,
      resume_filename: "a.md",
      resume_media_type: "text/markdown",
      resume_base64: Buffer.from(
        "Synthetic schedule planning and checklist writing.",
      ).toString("base64"),
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/readme/analyze",
        headers: { "cf-connecting-ip": "192.0.2.10" },
        payload,
      });
      expect(response.statusCode).toBe(200);
    }
    const anotherVisitor = await app.inject({
      method: "POST",
      url: "/readme/analyze",
      headers: { "cf-connecting-ip": "192.0.2.11" },
      payload,
    });
    expect(anotherVisitor.statusCode).toBe(200);
    await app.close();
  });

  it("keeps long line-oriented resumes usable and labels truncation", async () => {
    const app = await buildApp();
    const text = Array.from(
      { length: 130 },
      (_, index) =>
        `Synthetic project ${index + 1}: wrote schedules and review notes.`,
    ).join("\n");
    const response = await app.inject({
      method: "POST",
      url: "/readme/analyze",
      payload: {
        job_text: jobText,
        resume_filename: "resume.txt",
        resume_media_type: "text/plain",
        resume_base64: Buffer.from(text).toString("base64"),
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      resume: { units: Array<{ id: string; index: number }> };
      limitations: string[];
    }>();
    expect(body.resume.units).toHaveLength(120);
    expect(body.resume.units[0]).toEqual(
      expect.objectContaining({ id: "R1", index: 0 }),
    );
    expect(body.limitations.join(" ")).toContain("앞부분 120개");
    await app.close();
  });

  it("rejects a DOCX with lying ZIP expansion sizes before Mammoth", async () => {
    const app = await buildApp();
    const file = Buffer.from(
      await readFile(`${fixtureDirectory}/synthetic-resume.docx`),
    );
    const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(end).toBeGreaterThan(0);
    const central = file.readUInt32LE(end + 16);
    expect(file.readUInt32LE(central)).toBe(0x02014b50);
    file.writeUInt32LE(1, central + 24);
    const response = await app.inject({
      method: "POST",
      url: "/readme/analyze",
      payload: {
        job_text: jobText,
        resume_filename: "resume.docx",
        resume_media_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        resume_base64: file.toString("base64"),
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("invalid_docx");
    await app.close();
  });

  it("rejects hidden extra ZIP headers and a shrunk central-directory size", async () => {
    const app = await buildApp();
    const original = Buffer.from(
      await readFile(`${fixtureDirectory}/synthetic-resume.docx`),
    );
    const endOffset = original.lastIndexOf(
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    );
    const centralOffset = original.readUInt32LE(endOffset + 16);
    const centralSize = original.readUInt32LE(endOffset + 12);
    const firstHeaderLength =
      46 +
      original.readUInt16LE(centralOffset + 28) +
      original.readUInt16LE(centralOffset + 30) +
      original.readUInt16LE(centralOffset + 32);
    const extraHeader = original.subarray(
      centralOffset,
      centralOffset + firstHeaderLength,
    );
    const hiddenHeader = Buffer.concat([
      original.subarray(0, endOffset),
      extraHeader,
      original.subarray(endOffset),
    ]);
    hiddenHeader.writeUInt32LE(
      centralSize + extraHeader.length,
      endOffset + extraHeader.length + 12,
    );
    const shortDirectory = Buffer.from(original);
    shortDirectory.writeUInt32LE(centralSize - 1, endOffset + 12);
    for (const file of [hiddenHeader, shortDirectory]) {
      const response = await app.inject({
        method: "POST",
        url: "/readme/analyze",
        payload: {
          job_text: jobText,
          resume_filename: "resume.docx",
          resume_media_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          resume_base64: file.toString("base64"),
        },
      });
      expect([413, 422]).toContain(response.statusCode);
      expect(response.json<{ error: string }>().error).toMatch(/docx/u);
    }
    await app.close();
  });

  it("rejects ZIP64 and multi-disk EOCD sentinels before Mammoth", async () => {
    const app = await buildApp();
    const original = Buffer.from(
      await readFile(`${fixtureDirectory}/synthetic-resume.docx`),
    );
    const endOffset = original.lastIndexOf(
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    );
    for (const fieldOffset of [4, 6, 8]) {
      const file = Buffer.from(original);
      file.writeUInt16LE(0xffff, endOffset + fieldOffset);
      const response = await app.inject({
        method: "POST",
        url: "/readme/analyze",
        payload: {
          job_text: jobText,
          resume_filename: "resume.docx",
          resume_media_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          resume_base64: file.toString("base64"),
        },
      });
      expect([413, 422]).toContain(response.statusCode);
      expect(response.json<{ error: string }>().error).toMatch(/docx/u);
    }
    await app.close();
  });

  it("bounds an actual high-expansion DOCX despite a false tiny size", async () => {
    const app = await buildApp();
    const filename = Buffer.from("word/document.xml");
    const compressed = deflateRawSync(Buffer.alloc(9 * 1024 * 1024, 65));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(1, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(1, 24);
    central.writeUInt16LE(filename.length, 28);
    const centralOffset = local.length + filename.length + compressed.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + filename.length, 12);
    end.writeUInt32LE(centralOffset, 16);
    const file = Buffer.concat([
      local,
      filename,
      compressed,
      central,
      filename,
      end,
    ]);
    expect(file.length).toBeLessThan(2_000_000);
    const response = await app.inject({
      method: "POST",
      url: "/readme/analyze",
      payload: {
        job_text: jobText,
        resume_filename: "resume.docx",
        resume_media_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        resume_base64: file.toString("base64"),
      },
    });
    expect([413, 422]).toContain(response.statusCode);
    expect(response.json<{ error: string }>().error).toMatch(/docx/u);
    await app.close();
  });
});
