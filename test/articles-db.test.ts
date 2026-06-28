import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { ArticleRepository } from "../src/repositories/articles.js";
import { ArticleService } from "../src/services/articles.js";

const runDbTests = process.env.RUN_DB_TESTS === "true";
const describeDb = runDbTests ? describe : describe.skip;
const prisma = new PrismaClient();
const service = new ArticleService(new ArticleRepository(prisma));
const integrationSlug = "integration-article-schema-mvp";

describeDb("Article database integration", () => {
  beforeEach(async () => {
    await prisma.article.deleteMany({ where: { slug: integrationSlug } });
  });

  afterAll(async () => {
    await prisma.article.deleteMany({ where: { slug: integrationSlug } });
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
});
