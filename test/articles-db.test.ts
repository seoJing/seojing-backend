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

describeDb("Article database integration", () => {
  beforeEach(async () => {
    await prisma.article.deleteMany({
      where: {
        slug: { in: [integrationSlug, publishFlowSlug, publishedEditSlug] },
      },
    });
  });

  afterAll(async () => {
    await prisma.article.deleteMany({
      where: {
        slug: { in: [integrationSlug, publishFlowSlug, publishedEditSlug] },
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
    await service.createInitialDraft({
      slug: publishedEditSlug,
      title: "Published Edit Flow",
      description: "Initial public body",
      sourceText: "# Published Edit Flow\n\nOld public body",
      renderedHtml: "<h1>Published Edit Flow</h1><p>Old public body</p>",
      changeSummary: "Initial draft before public edit",
      authorName: "OkayJing",
    });
    await service.publishCurrentRevision(publishedEditSlug);

    const privateEdit = await service.createEditorRevision(publishedEditSlug, {
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

    const published = await service.publishCurrentRevision(publishedEditSlug);
    const publicReadback =
      await service.getPublicArticleBySlug(publishedEditSlug);

    expect(published?.currentRevision?.revisionNumber).toBe(2);
    expect(publicReadback?.renderedHtml).toContain(
      "New public body after publish",
    );
  });
});
