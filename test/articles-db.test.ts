import { PrismaClient } from "@prisma/client";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { ArticleRepository } from "../src/repositories/articles.js";
import { ArticleService } from "../src/services/articles.js";

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
});
