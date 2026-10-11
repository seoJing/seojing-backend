import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { ArticleRepository } from "../src/repositories/articles.js";
import { ArticleService } from "../src/services/articles.js";
import { renderMdxForEditor } from "../src/services/mdx-editor-renderer.js";
import { convertMdxToArticleDocument } from "../src/services/mdx-to-document.js";

const runDbTests = process.env.RUN_DB_TESTS === "true";
const describeDb = runDbTests ? describe : describe.skip;
const prisma = new PrismaClient();
const service = new ArticleService(new ArticleRepository(prisma));
const integrationSlug = "integration-article-schema-mvp";
const publishFlowSlug = "integration-admin-write-publish-flow";
const publishedEditSlug = "integration-published-edit-flow";
const documentSlug = "integration-native-document-flow";
const legacyConversionSlug = "integration-legacy-conversion-flow";

describeDb("Article database integration", () => {
  beforeEach(async () => {
    await prisma.article.deleteMany({
      where: {
        slug: {
          in: [
            integrationSlug,
            publishFlowSlug,
            publishedEditSlug,
            documentSlug,
            legacyConversionSlug,
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.article.deleteMany({
      where: {
        slug: {
          in: [
            integrationSlug,
            publishFlowSlug,
            publishedEditSlug,
            documentSlug,
            legacyConversionSlug,
          ],
        },
      },
    });
    await prisma.$disconnect();
  });

  it("persists an article draft with current revision, derived blocks, and an asset", async () => {
    const created = await service.createInitialDraft({
      slug: integrationSlug,
      title: "Integration Article Schema MVP",
      description: "Real Postgres write/read verification",
      sourceText:
        "# Integration Article Schema MVP\n\nThis verifies the article schema against Postgres.",
      renderedHtml:
        "<h1>Integration Article Schema MVP</h1><p>This verifies the article schema against Postgres.</p>",
      assets: [
        {
          kind: "COVER",
          url: "https://seojing.com/images/seed/integration-article-schema-mvp.svg",
          altText: "Integration cover",
          mimeType: "image/svg+xml",
        },
      ],
    });

    expect(created.currentRevisionId).toBe(created.currentRevision?.id);
    expect(created.blocks).toHaveLength(2);
    expect(created.assets).toHaveLength(1);

    const found = await service.getArticleBySlug(integrationSlug);

    expect(found?.slug).toBe(integrationSlug);
    expect(found?.currentRevision?.revisionNumber).toBe(1);
    expect(found?.blocks.map((block) => block.type)).toEqual([
      "HEADING",
      "PARAGRAPH",
    ]);
    expect(found?.assets[0]?.kind).toBe("COVER");
  });

  it("keeps the idempotent seed article readable", async () => {
    const seedArticle = await service.getArticleBySlug("hello-seojing-backend");

    expect(seedArticle?.currentRevision?.revisionNumber).toBe(1);
    expect(seedArticle?.blocks.length).toBeGreaterThanOrEqual(2);
    expect(seedArticle?.assets.some((asset) => asset.kind === "COVER")).toBe(
      true,
    );
  });

  it("keeps drafts hidden from public reads until the latest revision is published", async () => {
    const draft = await service.createInitialDraft({
      slug: publishFlowSlug,
      title: "Admin Write Publish Flow",
      description: "Draft should not be public before publish",
      sourceText: "# Admin Write Publish Flow\n\nDraft body",
      renderedHtml: "<h1>Admin Write Publish Flow</h1><p>Draft body</p>",
      changeSummary: "Initial admin draft",
      authorName: "OkayJing",
    });

    expect(draft.status).toBe("DRAFT");
    await expect(
      service.getPublicArticleBySlug(publishFlowSlug),
    ).resolves.toBeNull();

    const revised = await service.createEditorRevision(publishFlowSlug, {
      sourceText: "# Admin Write Publish Flow v2\n\nPublished body",
      renderedHtml: "<h1>Admin Write Publish Flow v2</h1><p>Published body</p>",
      changeSummary: "Save publish candidate",
      authorName: "OkayJing",
    });

    expect(revised?.currentRevision?.revisionNumber).toBe(2);
    expect(revised?.currentRevision?.sourceText).toContain("v2");
    await expect(
      service.getPublicArticleBySlug(publishFlowSlug),
    ).resolves.toBeNull();

    const published = await service.publishCurrentRevision(publishFlowSlug);
    const publicReadback =
      await service.getPublicArticleBySlug(publishFlowSlug);

    expect(published?.status).toBe("PUBLISHED");
    expect(publicReadback?.status).toBe("PUBLISHED");
    expect(publicReadback?.currentRevision?.revisionNumber).toBe(2);
    expect(publicReadback?.renderedHtml).toContain("Published body");
  });

  it("saves published article edits as private revisions until publish", async () => {
    const originalSource = "# Published Edit Flow\n\nOld public body";
    const originalRender = renderMdxForEditor(originalSource);
    await service.createInitialDraft({
      slug: publishedEditSlug,
      title: "Published Edit Flow",
      description: "Initial public body",
      sourceText: originalSource,
      renderedHtml: originalRender.renderedHtml,
      blocks: originalRender.blocks,
      changeSummary: "Initial draft before public edit",
      authorName: "OkayJing",
    });
    await service.publishCurrentRevision(publishedEditSlug);

    const privateEdit = await service.createEditorRevision(publishedEditSlug, {
      title: "Updated Published Edit Flow",
      description: "Updated description after publish",
      sourceText: "# Published Edit Flow\n\nNew public body after publish",
      renderedHtml:
        "<h1>Published Edit Flow</h1><p>New public body after publish</p>",
      changeSummary: "Stage edit for already-published article",
      authorName: "OkayJing",
    });

    const beforePublish =
      await service.getPublicArticleBySlug(publishedEditSlug);
    expect(privateEdit?.status).toBe("PUBLISHED");
    expect(privateEdit?.currentRevision?.revisionNumber).toBe(1);
    expect(privateEdit?.revisions[0]?.revisionNumber).toBe(2);
    expect(beforePublish?.currentRevision?.revisionNumber).toBe(1);
    expect(beforePublish?.renderedHtml).toContain("Old public body");
    expect(beforePublish?.title).toBe("Published Edit Flow");
    expect(privateEdit?.revisions[0]?.title).toBe(
      "Updated Published Edit Flow",
    );

    const published = await service.publishCurrentRevision(publishedEditSlug);
    const publicReadback =
      await service.getPublicArticleBySlug(publishedEditSlug);

    expect(published?.currentRevision?.revisionNumber).toBe(2);
    expect(publicReadback?.renderedHtml).toContain(
      "New public body after publish",
    );
    expect(publicReadback?.title).toBe("Updated Published Edit Flow");
    expect(publicReadback?.description).toBe(
      "Updated description after publish",
    );

    const restored = await service.restoreRevision(publishedEditSlug, 1);
    const beforeRestorePublish =
      await service.getPublicArticleBySlug(publishedEditSlug);
    expect(restored?.revisions[0]?.revisionNumber).toBe(3);
    expect(restored?.revisions[0]?.sourceText).toContain("Old public body");
    expect(beforeRestorePublish?.renderedHtml).toContain(
      "New public body after publish",
    );
    await service.publishCurrentRevision(publishedEditSlug);
    const afterRestorePublish =
      await service.getPublicArticleBySlug(publishedEditSlug);
    expect(afterRestorePublish?.renderedHtml).toContain("Old public body");
  });

  it("keeps a JSON document and metadata revision-pinned across public edits", async () => {
    const original = await service.createDocumentDraft({
      slug: documentSlug,
      title: "Native document",
      description: "First version",
      category: "Study",
      tags: ["CMS", "JSON"],
      cover: { src: "/images/first.png", alt: "First cover" },
      displayDate: "2026-10-07",
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "First body", marks: [{ type: "bold" }] },
            ],
          },
        ],
      },
    });
    expect(original.revisions[0]?.document).toMatchObject({ type: "doc" });
    expect(original.sourceText).toBe("");
    await service.publishCurrentRevision(documentSlug);

    const privateRevision = await service.saveDocumentRevision(documentSlug, {
      title: "Updated document",
      description: "Second version",
      category: "Study",
      tags: ["Updated"],
      cover: { src: "/images/second.png", alt: "Second cover" },
      displayDate: "2026-10-08",
      expectedRevisionId: original.revisions[0]?.id,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Second body" }],
          },
        ],
      },
    });
    expect(privateRevision?.revisions[0]?.document).toMatchObject({
      type: "doc",
    });
    const beforePublish = await service.getPublicArticleBySlug(documentSlug);
    expect(beforePublish?.renderedHtml).toContain("First body");
    expect(beforePublish?.title).toBe("Native document");
    expect(beforePublish?.tags).toEqual(["CMS", "JSON"]);

    await expect(
      service.saveDocumentRevision(documentSlug, {
        title: "Stale write",
        expectedRevisionId: original.revisions[0]?.id,
        document: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Lost" }] },
          ],
        },
      }),
    ).rejects.toThrow("Article revision changed before save");

    await service.publishCurrentRevision(documentSlug);
    const afterPublish = await service.getPublicArticleBySlug(documentSlug);
    expect(afterPublish?.renderedHtml).toContain("Second body");
    expect(afterPublish?.tags).toEqual(["Updated"]);
    expect(afterPublish?.cover).toMatchObject({ src: "/images/second.png" });
    const cleared = await service.saveDocumentRevision(documentSlug, {
      title: "Without media",
      expectedRevisionId: privateRevision?.revisions[0]?.id,
      cover: null,
      summaryVideo: null,
      displayDate: null,
      displayUpdatedAt: null,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "No media" }] },
        ],
      },
    });
    expect(cleared?.revisions[0]?.cover).toBeNull();
    expect(cleared?.revisions[0]?.displayDate).toBeNull();
    await service.publishCurrentRevision(documentSlug);
    const clearedPublic = await service.getPublicArticleBySlug(documentSlug);
    expect(clearedPublic?.cover).toBeNull();
    expect(clearedPublic?.displayDate).toBeNull();
    expect(afterPublish?.displayDate?.toISOString()).toContain("2026-10-08");
  });

  it("stages legacy MDX conversion without changing the pinned public body", async () => {
    const source = "# Legacy\n\nOriginal body";
    const preview = renderMdxForEditor(source);
    const created = await service.createInitialDraft({
      slug: legacyConversionSlug,
      title: "Legacy",
      sourceText: source,
      renderedHtml: preview.renderedHtml,
      blocks: preview.blocks,
    });
    await service.publishCurrentRevision(legacyConversionSlug);
    const { document } = convertMdxToArticleDocument(source);
    const converted = await service.convertMdxArticleToDocument(
      legacyConversionSlug,
      {
        title: "Legacy converted",
        document,
        expectedRevisionId: created.revisions[0]?.id,
      },
      createHash("sha256").update(`${source}\n`).digest("hex"),
    );
    expect(converted?.revisions[0]?.sourceFormat).toBe("DOCUMENT");
    expect(converted?.revisions[0]?.document).toMatchObject({ type: "doc" });
    expect(converted?.revisions[1]?.sourceText).toBe(source);
    const publicBefore =
      await service.getPublicArticleBySlug(legacyConversionSlug);
    expect(publicBefore?.currentRevision?.sourceFormat).toBe("MDX");
    expect(publicBefore?.title).toBe("Legacy");
    await service.publishCurrentRevision(legacyConversionSlug);
    const publicAfter =
      await service.getPublicArticleBySlug(legacyConversionSlug);
    expect(publicAfter?.currentRevision?.sourceFormat).toBe("DOCUMENT");
    expect(publicAfter?.sourceText).toBe("");
  });
});
