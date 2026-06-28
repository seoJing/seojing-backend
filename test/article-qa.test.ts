import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ArticleService } from "../src/services/articles.js";
import {
  PythonWorkerError,
  type PythonWorkerClient,
} from "../src/services/python-worker.js";

const publishedArticle = {
  id: "article-1",
  slug: "study/js-closure",
  title: "JavaScript Closure Study",
  description: "section scoped QA fixture",
  status: "PUBLISHED",
  sourceFormat: "MDX",
  sourceText: "",
  renderedHtml: "",
  currentRevisionId: "rev-1",
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  revisions: [],
  assets: [],
  currentRevision: null,
  blocks: [
    {
      id: "h-closure",
      articleId: "article-1",
      revisionId: "rev-1",
      type: "HEADING",
      sortOrder: 1,
      content: { id: "closure", level: 2, text: "Closure" },
      plainText: "Closure",
      metadata: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: "p-closure",
      articleId: "article-1",
      revisionId: "rev-1",
      type: "PARAGRAPH",
      sortOrder: 2,
      content: {
        text: "A closure keeps lexical scope after the outer function returns.",
      },
      plainText:
        "A closure keeps lexical scope after the outer function returns.",
      metadata: { sectionId: "closure" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: "h-promise",
      articleId: "article-1",
      revisionId: "rev-1",
      type: "HEADING",
      sortOrder: 3,
      content: { id: "promise", level: 2, text: "Promise" },
      plainText: "Promise",
      metadata: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: "p-promise",
      articleId: "article-1",
      revisionId: "rev-1",
      type: "PARAGRAPH",
      sortOrder: 4,
      content: {
        text: "A promise schedules asynchronous continuation handlers.",
      },
      plainText: "A promise schedules asynchronous continuation handlers.",
      metadata: { sectionId: "promise" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ],
};

function articleServiceMock(article = publishedArticle) {
  return {
    getPublicArticleBySlug: vi.fn().mockResolvedValue(article),
  } as unknown as ArticleService;
}

function communityServiceMock() {
  return {} as never;
}

describe("public article QA API", () => {
  it("validates slug and section policy in Node, then delegates section-scoped context to the Python worker", async () => {
    const invoke = vi.fn().mockResolvedValue({
      result: {
        status: "answered",
        answer: "Closure keeps lexical scope after the outer function returns.",
        sources: [
          {
            articleSlug: "study/js-closure",
            blockId: "p-closure",
            sectionId: "closure",
            excerpt:
              "A closure keeps lexical scope after the outer function returns.",
            score: 2,
          },
        ],
        related: [
          { slug: "study/js-closure", title: "JavaScript Closure Study" },
        ],
      },
    });
    const app = await buildApp({
      articleService: articleServiceMock(),
      communityService: communityServiceMock(),
      pythonWorkerClient: {
        health: () =>
          Promise.resolve({
            status: "ok",
            worker: "seojing-python-worker",
            capabilities: ["qa", "rag"],
          }),
        invoke: invoke as unknown as PythonWorkerClient["invoke"],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/articles/study%2Fjs-closure/qa",
      headers: { "x-request-id": "qa-test" },
      payload: {
        question: "How does closure lexical scope work?",
        section_id: "closure",
        session_id: "reader-session-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      slug: "study/js-closure",
      sectionId: "closure",
      sessionId: "reader-session-1",
      mode: "worker",
      status: "answered",
    });
    const workerPayload = invoke.mock.calls[0]?.[1] as {
      article: { slug: string; sectionId: string | null };
      context: Array<{ blockId: string }>;
      question: string;
      sessionId: string | null;
    };
    expect(invoke).toHaveBeenCalledWith("qa", workerPayload, {
      requestId: "qa-test",
      signal: undefined,
    });
    expect(workerPayload).toMatchObject({
      question: "How does closure lexical scope work?",
      sessionId: "reader-session-1",
      article: { slug: "study/js-closure", sectionId: "closure" },
    });
    expect(workerPayload.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blockId: "p-closure" }),
      ]),
    );
    expect(JSON.stringify(workerPayload)).not.toContain("p-promise");
    expect(response.body).not.toContain("/Users/");

    await app.close();
  });

  it("returns a source-backed fallback on worker timeout without exposing worker details", async () => {
    const app = await buildApp({
      articleService: articleServiceMock(),
      communityService: communityServiceMock(),
      pythonWorkerClient: {
        health: () =>
          Promise.resolve({
            status: "degraded",
            worker: "seojing-python-worker",
            capabilities: ["qa"],
          }),
        invoke: vi
          .fn()
          .mockRejectedValue(
            new PythonWorkerError("timeout", "socket timed out", 504),
          ) as unknown as PythonWorkerClient["invoke"],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/articles/study%2Fjs-closure/qa",
      payload: { question: "closure lexical scope", section_id: "closure" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      mode: "fallback",
      status: "answered",
      error: { code: "timeout" },
    });
    expect(response.body).not.toContain("socket timed out");

    await app.close();
  });

  it("rejects unknown sections before calling the Python worker", async () => {
    const invoke = vi.fn();
    const app = await buildApp({
      articleService: articleServiceMock(),
      communityService: communityServiceMock(),
      pythonWorkerClient: {
        health: () =>
          Promise.resolve({
            status: "ok",
            worker: "seojing-python-worker",
            capabilities: ["qa"],
          }),
        invoke: invoke as unknown as PythonWorkerClient["invoke"],
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/articles/study%2Fjs-closure/qa",
      payload: { question: "closure?", section_id: "missing" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ok: false,
      error: {
        code: "section_not_found",
        message: "Article section not found",
      },
    });
    expect(invoke).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns insufficient_context rather than guessing when no source chunk matches", async () => {
    const app = await buildApp({
      articleService: articleServiceMock(),
      communityService: communityServiceMock(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/articles/study%2Fjs-closure/qa",
      payload: { question: "database connection pool" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      mode: "fallback",
      status: "insufficient_context",
      sources: [],
    });

    await app.close();
  });
});
