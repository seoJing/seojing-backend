import { describe, expect, it } from "vitest";

import { convertMdxToArticleDocument } from "../src/services/mdx-to-document.js";
import {
  auditMdxRetirement,
  publicPayloadHash,
  sha256,
  stableJson,
  type ExpectedDocument,
  type RetirementEvidence,
} from "../src/services/mdx-retirement-readiness.js";

const source = "# Archived article\n\nA source paragraph.\n";
const document = convertMdxToArticleDocument(source).document;
const image = Buffer.from("synthetic representative visual bytes");
const date = "2026-10-22T00:00:00.000Z";
const features = [
  "text",
  "code",
  "tables",
  "images-media",
  "quizzes",
  "dates",
  "responsive-layout",
] as const;

function fixture() {
  const expected: ExpectedDocument[] = Array.from(
    { length: 201 },
    (_, index) => ({
      sourcePath: "post-" + index + ".mdx",
      slug: "post-" + index,
      sourceSha256: sha256(source),
      documentSha256: sha256(stableJson(document)),
    }),
  );
  const api: RetirementEvidence["api"] = expected.map(({ slug }) => ({
    slug,
    title: slug,
    description: "Retained",
    category: "Study",
    tags: [],
    cover: null,
    summaryVideo: null,
    displayDate: null,
    displayUpdatedAt: null,
    status: "PUBLISHED",
    publishedAt: date,
    updatedAt: date,
    body: {
      document,
      html: "<h1>Archived article</h1><p>A source paragraph.</p>",
      blocks: [],
    },
  }));
  const evidence: RetirementEvidence = {
    version: 1,
    capturedAt: date,
    webCommit: "a".repeat(40),
    backendCommit: "b".repeat(40),
    database: expected.map(({ slug }) => ({
      id: "article-" + slug,
      slug,
      title: slug,
      description: "Retained",
      category: "Study",
      tags: [],
      cover: null,
      summaryVideo: null,
      displayDate: null,
      displayUpdatedAt: null,
      publishedAt: date,
      updatedAt: date,
      status: "PUBLISHED",
      sourceFormat: "DOCUMENT",
      sourceText: "",
      legacyRevision: {
        id: "legacy-" + slug,
        articleId: "article-" + slug,
        sourceFormat: "MDX",
        sourceText: source,
      },
      currentRevisionId: "revision-" + slug,
      latestRevisionId: "revision-" + slug,
      currentRevision: {
        id: "revision-" + slug,
        articleId: "article-" + slug,
        sourceFormat: "DOCUMENT",
        sourceText: "",
        document,
      },
    })),
    api,
    d1: api.map((article) => ({
      slug: article.slug,
      title: article.title,
      description: article.description,
      category: article.category,
      tags_json: "[]",
      cover_json: null,
      display_date: null,
      display_updated_at: null,
      published_at: date,
      updated_at: date,
      payload_json: JSON.stringify({
        ...article,
        body: { document, html: "", blocks: [] },
      }),
    })),
    visualPolicy: {
      exhaustive201: "WAIVED_NOT_COMPLETED",
      ownerAcceptedAt: "2026-10-22",
      representativeChecks: [
        {
          slug: expected[0]!.slug,
          accepted: true,
          reviewer: "Synthetic test reviewer",
          reviewedAt: date,
          features: [...features],
          sourceSha256: expected[0]!.sourceSha256,
          documentSha256: expected[0]!.documentSha256,
          publicPayloadSha256: publicPayloadHash(api[0]!),
          desktop: {
            path: "representative-desktop.png",
            sha256: sha256(image),
          },
          mobile: { path: "representative-mobile.png", sha256: sha256(image) },
        },
      ],
    },
  };
  return { expected, evidence };
}

describe("post-retirement archive evidence gate", () => {
  it("accepts exact 201-way DB/API/D1 parity plus hash-bound representative checks", () => {
    const { expected, evidence } = fixture();
    expect(auditMdxRetirement(expected, evidence, () => image)).toEqual({
      ready: true,
      expected: 201,
      accepted: 201,
      blockers: [],
    });
  });

  it("fails closed without evidence or the complete archived corpus", () => {
    const { expected, evidence } = fixture();
    expect(auditMdxRetirement(expected, undefined, () => image).ready).toBe(
      false,
    );
    expect(
      auditMdxRetirement(expected.slice(1), evidence, () => image).ready,
    ).toBe(false);
  });

  it("records the owner waiver as waived-not-completed, never as 201 acceptances", () => {
    const { expected, evidence } = fixture();
    Object.assign(evidence.visualPolicy, { exhaustive201: "COMPLETED" });
    const report = auditMdxRetirement(expected, evidence, () => image);
    expect(report.ready).toBe(false);
    expect(report.blockers.join("\n")).toContain(
      "evidence.visualPolicy.exhaustive201",
    );
  });

  it("requires representative feature coverage, both viewport artifacts, and current hashes", () => {
    const { expected, evidence } = fixture();
    evidence.visualPolicy.representativeChecks[0]!.features = ["text"];
    evidence.visualPolicy.representativeChecks[0]!.documentSha256 = "0".repeat(
      64,
    );
    const report = auditMdxRetirement(expected, evidence, () =>
      Buffer.from("changed"),
    );
    expect(report.ready).toBe(false);
    expect(report.blockers.join("\n")).toMatch(
      /missing feature coverage|stale|evidence hash mismatch/,
    );
  });

  it("rejects altered historical MDX revision bytes", () => {
    const { expected, evidence } = fixture();
    evidence.database[0]!.legacyRevision.sourceText += "changed";
    expect(
      auditMdxRetirement(expected, evidence, () => image).blockers.join("\n"),
    ).toContain("retained DB MDX source hash mismatch");
  });
});
