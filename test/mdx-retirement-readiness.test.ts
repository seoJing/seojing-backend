import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { convertMdxToArticleDocument } from "../src/services/mdx-to-document.js";
import {
  auditMdxRetirement,
  auditRetainedCorpus,
  publicPayloadHash,
  sha256,
  stableJson,
  type ExpectedDocument,
  type RetirementEvidence,
} from "../src/services/mdx-retirement-readiness.js";

const source = "# Retained article\n\nA source paragraph.\n";
const document = convertMdxToArticleDocument(source).document;
const image = Buffer.from("test-only visual evidence bytes");
const date = "2026-10-21T00:00:00.000Z";

function fixture() {
  const expected: ExpectedDocument[] = Array.from({ length: 201 }, (_, i) => ({
    sourcePath: `post-${i}.mdx`,
    slug: `post-${i}`,
    sourceSha256: sha256(source),
    documentSha256: sha256(stableJson(document)),
  }));
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
    etag: `etag-${slug}`,
    toc: [],
    assets: [],
    body: {
      document,
      html: "<h1>Retained article</h1><p>A source paragraph.</p>",
      blocks: [],
    },
  }));
  const evidence: RetirementEvidence = {
    version: 1,
    capturedAt: date,
    webCommit: "a".repeat(40),
    backendCommit: "b".repeat(40),
    database: expected.map(({ slug }) => ({
      id: `article-${slug}`,
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
        id: `legacy-${slug}`,
        articleId: `article-${slug}`,
        sourceFormat: "MDX",
        sourceText: source,
      },
      currentRevisionId: `revision-${slug}`,
      latestRevisionId: `revision-${slug}`,
      currentRevision: {
        id: `revision-${slug}`,
        articleId: `article-${slug}`,
        sourceFormat: "DOCUMENT",
        sourceText: "",
        document,
      },
    })),
    api,
    d1: api.map((article) => ({
      slug: article.slug,
      title: article.title,
      description: "Retained",
      category: "Study",
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
    visualAcceptances: expected.map((entry, i) => ({
      slug: entry.slug,
      accepted: true,
      reviewer: "Test reviewer",
      reviewedAt: date,
      sourceSha256: entry.sourceSha256,
      documentSha256: entry.documentSha256,
      publicPayloadSha256: publicPayloadHash(api[i]!),
      desktop: { path: `${entry.slug}-desktop.png`, sha256: sha256(image) },
      mobile: { path: `${entry.slug}-mobile.png`, sha256: sha256(image) },
    })),
  };
  return { expected, evidence };
}

describe("offline MDX retirement gate", () => {
  it("accepts only a complete 201-post, hash-bound evidence set", () => {
    const { expected, evidence } = fixture();
    expect(auditMdxRetirement(expected, evidence, () => image)).toEqual({
      ready: true,
      expected: 201,
      accepted: 201,
      blockers: [],
    });
    // Key order must not change a canonical document hash.
    expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 }));
  });

  it("fails closed without evidence, artifacts, or the complete fixed corpus", () => {
    const { expected, evidence } = fixture();
    expect(auditMdxRetirement(expected, undefined, () => image).ready).toBe(
      false,
    );
    expect(
      auditMdxRetirement(expected.slice(1), evidence, () => image).ready,
    ).toBe(false);
    expect(
      auditMdxRetirement(expected, evidence, () => {
        throw new Error("missing");
      }).ready,
    ).toBe(false);
    expect(
      auditMdxRetirement(expected, evidence, () => Buffer.from("changed image"))
        .ready,
    ).toBe(false);
  });

  it.each<
    [string, (row: RetirementEvidence["database"][number]) => void, string]
  >([
    [
      "free-standing legacy source without an actual revision",
      (row) => {
        Object.assign(row, {
          legacySourceText: source,
          legacyRevision: undefined,
        });
      },
      "evidence.database.0.legacyRevision",
    ],
    [
      "missing legacy revision ID",
      (row) => {
        Object.assign(row.legacyRevision, { id: undefined });
      },
      "evidence.database.0.legacyRevision.id",
    ],
    [
      "blank legacy revision ID",
      (row) => {
        row.legacyRevision.id = " ";
      },
      "evidence.database.0.legacyRevision.id",
    ],
    [
      "legacy revision reusing the current revision ID",
      (row) => {
        row.legacyRevision.id = row.currentRevision.id;
      },
      "legacy/current revision identities must be distinct",
    ],
    [
      "legacy revision reusing another article's revision ID",
      (row) => {
        row.legacyRevision.id = "legacy-post-1";
      },
      "legacy/current revision identities must be distinct",
    ],
    [
      "non-MDX legacy revision",
      (row) => {
        Object.assign(row.legacyRevision, { sourceFormat: "DOCUMENT" });
      },
      "evidence.database.0.legacyRevision.sourceFormat",
    ],
    [
      "missing legacy revision format",
      (row) => {
        Object.assign(row.legacyRevision, { sourceFormat: undefined });
      },
      "evidence.database.0.legacyRevision.sourceFormat",
    ],
    [
      "missing legacy sourceText",
      (row) => {
        Object.assign(row.legacyRevision, { sourceText: undefined });
      },
      "evidence.database.0.legacyRevision.sourceText",
    ],
    [
      "empty legacy sourceText",
      (row) => {
        row.legacyRevision.sourceText = "";
      },
      "evidence.database.0.legacyRevision.sourceText",
    ],
    [
      "legacy source newline drift",
      (row) => {
        row.legacyRevision.sourceText = source.trimEnd();
      },
      "retained DB MDX source hash mismatch",
    ],
    [
      "altered legacy source with a valid claimed hash and free-standing source",
      (row) => {
        row.legacyRevision.sourceText += "changed";
        Object.assign(row.legacyRevision, { sourceSha256: sha256(source) });
        Object.assign(row, { legacySourceText: source });
      },
      "retained DB MDX source hash mismatch",
    ],
    [
      "legacy revision owned by another Article",
      (row) => {
        row.legacyRevision.articleId = "article-post-1";
      },
      "legacy/current revision Article identity mismatch",
    ],
    [
      "current revision owned by another Article",
      (row) => {
        row.currentRevision.articleId = "article-post-1";
      },
      "legacy/current revision Article identity mismatch",
    ],
    [
      "duplicate Article identity with matching revision owners",
      (row) => {
        row.id = "article-post-1";
        row.legacyRevision.articleId = row.id;
        row.currentRevision.articleId = row.id;
      },
      "duplicate Article identity",
    ],
    [
      "Article sourceText differing from its current revision",
      (row) => {
        row.sourceText = source;
      },
      "Article/currentRevision source mismatch",
    ],
    [
      "current revision sourceText differing from its Article",
      (row) => {
        row.currentRevision.sourceText = source;
      },
      "Article/currentRevision source mismatch",
    ],
    [
      "missing Article sourceText",
      (row) => {
        Object.assign(row, { sourceText: undefined });
      },
      "evidence.database.0.sourceText",
    ],
    [
      "missing current revision sourceText",
      (row) => {
        Object.assign(row.currentRevision, { sourceText: undefined });
      },
      "evidence.database.0.currentRevision.sourceText",
    ],
    [
      "null current revision sourceText",
      (row) => {
        Object.assign(row.currentRevision, { sourceText: null });
      },
      "evidence.database.0.currentRevision.sourceText",
    ],
    [
      "matching MDX text on the Article and current DOCUMENT revision",
      (row) => {
        row.sourceText = source;
        row.currentRevision.sourceText = source;
      },
      "current DOCUMENT sourceText must be empty",
    ],
    [
      "matching whitespace on the Article and current DOCUMENT revision",
      (row) => {
        row.sourceText = " \n";
        row.currentRevision.sourceText = " \n";
      },
      "current DOCUMENT sourceText must be empty",
    ],
    [
      "BLOCKS Article labeled with a DOCUMENT current revision",
      (row) => {
        Object.assign(row, { sourceFormat: "BLOCKS" });
      },
      "evidence.database.0.sourceFormat",
    ],
    [
      "DOCUMENT Article with a BLOCKS current revision",
      (row) => {
        Object.assign(row.currentRevision, { sourceFormat: "BLOCKS" });
      },
      "evidence.database.0.currentRevision.sourceFormat",
    ],
  ])("fails closed for %s", (_name, mutate, blocker) => {
    const { expected, evidence } = fixture();
    mutate(evidence.database[0]!);
    const report = auditMdxRetirement(expected, evidence, () => image);
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([expect.stringContaining(blocker)]),
    );
  });

  it.each<[string, (value: RetirementEvidence) => void]>([
    [
      "DB/API metadata drift",
      (e) => {
        e.database[0]!.title = "new DB title";
      },
    ],
    [
      "one visual acceptance missing",
      (e) => {
        e.visualAcceptances.pop();
      },
    ],
    [
      "duplicate acceptance",
      (e) => {
        e.visualAcceptances[1] = e.visualAcceptances[0]!;
      },
    ],
    [
      "rejected visual review",
      (e) => {
        Object.assign(e.visualAcceptances[0]!, { accepted: false });
      },
    ],
    [
      "no reviewer",
      (e) => {
        e.visualAcceptances[0]!.reviewer = " ";
      },
    ],
    [
      "stale visual document",
      (e) => {
        e.visualAcceptances[0]!.documentSha256 = "0".repeat(64);
      },
    ],
    [
      "stale visual source",
      (e) => {
        e.visualAcceptances[0]!.sourceSha256 = "0".repeat(64);
      },
    ],
    [
      "stale visual payload",
      (e) => {
        e.visualAcceptances[0]!.publicPayloadSha256 = "0".repeat(64);
      },
    ],
    [
      "missing mobile evidence",
      (e) => {
        Object.assign(e.visualAcceptances[0]!, { mobile: null });
      },
    ],
    [
      "missing API article",
      (e) => {
        e.api.pop();
      },
    ],
    [
      "case-changed slug",
      (e) => {
        e.api[0]!.slug = "POST-0";
      },
    ],
    [
      "extra D1 article",
      (e) => {
        e.d1.push({ ...e.d1[0]!, slug: "extra" });
      },
    ],
    [
      "duplicate DB article",
      (e) => {
        e.database[1] = e.database[0]!;
      },
    ],
    [
      "MDX still published",
      (e) => {
        Object.assign(e.database[0]!, { sourceFormat: "MDX" });
      },
    ],
    [
      "MDX current revision",
      (e) => {
        Object.assign(e.database[0]!.currentRevision, { sourceFormat: "MDX" });
      },
    ],
    [
      "draft still private",
      (e) => {
        Object.assign(e.database[0]!, { status: "DRAFT" });
      },
    ],
    [
      "pending private revision",
      (e) => {
        e.database[0]!.latestRevisionId = "private";
      },
    ],
    [
      "wrong current revision",
      (e) => {
        e.database[0]!.currentRevision.id = "old";
      },
    ],
    [
      "retained source changed",
      (e) => {
        e.database[0]!.legacyRevision.sourceText += "changed";
      },
    ],
    [
      "DB document changed",
      (e) => {
        e.database[0]!.currentRevision.document = {
          type: "doc",
          content: [{ type: "paragraph" }],
        };
      },
    ],
    [
      "API document changed",
      (e) => {
        e.api[0]!.body.document = {
          type: "doc",
          content: [{ type: "paragraph" }],
        };
      },
    ],
    [
      "API HTML missing",
      (e) => {
        e.api[0]!.body.html = "";
      },
    ],
    [
      "D1 stale payload",
      (e) => {
        const payload = JSON.parse(e.d1[0]!.payload_json) as Record<
          string,
          unknown
        >;
        payload.title = "stale";
        e.d1[0]!.payload_json = JSON.stringify(payload);
      },
    ],
    [
      "D1 stale index",
      (e) => {
        e.d1[0]!.title = "stale";
      },
    ],
    [
      "D1 stale tags",
      (e) => {
        e.d1[0]!.tags_json = '["stale"]';
      },
    ],
    [
      "D1 invalid payload",
      (e) => {
        e.d1[0]!.payload_json = "not JSON";
      },
    ],
  ])("blocks %s", (_name, mutate) => {
    const { expected, evidence } = fixture();
    mutate(evidence);
    const report = auditMdxRetirement(expected, evidence, () => image);
    expect(report.ready).toBe(false);
    expect(report.blockers.length).toBeGreaterThan(0);
  });

  it("audits files and conversion rather than trusting manifest counts/hashes", () => {
    const root = mkdtempSync(resolve(tmpdir(), "mdx-retention-"));
    const { expected } = fixture();
    try {
      for (const entry of expected)
        writeFileSync(resolve(root, entry.sourcePath), source);
      expect(auditRetainedCorpus(root, expected)).toHaveLength(201);
      const path = resolve(root, expected[0]!.sourcePath);
      writeFileSync(path, `${source}edited`);
      expect(() => auditRetainedCorpus(root, expected)).toThrow(
        "source hash mismatch",
      );
      writeFileSync(path, source);
      rmSync(path);
      expect(() => auditRetainedCorpus(root, expected)).toThrow(
        "201 retained posts",
      );
      writeFileSync(path, source);
      writeFileSync(resolve(root, "extra.mdx"), source);
      expect(() => auditRetainedCorpus(root, expected)).toThrow(
        "201 retained posts",
      );
      rmSync(resolve(root, "extra.mdx"));
      expect(() =>
        auditRetainedCorpus(
          root,
          expected.map((entry, i) =>
            i === 0 ? { ...entry, slug: "wrong" } : entry,
          ),
        ),
      ).toThrow("canonical slug mismatch");
      expect(readFileSync(path, "utf8")).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
