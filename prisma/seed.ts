import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const seedSlug = "hello-seojing-backend";
const seedDocument = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "SEOJing Backend Seed Article" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "This article verifies the Article/Revision/Block schema MVP.",
        },
      ],
    },
  ],
} as const;

async function main(): Promise<void> {
  const existing = await prisma.article.findUnique({
    where: { slug: seedSlug },
    select: { id: true },
  });

  if (existing) {
    await prisma.article.delete({ where: { id: existing.id } });
  }

  const article = await prisma.article.create({
    data: {
      slug: seedSlug,
      title: "SEOJing Backend Seed Article",
      description: "Schema MVP smoke article for repository/service tests.",
      status: "DRAFT",
      sourceFormat: "DOCUMENT",
      sourceText: "",
      renderedHtml:
        "<h1>SEOJing Backend Seed Article</h1><p>This article verifies the Article/Revision/Block schema MVP.</p>",
    },
  });

  const revision = await prisma.articleRevision.create({
    data: {
      articleId: article.id,
      revisionNumber: 1,
      sourceFormat: "DOCUMENT",
      sourceText: "",
      document: seedDocument,
      renderedHtml: article.renderedHtml,
      changeSummary: "Initial seed revision for Ticket #162.",
      authorName: "OkayJing",
    },
  });

  const heading = await prisma.articleBlock.create({
    data: {
      articleId: article.id,
      revisionId: revision.id,
      type: "HEADING",
      sortOrder: 0,
      content: { level: 1, text: "SEOJing Backend Seed Article" },
      plainText: "SEOJing Backend Seed Article",
    },
  });

  await prisma.articleBlock.create({
    data: {
      articleId: article.id,
      revisionId: revision.id,
      type: "PARAGRAPH",
      sortOrder: 1,
      content: {
        text: "This article verifies the Article/Revision/Block schema MVP.",
      },
      plainText: "This article verifies the Article/Revision/Block schema MVP.",
    },
  });

  await prisma.articleAsset.create({
    data: {
      articleId: article.id,
      revisionId: revision.id,
      blockId: heading.id,
      kind: "COVER",
      url: "https://seojing.com/images/seed/article-schema-mvp.svg",
      altText: "Seed cover for the SEOJing backend article schema MVP",
      mimeType: "image/svg+xml",
      metadata: { source: "seed", ticket: 162 },
    },
  });

  await prisma.article.update({
    where: { id: article.id },
    data: { currentRevisionId: revision.id },
  });

  console.log(`Seeded article ${seedSlug} (${article.id})`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
