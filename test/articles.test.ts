import { describe, expect, it, vi } from "vitest";

import {
  ArticleRepository,
  type ArticleWithContent,
} from "../src/repositories/articles.js";
import { ArticleService, normalizeSlug } from "../src/services/articles.js";

const createdAt = new Date("2026-06-28T00:00:00.000Z");

function articleFixture(
  overrides: Partial<ArticleWithContent> = {},
): ArticleWithContent {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "article-schema-mvp",
    title: "Article Schema MVP",
    description: "Schema test fixture",
    status: "DRAFT",
    sourceFormat: "MDX",
    sourceText: "# Article Schema MVP",
    renderedHtml: "<h1>Article Schema MVP</h1>",
    currentRevisionId: "22222222-2222-2222-2222-222222222222",
    publishedAt: null,
    createdAt,
    updatedAt: createdAt,
    currentRevision: {
      id: "22222222-2222-2222-2222-222222222222",
      articleId: "11111111-1111-1111-1111-111111111111",
      revisionNumber: 1,
      sourceFormat: "MDX",
      sourceText: "# Article Schema MVP",
      renderedHtml: "<h1>Article Schema MVP</h1>",
      changeSummary: "Initial revision",
      authorName: "OkayJing",
      createdAt,
    },
    revisions: [],
    blocks: [],
    assets: [],
    ...overrides,
  };
}

describe("ArticleService", () => {
  it("normalizes slug, defaults to MDX draft, and derives initial blocks", async () => {
    const findBySlug = vi.fn().mockResolvedValue(null);
    const createDraft = vi.fn().mockResolvedValue(articleFixture());
    const repository = {
      findBySlug,
      createDraft,
    } as unknown as ArticleRepository;
    const service = new ArticleService(repository);

    await service.createInitialDraft({
      slug: " Article Schema MVP!! ",
      title: " Article Schema MVP ",
      sourceText: "# Article Schema MVP\n\n본문 첫 문단",
      renderedHtml: "<h1>Article Schema MVP</h1><p>본문 첫 문단</p>",
    });

    expect(findBySlug).toHaveBeenCalledWith("article-schema-mvp");
    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "article-schema-mvp",
        title: "Article Schema MVP",
        sourceFormat: "MDX",
        status: "DRAFT",
        blocks: [
          expect.objectContaining({ type: "HEADING", sortOrder: 0 }),
          expect.objectContaining({ type: "PARAGRAPH", sortOrder: 1 }),
        ],
      }),
    );
  });

  it("rejects duplicate slugs before writing", async () => {
    const findBySlug = vi.fn().mockResolvedValue(articleFixture());
    const createDraft = vi.fn();
    const repository = {
      findBySlug,
      createDraft,
    } as unknown as ArticleRepository;
    const service = new ArticleService(repository);

    await expect(
      service.createInitialDraft({
        slug: "article-schema-mvp",
        title: "Article Schema MVP",
        sourceText: "# Article Schema MVP",
      }),
    ).rejects.toThrow("Article slug already exists");

    expect(createDraft).not.toHaveBeenCalled();
  });

  it("keeps Korean slugs while stripping noisy punctuation", () => {
    expect(normalizeSlug("  테스트 글!! / Day 1  ")).toBe("테스트-글/day-1");
  });
  it("reads only published articles for the public API", async () => {
    const findPublishedBySlug = vi
      .fn()
      .mockResolvedValue(articleFixture({ status: "PUBLISHED" }));
    const listPublished = vi
      .fn()
      .mockResolvedValue([articleFixture({ status: "PUBLISHED" })]);
    const repository = {
      findPublishedBySlug,
      listPublished,
    } as unknown as ArticleRepository;
    const service = new ArticleService(repository);

    await service.getPublicArticleBySlug(" Published API Contract ");
    await service.listPublicArticles(3);

    expect(findPublishedBySlug).toHaveBeenCalledWith("published-api-contract");
    expect(listPublished).toHaveBeenCalledWith(3);
  });
});

describe("ArticleRepository", () => {
  it("creates article, first revision, blocks, assets, and current revision in one transaction", async () => {
    const tx = {
      article: {
        create: vi
          .fn()
          .mockResolvedValue(articleFixture({ currentRevisionId: null })),
        update: vi.fn().mockResolvedValue(articleFixture()),
        findUnique: vi.fn().mockResolvedValue(articleFixture()),
      },
      articleRevision: {
        create: vi.fn().mockResolvedValue(articleFixture().currentRevision),
      },
      articleBlock: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      articleAsset: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const db = {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    const repository = new ArticleRepository(db as never);

    const created = await repository.createDraft({
      slug: "article-schema-mvp",
      title: "Article Schema MVP",
      sourceFormat: "MDX",
      sourceText: "# Article Schema MVP",
      renderedHtml: "<h1>Article Schema MVP</h1>",
      blocks: [
        {
          type: "HEADING",
          sortOrder: 0,
          content: { level: 1, text: "Article Schema MVP" },
          plainText: "Article Schema MVP",
        },
      ],
      assets: [
        {
          kind: "COVER",
          url: "https://seojing.com/images/seed/article-schema-mvp.svg",
          altText: "Cover",
        },
      ],
    });

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.article.create).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          slug: "article-schema-mvp",
          sourceFormat: "MDX",
          sourceText: "# Article Schema MVP",
        }),
      }),
    );
    expect(tx.articleRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({ revisionNumber: 1 }),
      }),
    );
    expect(tx.articleBlock.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ sortOrder: 0, type: "HEADING" })],
      }),
    );
    expect(tx.articleAsset.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ kind: "COVER" })],
      }),
    );
    expect(tx.article.update).toHaveBeenCalledWith({
      where: { id: "11111111-1111-1111-1111-111111111111" },
      data: { currentRevisionId: "22222222-2222-2222-2222-222222222222" },
    });
    expect(created.currentRevisionId).toBe(
      "22222222-2222-2222-2222-222222222222",
    );
  });
});
