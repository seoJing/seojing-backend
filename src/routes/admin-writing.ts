import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ArticleWithContent } from "../repositories/articles.js";
import type {
  ArticleEditorDraftInput,
  ArticleService,
  CreateArticleInput,
} from "../services/articles.js";

interface RegisterAdminWritingRoutesOptions {
  articleService: ArticleService;
  adminToken?: string;
}

interface ArticleSlugParams {
  slug: string;
}

interface UpsertDraftBody {
  slug?: string;
  title?: string;
  description?: string;
  sourceText?: string;
  renderedHtml?: string;
  changeSummary?: string;
  authorName?: string;
}

const componentSnippets = [
  {
    id: "quiz",
    label: "/quiz",
    description: "ArticleQuiz 블록을 빠르게 삽입하는 MDX 템플릿",
    insertText:
      '<ArticleQuiz title="확인 문제">\n  <ArticleQuizItem question="질문을 입력하세요" answer="정답 또는 해설을 입력하세요" />\n</ArticleQuiz>',
  },
  {
    id: "callout",
    label: "/callout",
    description: "핵심 메모나 주의점을 묶는 콜아웃 템플릿",
    insertText:
      '<Callout tone="note" title="메모">\n  여기에 설명을 입력하세요.\n</Callout>',
  },
  {
    id: "code",
    label: "/code",
    description: "언어가 지정된 코드 펜스 템플릿",
    insertText: "```ts\n// 예시 코드를 입력하세요\n```",
  },
  {
    id: "diagram",
    label: "/diagram",
    description: "텍스트 기반 다이어그램을 넣는 Mermaid 템플릿",
    insertText: "```mermaid\nflowchart TD\n  A[시작] --> B[결정]\n```",
  },
] as const;

export function registerAdminWritingRoutes(
  app: FastifyInstance,
  options: RegisterAdminWritingRoutesOptions,
): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin/")) {
      return;
    }
    if (!isAuthorized(request, options.adminToken)) {
      return reply.status(401).send({ error: "Unauthorized admin request" });
    }
  });

  app.get("/admin/writing/snippets", () => ({ snippets: componentSnippets }));

  app.post<{ Body: UpsertDraftBody }>(
    "/admin/articles",
    async (request, reply) => {
      const body = request.body ?? {};
      const article = await options.articleService.createInitialDraft(
        toCreateArticleInput(body),
      );

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.get<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug/editor",
    async (request, reply) => {
      const article = await options.articleService.getArticleBySlug(
        request.params.slug,
      );
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return toEditorPayload(article);
    },
  );

  app.put<{ Params: ArticleSlugParams; Body: UpsertDraftBody }>(
    "/admin/articles/:slug/revisions",
    async (request, reply) => {
      const article = await options.articleService.createEditorRevision(
        request.params.slug,
        toEditorDraftInput(request.body ?? {}),
      );
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.post<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug/publish",
    async (request, reply) => {
      const article = await options.articleService.publishCurrentRevision(
        request.params.slug,
      );
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return toEditorPayload(article);
    },
  );
}

function isAuthorized(request: FastifyRequest, adminToken: string | undefined) {
  if (!adminToken) {
    return true;
  }
  return request.headers.authorization === `Bearer ${adminToken}`;
}

function toCreateArticleInput(body: UpsertDraftBody): CreateArticleInput {
  return {
    slug: requiredString(body.slug, "slug"),
    title: requiredString(body.title, "title"),
    description: optionalString(body.description),
    sourceFormat: "MDX",
    sourceText: requiredString(body.sourceText, "sourceText"),
    renderedHtml: optionalString(body.renderedHtml),
    changeSummary: optionalString(body.changeSummary) ?? "Admin editor draft",
    authorName: optionalString(body.authorName),
  };
}

function toEditorDraftInput(body: UpsertDraftBody): ArticleEditorDraftInput {
  return {
    title: optionalString(body.title),
    description: optionalString(body.description),
    sourceText: requiredString(body.sourceText, "sourceText"),
    renderedHtml: optionalString(body.renderedHtml),
    changeSummary:
      optionalString(body.changeSummary) ?? "Admin editor revision",
    authorName: optionalString(body.authorName),
  };
}

function toEditorPayload(article: ArticleWithContent) {
  const revision = article.currentRevision;
  return {
    article: {
      id: article.id,
      slug: article.slug,
      title: article.title,
      description: article.description,
      status: article.status,
      sourceFormat: article.sourceFormat,
      sourceText: revision?.sourceText ?? article.sourceText,
      renderedHtml: revision?.renderedHtml ?? article.renderedHtml,
      currentRevisionId: article.currentRevisionId,
      currentRevisionNumber: revision?.revisionNumber ?? null,
      publishedAt: article.publishedAt?.toISOString() ?? null,
      updatedAt: article.updatedAt.toISOString(),
    },
    editor: {
      mode: "mdx",
      autosaveTarget: `/admin/articles/${article.slug}/revisions`,
      publishTarget: `/admin/articles/${article.slug}/publish`,
      insertButtons: componentSnippets,
    },
  };
}

function requiredString(value: string | undefined, field: string): string {
  if (!value?.trim()) {
    throw new Error(`Admin article ${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
