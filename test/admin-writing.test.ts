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
    sourceText: string;
    status: string;
  };
  editor: {
    autosaveTarget: string;
    publishTarget: string;
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
});
