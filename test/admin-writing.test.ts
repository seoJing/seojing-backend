import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ArticleWithContent } from "../src/repositories/articles.js";
import {
  ArticlePublicationBlocked,
  type ArticleService,
} from "../src/services/articles.js";

interface SnippetPayload {
  snippets: Array<{ id: string; label: string }>;
}

interface EditorPayload {
  article: {
    slug: string;
    sourceFormat?: string;
    sourceText: string;
    renderedHtml?: string;
    previewRenderedHtml?: string;
    status: string;
    blocks?: Array<{
      id: string;
      type: string;
      content: Record<string, unknown>;
    }>;
  };
  editor: {
    mode?: string;
    autosaveTarget: string;
    publishTarget: string;
    blockTypes?: string[];
  };
}

const baseDate = new Date("2026-06-28T05:00:00.000Z");

function articleFixture(
  overrides: Partial<ArticleWithContent> = {},
): ArticleWithContent {
  const revision = {
    id: "22222222-2222-2222-2222-222222222222",
    articleId: "11111111-1111-1111-1111-111111111111",
    revisionNumber: 2,
    title: "Admin Draft",
    description: "Writing UX fixture",
    category: "SEOJing",
    sourceFormat: "MDX" as const,
    sourceText: "# Admin Draft\n\n<ArticleQuiz />",
    renderedHtml: "<h1>Admin Draft</h1>",
    changeSummary: "Admin editor revision",
    authorName: "OkayJing",
    createdAt: baseDate,
  };
  const effectiveRevision = {
    ...revision,
    sourceFormat: overrides.sourceFormat ?? revision.sourceFormat,
    sourceText: overrides.sourceText ?? revision.sourceText,
    renderedHtml: overrides.renderedHtml ?? revision.renderedHtml,
  };

  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "admin-draft",
    title: "Admin Draft",
    description: "Writing UX fixture",
    category: "SEOJing",
    status: "DRAFT",
    sourceFormat: "MDX",
    sourceText: revision.sourceText,
    renderedHtml: revision.renderedHtml,
    currentRevisionId: revision.id,
    publishedAt: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    currentRevision: effectiveRevision,
    revisions: [effectiveRevision],
    blocks: [],
    assets: [],
    ...overrides,
  };
}

function appWithArticleService(service: Partial<ArticleService>) {
  return buildApp({
    adminToken: "test-admin-token",
    articleService: service as ArticleService,
  });
}

