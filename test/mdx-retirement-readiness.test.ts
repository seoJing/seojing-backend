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
const convertedDocument = convertMdxToArticleDocument(source).document;
const document = {
  type: "doc" as const,
  content: [
    ...convertedDocument.content,
    {
      type: "paragraph",
      content: [{ type: "text", text: "Legitimate native edit." }],
    },
  ],
};
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
      convertedDocumentSha256: sha256(stableJson(convertedDocument)),
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
  const legacyRevisionsFor = (slug: string) =>
    Array.from(
      { length: slug === "post-0" ? 3 : slug === "post-1" ? 2 : 1 },
      (_, index) => {
        const revisionSource =
          slug === "post-0" && index < 2
            ? source
            : index === 0
              ? source
              : source + "edit-" + index;
        return {
          id: "legacy-" + slug + "-" + index,
          articleId: "article-" + slug,
          revisionNumber: index + 1,
          sourceFormat: "MDX" as const,
          sourceText: revisionSource,
          sourceSha256: sha256(revisionSource),
        };
      },
    );
  const evidence: RetirementEvidence = {
    version: 2,
    capturedAt: date,
    historicalMdxRevisionTotal: 205,
    residualMdxRevisions: [
      {
        id: "legacy-draft-0",
        articleId: "article-draft",
        slug: "hello-seojing-backend",
        articleStatus: "DRAFT",
        revisionNumber: 1,
        sourceFormat: "MDX",
        sourceText: "# Inert draft history\n",
        sourceSha256: sha256("# Inert draft history\n"),
      },
    ],
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
      historicalMdxRevisionCount:
        slug === "post-0" ? 3 : slug === "post-1" ? 2 : 1,
      archivedSourceRevisionId: "legacy-" + slug + "-0",
      legacyRevisions: legacyRevisionsFor(slug),
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
          documentSha256: sha256(stableJson(document)),
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
  it("accepts a legitimate post-migration native edit with exact DB/API/D1 parity", () => {
    const { expected, evidence } = fixture();
    expect(expected[0]!.convertedDocumentSha256).not.toBe(
      sha256(stableJson(evidence.database[0]!.currentRevision.document)),
    );
    expect(auditMdxRetirement(expected, evidence, () => image)).toEqual({
      ready: true,
      expected: 201,
      accepted: 201,
      blockers: [],
    });
  });

  it("accepts 204 published plus one residual revision and duplicate archive bytes with explicit identity", () => {
    const { expected, evidence } = fixture();
    expect(
      evidence.database.reduce(
        (count, row) => count + row.legacyRevisions.length,
        0,
      ),
    ).toBe(204);
    expect(evidence.residualMdxRevisions).toHaveLength(1);
    expect(evidence.database[0]!.legacyRevisions[0]!.sourceSha256).toBe(
      evidence.database[0]!.legacyRevisions[1]!.sourceSha256,
    );
    expect(evidence.database[0]!.archivedSourceRevisionId).toBe(
      evidence.database[0]!.legacyRevisions[0]!.id,
    );
    expect(auditMdxRetirement(expected, evidence, () => image).ready).toBe(
      true,
    );
  });

  it("fails closed when the non-corpus residual revision is omitted", () => {
    const { expected, evidence } = fixture();
    evidence.residualMdxRevisions = [];
    const report = auditMdxRetirement(expected, evidence, () => image);
    expect(report.ready).toBe(false);
    expect(report.blockers.join("\n")).toContain(
      "evidence.residualMdxRevisions: Too small",
    );
  });

  it("rejects a fabricated global revision count", () => {
    const { expected, evidence } = fixture();
    const fabricated: unknown = {
      ...evidence,
      historicalMdxRevisionTotal: 204,
    };
    const report = auditMdxRetirement(expected, fabricated, () => image);
    expect(report.ready).toBe(false);
    expect(report.blockers.join("\n")).toContain(
      "evidence.historicalMdxRevisionTotal",
    );
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
    evidence.database[0]!.legacyRevisions[0]!.sourceText += "changed";
    expect(
      auditMdxRetirement(expected, evidence, () => image).blockers.join("\n"),
    ).toContain("historical MDX revision source hash mismatch");
  });

  it("rejects incomplete declared historical revision evidence", () => {
    const { expected, evidence } = fixture();
    evidence.database[0]!.historicalMdxRevisionCount = 4;
    expect(
      auditMdxRetirement(expected, evidence, () => image).blockers.join("\n"),
    ).toContain("declared historical MDX revision counts");
  });

  it("rejects DB/API and API/D1 document divergence", () => {
    const first = fixture();
    first.evidence.api[0]!.body.document = convertedDocument;
    expect(
      auditMdxRetirement(
        first.expected,
        first.evidence,
        () => image,
      ).blockers.join("\n"),
    ).toContain("database/API DOCUMENT parity mismatch");

    const second = fixture();
    const d1Payload = JSON.parse(second.evidence.d1[0]!.payload_json) as {
      body: { document: unknown };
    };
    d1Payload.body.document = convertedDocument;
    second.evidence.d1[0]!.payload_json = JSON.stringify(d1Payload);
    expect(
      auditMdxRetirement(
        second.expected,
        second.evidence,
        () => image,
      ).blockers.join("\n"),
    ).toContain("D1/API public payload parity mismatch");
  });
});
