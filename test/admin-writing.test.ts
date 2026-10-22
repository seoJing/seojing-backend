import { describe, expect, it, vi } from "vitest";

import { ArticleDocumentValidationError } from "../src/services/article-document.js";

import { buildApp } from "../src/app.js";
import type { toPublicArticleDetail } from "../src/routes/articles.js";
import type { ArticleWithContent } from "../src/repositories/articles.js";
import {
  ArticleHistoricalMdxRestoreBlocked,
  type ArticleService,
} from "../src/services/articles.js";

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
    tags: [],
    cover: null,
    summaryVideo: null,
    displayDate: null,
    displayUpdatedAt: null,
    document: null,
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
    tags: [],
    cover: null,
    summaryVideo: null,
    displayDate: null,
    displayUpdatedAt: null,
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
  it("projects hostile editor block HTML through the exact public route sanitizer", async () => {
    const base = articleFixture({
      sourceFormat: "BLOCKS",
      status: "PUBLISHED",
      publishedAt: baseDate,
    });
    const hostile =
      '<strong onclick="alert(1)">Visible</strong><img src="/safe.png" onerror="alert(2)"><script>alert(3)</script><a href="javascript:alert(4)">link</a>';
    const article: ArticleWithContent = {
      ...base,
      renderedHtml: hostile,
      currentRevision: { ...base.currentRevision!, renderedHtml: hostile },
      revisions: [{ ...base.revisions[0]!, renderedHtml: hostile }],
      blocks: [
        {
          id: "hostile",
          articleId: base.id,
          revisionId: base.currentRevisionId!,
          type: "PARAGRAPH",
          sortOrder: 0,
          content: { text: "Visible", html: hostile },
          plainText: "Visible",
          metadata: null,
          createdAt: baseDate,
          updatedAt: baseDate,
        },
      ],
    };
    const app = await appWithArticleService({
      getArticleBySlug: vi.fn().mockResolvedValue(article),
      getPublicArticleBySlug: vi.fn().mockResolvedValue(article),
    });
    const publicResponse = await app.inject({
      method: "GET",
      url: "/articles/admin-draft",
    });
    const editorResponse = await app.inject({
      method: "GET",
      url: "/admin/articles/admin-draft/editor",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(publicResponse.statusCode).toBe(200);
    expect(editorResponse.statusCode).toBe(200);
    const editor = editorResponse.json<{
      article: {
        blocks: unknown[];
        preview: ReturnType<typeof toPublicArticleDetail>;
      };
    }>().article;
    expect(editor.blocks[0]).toMatchObject({ content: { html: hostile } }); // editing data stays lossless
    expect(editor.preview).toEqual(publicResponse.json());
    expect(
      (editor.preview.body.blocks[0]?.content as { html: string }).html,
    ).toContain("<strong>Visible</strong>");
    expect(JSON.stringify(editor.preview.body)).not.toMatch(
      /onerror|onclick|<script|javascript:/i,
    );
    await app.close();
  });

  it("previews the latest saved revision instead of leaking the old published revision into the editor", async () => {
    const base = articleFixture({
      sourceFormat: "BLOCKS",
      status: "PUBLISHED",
    });
    const latest = {
      ...base.revisions[0]!,
      id: "latest",
      title: "Latest draft",
      renderedHtml: '<p onclick="bad()">Latest body</p>',
    };
    const app = await appWithArticleService({
      getArticleBySlug: vi
        .fn()
        .mockResolvedValue({ ...base, revisions: [latest, ...base.revisions] }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/admin/articles/admin-draft/editor",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(
      response.json<{ article: { preview: unknown } }>().article.preview,
    ).toMatchObject({
      title: "Latest draft",
      body: { html: "<p>Latest body</p>" },
    });
    await app.close();
  });

  it("authenticates and bounds read-only unsaved previews with no service writes", async () => {
    const article = articleFixture({
      sourceFormat: "BLOCKS",
      slug: "study/nested",
    });
    const read = vi.fn().mockResolvedValue(article);
    // Any attempted service mutation would fail: only the read operation exists.
    const app = await appWithArticleService({ getArticleBySlug: read });
    const payload = {
      slug: article.slug,
      title: "Unsaved",
      blocks: [
        {
          type: "PARAGRAPH",
          content: {
            text: "Safe text",
            html: '<img src=x onerror="alert(1)">',
          },
        },
      ],
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/articles/preview",
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "POST",
      url: "/admin/articles/preview",
      payload,
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json<{ preview: unknown }>().preview).toMatchObject({
      title: "Unsaved",
      body: {
        html: "<p>Safe text</p>",
        blocks: [{ content: { text: "Safe text" } }],
      },
    });
    expect(JSON.stringify(response.json())).not.toMatch(/onerror|<img/);
    expect(article.title).toBe("Admin Draft");
    const oversized = await app.inject({
      method: "POST",
      url: "/admin/articles/preview",
      payload: { ...payload, title: "x".repeat(512 * 1024) },
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(oversized.statusCode).toBe(413);
    const invalid = await app.inject({
      method: "POST",
      url: "/admin/articles/preview",
      payload: { ...payload, blocks: [{ type: "UNKNOWN", content: {} }] },
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("validates unsaved documents with the canonical document renderer", async () => {
    const article = articleFixture({ sourceFormat: "DOCUMENT" });
    const app = await appWithArticleService({
      getArticleBySlug: vi.fn().mockResolvedValue(article),
    });
    const payload = {
      slug: article.slug,
      title: "Unsaved document",
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Visible text" }],
          },
        ],
      },
    };
    const options = {
      method: "POST" as const,
      url: "/admin/articles/preview",
      headers: { authorization: "Bearer test-admin-token" },
    };
    const response = await app.inject({ ...options, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ preview: unknown }>().preview).toMatchObject({
      body: { html: "<p>Visible text</p>", document: payload.document },
    });
    const invalid = await app.inject({
      ...options,
      payload: {
        ...payload,
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Unsafe",
                  marks: [
                    { type: "link", attrs: { href: "javascript:alert(1)" } },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("serves a protected published snapshot for a nested slug", async () => {
    const article = articleFixture({
      slug: "study/typescript/day1",
      status: "PUBLISHED",
      publishedAt: baseDate,
    });
    const read = vi.fn().mockResolvedValue(article);
    const app = await appWithArticleService({ getPublicArticleBySlug: read });
    const path = "/admin/articles/study%2Ftypescript%2Fday1/public-snapshot";
    const denied = await app.inject({ method: "GET", url: path });
    expect(denied.statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      slug: "study/typescript/day1",
      status: "PUBLISHED",
    });
    expect(read).toHaveBeenCalledWith("study/typescript/day1");
    await app.close();
  });

  it("returns an actionable 400 for invalid JSON document drafts and nested-slug revisions", async () => {
    const invalid = new ArticleDocumentValidationError("Invalid quiz item.");
    const app = await appWithArticleService({
      createDocumentDraft: vi.fn().mockRejectedValue(invalid),
      saveDocumentRevision: vi.fn().mockRejectedValue(invalid),
    });
    const headers = { authorization: "Bearer test-admin-token" };
    const created = await app.inject({
      method: "POST",
      url: "/admin/articles/documents",
      headers,
      payload: {
        slug: "native",
        title: "Native",
        document: { type: "doc", content: [] },
      },
    });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({ error: "Invalid quiz item." });
    const flatUpdated = await app.inject({
      method: "PUT",
      url: "/admin/articles/native/document",
      headers,
      payload: {
        title: "Native",
        expectedRevisionId: "revision-1",
        document: { type: "doc", content: [] },
      },
    });
    expect(flatUpdated.statusCode).toBe(400);
    const updated = await app.inject({
      method: "PUT",
      url: "/admin/articles/study/native/document",
      headers,
      payload: {
        title: "Native",
        expectedRevisionId: "revision-1",
        document: { type: "doc", content: [] },
      },
    });
    expect(updated.statusCode).toBe(400);
    expect(updated.json()).toMatchObject({ error: "Invalid quiz item." });
    await app.close();
  });

  it("requires the admin bearer token", async () => {
    const app = await appWithArticleService({});

    const response = await app.inject({
      method: "GET",
      url: "/admin/articles/published-slugs",
    });

    expect(response.statusCode).toBe(401);
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

  it("returns a clear conflict for historical MDX restore", async () => {
    const restoreRevision = vi
      .fn()
      .mockRejectedValue(new ArticleHistoricalMdxRestoreBlocked());
    const app = await appWithArticleService({ restoreRevision });
    const response = await app.inject({
      method: "POST",
      url: "/admin/articles/admin-draft/revisions/1/restore",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error:
        "Historical MDX revisions are read-only and cannot be restored after retirement.",
    });
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
    expect(document.paths).toHaveProperty("/admin/articles/documents");
    expect(document.paths).toHaveProperty("/admin/articles/{slug}/publish");

    await app.close();
  });
});

describe("bulk visibility contract", () => {
  it("requires authentication and bounded explicit unique IDs", async () => {
    const getArticleBySlug = vi.fn();
    const service = { getArticleBySlug } as unknown as ArticleService;
    const app = await buildApp({
      articleService: service,
      adminToken: "local-test-only",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/articles/bulk-visibility",
          payload: { action: "publish", slugs: ["a"], scope: {} },
        })
      ).statusCode,
    ).toBe(401);
    for (const slugs of [
      [],
      ["a", "a"],
      Array.from({ length: 21 }, (_, i) => `p${i}`),
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/admin/articles/bulk-visibility",
            headers: { authorization: "Bearer local-test-only" },
            payload: { action: "publish", slugs, scope: {} },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(getArticleBySlug).not.toHaveBeenCalled();
    await app.close();
  });
  it("checks filters and returns explicit partial failures without hiding completed items", async () => {
    const article = articleFixture({
      slug: "study/ok",
      category: "Study",
      status: "PUBLISHED",
    });
    const unpublishArticle = vi.fn((slug: string) => {
      if (slug === "study/fail")
        return Promise.reject(new Error("transaction rolled back"));
      return Promise.resolve({ ...article, status: "DRAFT" });
    });
    const service = {
      getArticleBySlug: vi.fn((slug: string) =>
        Promise.resolve({
          ...article,
          slug,
          category: slug === "other" ? "Other" : "Study",
        }),
      ),
      unpublishArticle,
    } as unknown as ArticleService;
    const app = await buildApp({
      articleService: service,
      adminToken: "local-test-only",
    });
    const response = await app.inject({
      method: "POST",
      url: "/admin/articles/bulk-visibility",
      headers: { authorization: "Bearer local-test-only" },
      payload: {
        action: "unpublish",
        slugs: ["study/ok", "other", "study/fail"],
        scope: { category: "Study", status: "PUBLISHED" },
      },
    });
    expect(response.json()).toEqual({
      ok: false,
      results: [
        { slug: "study/ok", ok: true, status: "DRAFT" },
        { slug: "other", ok: false, error: "article_outside_scope" },
        { slug: "study/fail", ok: false, error: "article_write_failed" },
      ],
    });
    expect(unpublishArticle).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
