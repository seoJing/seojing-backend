import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ArticleWithContent } from "../src/repositories/articles.js";
import type { ArticleService } from "../src/services/articles.js";

const baseDate = new Date("2026-06-28T04:00:00.000Z");

function publicArticleFixture(
  overrides: Partial<ArticleWithContent> = {},
): ArticleWithContent {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "published-api-contract",
    title: "Published API Contract",
    description: "Public article contract fixture",
    status: "PUBLISHED",
    sourceFormat: "MDX",
    sourceText: "# Published API Contract\n\nDo not expose this source.",
    renderedHtml:
      '<h1 id="published-api-contract">Published API Contract</h1><p>public body</p>',
    currentRevisionId: "22222222-2222-2222-2222-222222222222",
    publishedAt: baseDate,
    createdAt: baseDate,
    updatedAt: baseDate,
    currentRevision: {
      id: "22222222-2222-2222-2222-222222222222",
      articleId: "11111111-1111-1111-1111-111111111111",
      revisionNumber: 1,
      sourceFormat: "MDX",
      sourceText: "# Published API Contract",
      renderedHtml: "<h1>Published API Contract</h1>",
      changeSummary: "Publish fixture",
      authorName: "OkayJing",
      createdAt: baseDate,
    },
    revisions: [],
    blocks: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        articleId: "11111111-1111-1111-1111-111111111111",
        revisionId: "22222222-2222-2222-2222-222222222222",
        type: "HEADING",
        sortOrder: 0,
        content: {
          level: 1,
          text: "Published API Contract",
          id: "published-api-contract",
        },
        plainText: "Published API Contract",
        metadata: null,
        createdAt: baseDate,
        updatedAt: baseDate,
      },
      {
        id: "44444444-4444-4444-4444-444444444444",
        articleId: "11111111-1111-1111-1111-111111111111",
        revisionId: "22222222-2222-2222-2222-222222222222",
        type: "PARAGRAPH",
        sortOrder: 1,
        content: {
          text: "public body",
          sourcePath: "/Users/seojing/private/post.mdx",
        },
        plainText: "public body",
        metadata: null,
        createdAt: baseDate,
        updatedAt: baseDate,
      },
    ],
    assets: [
      {
        id: "55555555-5555-5555-5555-555555555555",
        articleId: "11111111-1111-1111-1111-111111111111",
        revisionId: "22222222-2222-2222-2222-222222222222",
        blockId: null,
        kind: "COVER",
        url: "/Users/seojing/private/cover.svg",
        storageKey: "private/storage/key",
        altText: "Cover /tmp/generated.svg",
        mimeType: "image/svg+xml",
        sizeBytes: null,
        width: 1200,
        height: 630,
        metadata: null,
        createdAt: baseDate,
      },
    ],
    ...overrides,
  };
}

function appWithArticleService(service: Partial<ArticleService>) {
  return buildApp({ articleService: service as ArticleService });
}

describe("public article API", () => {
  it("lists only the service-provided published article metadata with cache headers", async () => {
    const listPublicArticles = vi
      .fn()
      .mockResolvedValue([publicArticleFixture()]);
    const app = await appWithArticleService({ listPublicArticles });

    const response = await app.inject({
      method: "GET",
      url: "/articles?limit=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain(
      "stale-while-revalidate",
    );
    expect(response.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(listPublicArticles).toHaveBeenCalledWith(1);
    expect(response.json()).toEqual(
      expect.objectContaining({
        count: 1,
        articles: [
          expect.objectContaining({
            slug: "published-api-contract",
            status: "PUBLISHED",
            toc: [
              {
                id: "published-api-contract",
                depth: 1,
                text: "Published API Contract",
              },
            ],
          }),
        ],
      }),
    );

    await app.close();
  });

  it("returns one article body without source text, draft data, storage keys, or local paths", async () => {
    const getPublicArticleBySlug = vi
      .fn()
      .mockResolvedValue(publicArticleFixture());
    const app = await appWithArticleService({ getPublicArticleBySlug });

    const response = await app.inject({
      method: "GET",
      url: "/articles/published-api-contract",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("public");
    const payloadText = response.body;
    expect(payloadText).not.toContain("sourceText");
    expect(payloadText).not.toContain("private/storage/key");
    expect(payloadText).not.toContain("/Users/seojing");
    expect(payloadText).not.toContain("/tmp/generated.svg");

    const payload = JSON.parse(response.body) as {
      body: {
        html: string;
        blocks: Array<{ content: Record<string, unknown> }>;
      };
      assets: Array<{ url: string }>;
    };
    expect(payload.body.html).toContain("public body");
    expect(payload.body.blocks[1]?.content.sourcePath).toBe(
      "[local-path-redacted]",
    );
    expect(payload.assets[0]?.url).toBe("#redacted-local-asset");

    const cached = await app.inject({
      method: "GET",
      url: "/articles/published-api-contract",
      headers: { "if-none-match": String(response.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");

    await app.close();
  });

  it("sanitizes public rendered HTML before returning backend article bodies", async () => {
    const getPublicArticleBySlug = vi.fn().mockResolvedValue(
      publicArticleFixture({
        renderedHtml:
          '<h1 onclick="alert(1)">Title</h1><script>alert(1)</script><a href="javascript:alert(1)">bad</a><img src="/safe.svg" onerror="alert(1)" />',
      }),
    );
    const app = await appWithArticleService({ getPublicArticleBySlug });

    const response = await app.inject({
      method: "GET",
      url: "/articles/published-api-contract",
    });

    expect(response.statusCode).toBe(200);
    const payload: { body: { html: string } } = response.json();
    expect(payload.body.html).toContain("<h1>Title</h1>");
    expect(payload.body.html).toContain('href="#removed-javascript-url"');
    expect(payload.body.html).toContain('src="/safe.svg"');
    expect(payload.body.html).not.toContain("<script");
    expect(payload.body.html).not.toContain("onclick");
    expect(payload.body.html).not.toContain("onerror");
    expect(payload.body.html).not.toContain("javascript:alert");

    await app.close();
  });

  it("does not expose missing or draft articles", async () => {
    const getPublicArticleBySlug = vi.fn().mockResolvedValue(null);
    const app = await appWithArticleService({ getPublicArticleBySlug });

    const response = await app.inject({
      method: "GET",
      url: "/articles/draft-only",
    });

    expect(response.statusCode).toBe(404);
    expect(getPublicArticleBySlug).toHaveBeenCalledWith("draft-only");

    await app.close();
  });
});
