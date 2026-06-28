import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ArticleWithContent } from "../src/repositories/articles.js";
import type { ArticleService } from "../src/services/articles.js";

interface SnippetPayload {
  snippets: Array<{ id: string; label: string }>;
}

interface EditorPayload {
  article: {
    slug: string;
    sourceFormat?: string;
    sourceText: string;
    renderedHtml?: string;
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
    sourceFormat: "MDX" as const,
    sourceText: "# Admin Draft\n\n<ArticleQuiz />",
    renderedHtml: "<h1>Admin Draft</h1>",
    changeSummary: "Admin editor revision",
    authorName: "OkayJing",
    createdAt: baseDate,
  };

  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "admin-draft",
    title: "Admin Draft",
    description: "Writing UX fixture",
    status: "DRAFT",
    sourceFormat: "MDX",
    sourceText: revision.sourceText,
    renderedHtml: revision.renderedHtml,
    currentRevisionId: revision.id,
    publishedAt: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    currentRevision: revision,
    revisions: [revision],
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
});