describe("admin writing API", () => {
  it("re-renders the saved MDX source for preview without overwriting an old stored revision", async () => {
    const article = articleFixture({
      sourceText:
        "<Subtitle level={2}>문제 상황</Subtitle>\n\n<Paragraph>Fs 글 본문</Paragraph>",
      renderedHtml:
        "<aside>Paragraph component omitted by backend MDX ingest MVP</aside>",
    });
    const app = await appWithArticleService({
      getArticleBySlug: vi.fn().mockResolvedValue(article),
    });
    const response = await app.inject({
      method: "GET",
      url: "/admin/articles/admin-draft/editor",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<EditorPayload>();
    expect(payload.article.renderedHtml).toContain("component omitted");
    expect(payload.article.previewRenderedHtml).toContain("<h2");
    expect(payload.article.previewRenderedHtml).toContain("<p>Fs 글 본문</p>");
    expect(payload.article.previewRenderedHtml).not.toContain(
      "component omitted",
    );
    await app.close();
  });

  it("keeps the review queue private and returns source hashes without bodies", async () => {
    const listArticlesForReview = vi.fn().mockResolvedValue([
      {
        slug: "SEOJing/devLog/day1",
        title: "Day 1",
        category: "SEOJing",
        status: "DRAFT",
        sourceFormat: "MDX",
        sourceText: "# Day 1",
        updatedAt: baseDate,
      },
    ]);
    const app = await appWithArticleService({ listArticlesForReview });
    const unauthorized = await app.inject({
      method: "GET",
      url: "/admin/article-review-queue",
    });
    expect(unauthorized.statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/admin/article-review-queue",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as {
      articles: Array<Record<string, unknown>>;
    };
    expect(payload.articles[0]).toMatchObject({
      slug: "SEOJing/devLog/day1",
      status: "DRAFT",
    });
    expect(payload.articles[0]).toHaveProperty("sourceSha256");
    expect(payload.articles[0]).not.toHaveProperty("sourceText");
    await app.close();
  });

  it("requires the admin bearer token", async () => {
    const app = await appWithArticleService({});

    const response = await app.inject({
      method: "GET",
      url: "/admin/writing/snippets",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns MDX component insertion snippets for the editor toolbar", async () => {
    const app = await appWithArticleService({});

    const response = await app.inject({
      method: "GET",
      url: "/admin/writing/snippets",
      headers: { authorization: "Bearer test-admin-token" },
    });

    expect(response.statusCode).toBe(200);
    const snippetPayload = JSON.parse(response.body) as SnippetPayload;
    expect(snippetPayload.snippets.map((snippet) => snippet.id)).toEqual(
      expect.arrayContaining(["quiz", "callout", "code", "diagram"]),
    );
    expect(snippetPayload.snippets.map((snippet) => snippet.label)).toEqual(
      expect.arrayContaining(["/quiz", "/callout", "/code", "/diagram"]),
    );

    await app.close();
  });

  it("creates drafts, saves source-text revisions, and publishes the latest revision", async () => {
    const created = articleFixture({ currentRevisionId: "rev-1" });
    const revised = articleFixture({ currentRevisionId: "rev-1" });
    const published = articleFixture({ status: "PUBLISHED" });
    const createInitialDraft = vi.fn().mockResolvedValue(created);
    const createEditorRevision = vi.fn().mockResolvedValue(revised);
    const publishCurrentRevision = vi.fn().mockResolvedValue(published);
    const app = await appWithArticleService({
      createInitialDraft,
      createEditorRevision,
      publishCurrentRevision,
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/admin/articles",
      headers: { authorization: "Bearer test-admin-token" },
      payload: {
        slug: "Admin Draft",
        title: "Admin Draft",
        sourceText: "# Admin Draft",
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createInitialDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "Admin Draft",
        title: "Admin Draft",
        sourceFormat: "MDX",
        sourceText: "# Admin Draft",
        renderedHtml: '<h1 id="admin-draft">Admin Draft</h1>',
        blocks: [
          expect.objectContaining({
            type: "HEADING",
            content: {
              level: 1,
              text: "Admin Draft",
              id: "admin-draft",
              html: "Admin Draft",
            },
          }),
        ],
      }),
    );

    const revisionResponse = await app.inject({
      method: "PUT",
      url: "/admin/articles/admin-draft/revisions",
      headers: { authorization: "Bearer test-admin-token" },
      payload: {
        title: "Admin Draft v2",
        sourceText: "# Admin Draft v2\n\n<Callout />",
      },
    });
    expect(revisionResponse.statusCode).toBe(201);
    expect(createEditorRevision).toHaveBeenCalledWith(
      "admin-draft",
      expect.objectContaining({
        sourceText: "# Admin Draft v2\n\n<Callout />",
        renderedHtml: expect.stringContaining(
          'data-callout-tone="note"',
        ) as string,
        blocks: [
          expect.objectContaining({ type: "HEADING" }),
          expect.objectContaining({
            type: "CALLOUT",
            content: expect.objectContaining({
              tone: "note",
            }) as unknown,
          }),
        ],
      }),
    );
    const revisionPayload = JSON.parse(revisionResponse.body) as EditorPayload;
    expect(revisionPayload.article.slug).toBe("admin-draft");
    expect(revisionPayload.article.sourceText).toContain("<ArticleQuiz />");
    expect(revisionPayload.editor.autosaveTarget).toBe(
      "/admin/articles/admin-draft/revisions",
    );
    expect(revisionPayload.editor.publishTarget).toBe(
      "/admin/articles/admin-draft/publish",
    );

    const publishResponse = await app.inject({
      method: "POST",
      url: "/admin/articles/admin-draft/publish",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(publishResponse.statusCode).toBe(200);
    expect(publishCurrentRevision).toHaveBeenCalledWith("admin-draft");
    const publishPayload = JSON.parse(publishResponse.body) as EditorPayload;
    expect(publishPayload.article.status).toBe("PUBLISHED");

    await app.close();
  });

  it("opens a pending edit separately from the published revision and restores history", async () => {
    const published = articleFixture({ status: "PUBLISHED" });
    const current = published.currentRevision!;
    const pending = {
      ...current,
      id: "33333333-3333-3333-3333-333333333333",
      revisionNumber: current.revisionNumber + 1,
      title: "Pending title",
      sourceText: "# Pending title\n\nNew text",
      renderedHtml: "<h1>Pending title</h1><p>New text</p>",
    };
    const article = articleFixture({
      status: "PUBLISHED",
      currentRevision: current,
      revisions: [pending, current],
    });
    const getArticleBySlug = vi.fn().mockResolvedValue(article);
    const restoreRevision = vi.fn().mockResolvedValue(article);
    const app = await appWithArticleService({
      getArticleBySlug,
      restoreRevision,
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/articles/admin-draft/editor",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(response.statusCode).toBe(200);
    const editorPayload = response.json<EditorPayload>();
    expect(editorPayload.article).toMatchObject({
      title: "Pending title",
      sourceText: pending.sourceText,
      currentRevisionNumber: current.revisionNumber,
      editingRevisionNumber: pending.revisionNumber,
      hasUnpublishedChanges: true,
    });

    const restored = await app.inject({
      method: "POST",
      url: `/admin/articles/admin-draft/revisions/${current.revisionNumber}/restore`,
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(restored.statusCode).toBe(201);
    expect(restoreRevision).toHaveBeenCalledWith(
      "admin-draft",
      current.revisionNumber,
    );
    await app.close();
  });

  it("supports unpublish, archive, and permanent delete actions", async () => {
    const unpublishArticle = vi
      .fn()
      .mockResolvedValue(articleFixture({ status: "DRAFT" }));
    const archiveArticle = vi
      .fn()
      .mockResolvedValue(articleFixture({ status: "ARCHIVED" }));
    const deleteArticle = vi.fn().mockResolvedValue(true);
    const app = await appWithArticleService({
      unpublishArticle,
      archiveArticle,
      deleteArticle,
    });
    const headers = { authorization: "Bearer test-admin-token" };

    const unpublished = await app.inject({
      method: "POST",
      url: "/admin/articles/admin-draft/unpublish",
      headers,
    });
    expect(unpublished.statusCode).toBe(200);
    expect(unpublishArticle).toHaveBeenCalledWith("admin-draft");

    const archived = await app.inject({
      method: "POST",
      url: "/admin/articles/admin-draft/archive",
      headers,
    });
    expect(archived.statusCode).toBe(200);
    expect(archiveArticle).toHaveBeenCalledWith("admin-draft");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/admin/articles/admin-draft",
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleteArticle).toHaveBeenCalledWith("admin-draft");
    await app.close();
  });

  it("routes slash-containing slugs through admin editing and public read endpoints", async () => {
    const nestedSlug = "guides/fastify-routing";
    const nestedArticle = articleFixture({
      slug: nestedSlug,
      status: "PUBLISHED",
    });
    const getArticleBySlug = vi.fn().mockResolvedValue(nestedArticle);
    const getPublicArticleBySlug = vi.fn().mockResolvedValue(nestedArticle);
    const replaceArticleBlocks = vi.fn().mockResolvedValue(nestedArticle);
    const createEditorRevision = vi.fn().mockResolvedValue(nestedArticle);
    const publishCurrentRevision = vi.fn().mockResolvedValue(nestedArticle);
    const app = await appWithArticleService({
      getArticleBySlug,
      getPublicArticleBySlug,
      replaceArticleBlocks,
      createEditorRevision,
      publishCurrentRevision,
    });
    const headers = { authorization: "Bearer test-admin-token" };

    const publicResponse = await app.inject({
      method: "GET",
      url: `/articles/${nestedSlug}`,
    });
    expect(publicResponse.statusCode).toBe(200);
    expect(getPublicArticleBySlug).toHaveBeenCalledWith(nestedSlug);

    const readBlocksResponse = await app.inject({
      method: "GET",
      url: `/admin/articles/${nestedSlug}/blocks`,
      headers,
    });
    expect(readBlocksResponse.statusCode).toBe(200);
    expect(getArticleBySlug).toHaveBeenCalledWith(nestedSlug);

    const replaceBlocksResponse = await app.inject({
      method: "PUT",
      url: `/admin/articles/${nestedSlug}/blocks`,
      headers,
      payload: {
        blocks: [
          { type: "PARAGRAPH", content: { text: "Nested route draft" } },
        ],
      },
    });
    expect(replaceBlocksResponse.statusCode).toBe(201);
    expect(replaceArticleBlocks).toHaveBeenCalledWith(
      nestedSlug,
      expect.objectContaining({
        blocks: [
          { type: "PARAGRAPH", content: { text: "Nested route draft" } },
        ],
      }),
    );

    const revisionResponse = await app.inject({
      method: "PUT",
      url: `/admin/articles/${nestedSlug}/revisions`,
      headers,
      payload: { sourceText: "# Nested route draft" },
    });
    expect(revisionResponse.statusCode).toBe(201);
    expect(createEditorRevision).toHaveBeenCalledWith(
      nestedSlug,
      expect.objectContaining({ sourceText: "# Nested route draft" }),
    );

    const publishResponse = await app.inject({
      method: "POST",
      url: `/admin/articles/${nestedSlug}/publish`,
      headers,
    });
    expect(publishResponse.statusCode).toBe(200);
    expect(publishCurrentRevision).toHaveBeenCalledWith(nestedSlug);

    await app.close();
  });

  it("supports block-based draft creation and block CRUD revision endpoints", async () => {
    const blockArticle = articleFixture({
      sourceFormat: "BLOCKS",
      sourceText: "# Block Draft\n\n첫 문단",
      renderedHtml: '<h1 id="block-draft">Block Draft</h1>\n<p>첫 문단</p>',
      blocks: [
        {
          id: "block-1",
          articleId: "11111111-1111-1111-1111-111111111111",
          revisionId: "22222222-2222-2222-2222-222222222222",
          type: "HEADING",
          sortOrder: 0,
          content: { level: 1, text: "Block Draft", id: "block-draft" },
          plainText: "Block Draft",
          metadata: null,
          createdAt: baseDate,
          updatedAt: baseDate,
        },
        {
          id: "block-2",
          articleId: "11111111-1111-1111-1111-111111111111",
          revisionId: "22222222-2222-2222-2222-222222222222",
          type: "PARAGRAPH",
          sortOrder: 1,
          content: { text: "첫 문단" },
          plainText: "첫 문단",
          metadata: null,
          createdAt: baseDate,
          updatedAt: baseDate,
        },
      ],
    });
    const createBlockDraft = vi.fn().mockResolvedValue(blockArticle);
    const replaceArticleBlocks = vi.fn().mockResolvedValue(blockArticle);
    const appendArticleBlock = vi.fn().mockResolvedValue(blockArticle);
    const updateArticleBlock = vi.fn().mockResolvedValue(blockArticle);
    const deleteArticleBlock = vi.fn().mockResolvedValue(blockArticle);
    const app = await appWithArticleService({
      createBlockDraft,
      replaceArticleBlocks,
      appendArticleBlock,
      updateArticleBlock,
      deleteArticleBlock,
    });

    const blocks = [
      { type: "HEADING", content: { level: 1, text: "Block Draft" } },
      { type: "PARAGRAPH", content: { text: "첫 문단" } },
    ];

    const createResponse = await app.inject({
      method: "POST",
      url: "/admin/articles/blocks",
      headers: { authorization: "Bearer test-admin-token" },
      payload: { slug: "block-draft", title: "Block Draft", blocks },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createBlockDraft).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "block-draft", blocks }),
    );
    const createPayload = JSON.parse(createResponse.body) as EditorPayload;
    expect(createPayload.article.sourceFormat).toBe("BLOCKS");
    expect(createPayload.article.blocks?.map((block) => block.type)).toEqual([
      "HEADING",
      "PARAGRAPH",
    ]);
    expect(createPayload.editor.mode).toBe("blocks");
    expect(createPayload.editor.autosaveTarget).toBe(
      "/admin/articles/admin-draft/blocks",
    );
    expect(createPayload.editor.blockTypes).toEqual(
      expect.arrayContaining([
        "PARAGRAPH",
        "HEADING",
        "CODE",
        "IMAGE",
        "QUOTE",
        "CALLOUT",
        "QUIZ",
      ]),
    );

    const replaceResponse = await app.inject({
      method: "PUT",
      url: "/admin/articles/block-draft/blocks",
      headers: { authorization: "Bearer test-admin-token" },
      payload: { blocks },
    });
    expect(replaceResponse.statusCode).toBe(201);
    expect(replaceArticleBlocks).toHaveBeenCalledWith(
      "block-draft",
      expect.objectContaining({ blocks }),
    );

    const roundTripBlocks = [
      {
        id: "block-1",
        type: "HEADING",
        sortOrder: 0,
        content: { level: 1, text: "Block Draft" },
        plainText: "Block Draft",
        metadata: null,
      },
      {
        id: "block-2",
        type: "PARAGRAPH",
        sortOrder: 1,
        content: { text: "수정된 문단" },
        plainText: "수정된 문단",
        metadata: null,
      },
    ];
    const roundTripResponse = await app.inject({
      method: "PUT",
      url: "/admin/articles/block-draft/blocks",
      headers: { authorization: "Bearer test-admin-token" },
      payload: { blocks: roundTripBlocks },
    });
    expect(roundTripResponse.statusCode).toBe(201);
    expect(replaceArticleBlocks).toHaveBeenLastCalledWith(
      "block-draft",
      expect.objectContaining({ blocks: roundTripBlocks }),
    );

    await app.inject({
      method: "POST",
      url: "/admin/articles/block-draft/blocks",
      headers: { authorization: "Bearer test-admin-token" },
      payload: { block: { type: "CALLOUT", content: { text: "메모" } } },
    });
    expect(appendArticleBlock).toHaveBeenCalledWith(
      "block-draft",
      expect.objectContaining({
        block: { type: "CALLOUT", content: { text: "메모" } },
      }),
    );

    await app.inject({
      method: "PATCH",
      url: "/admin/articles/block-draft/blocks/block-2",
      headers: { authorization: "Bearer test-admin-token" },
      payload: { block: { content: { text: "수정된 문단" } } },
    });
    expect(updateArticleBlock).toHaveBeenCalledWith(
      "block-draft",
      "block-2",
      expect.objectContaining({ block: { content: { text: "수정된 문단" } } }),
    );

    await app.inject({
      method: "DELETE",
      url: "/admin/articles/block-draft/blocks/block-2",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(deleteArticleBlock).toHaveBeenCalledWith(
      "block-draft",
      "block-2",
      {},
    );

    await app.close();
  });

  it("returns a conflict when editing a published article without an unpublished draft model", async () => {
    const createEditorRevision = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Published article edits require a separate unpublished draft model.",
        ),
      );
    const app = await appWithArticleService({ createEditorRevision });

    const response = await app.inject({
      method: "PUT",
      url: "/admin/articles/published-post/revisions",
      headers: { authorization: "Bearer test-admin-token" },
      payload: {
        sourceText: "# Published edit",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error:
        "Published article edits require a separate unpublished draft model.",
    });

    await app.close();
  });

  it("returns publication issues for unsupported MDX", async () => {
    const publishCurrentRevision = vi
      .fn()
      .mockRejectedValue(
        new ArticlePublicationBlocked(
          "MDX contains content the CMS renderer cannot preserve.",
          [{ name: "UnknownWidget", line: 12 }],
        ),
      );
    const app = await appWithArticleService({ publishCurrentRevision });
    const response = await app.inject({
      method: "POST",
      url: "/admin/articles/post/publish",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "MDX contains content the CMS renderer cannot preserve.",
      issues: [{ name: "UnknownWidget", line: 12 }],
    });
    await app.close();
  });

  it("documents admin article draft, revision, and publish endpoints in OpenAPI", async () => {
    const app = await appWithArticleService({});
    const response = await app.inject({
      method: "GET",
      url: "/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    const document: {
      tags?: Array<{ name: string }>;
      paths?: Record<string, unknown>;
    } = response.json();
    expect(document.tags?.map((tag) => tag.name)).toContain("admin-writing");
    expect(document.paths).toHaveProperty("/admin/articles");
    expect(document.paths).toHaveProperty("/admin/articles/{slug}/revisions");
    expect(document.paths).toHaveProperty("/admin/articles/{slug}/publish");

    await app.close();
  });
});
