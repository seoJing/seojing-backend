import type { FastifyInstance, FastifyRequest, FastifySchema } from "fastify";

import type { ArticleWithContent } from "../repositories/articles.js";
import type {
  ArticleEditorDraftInput,
  ArticleService,
  BlockEditorDraftInput,
  BlockEditorMutationInput,
  BlockEditorUpdateInput,
  CreateArticleInput,
} from "../services/articles.js";
import type { BlockEditorBlockInput } from "../services/block-renderer.js";
import { ingestMdxArticle } from "../services/mdx-ingest.js";

interface RegisterAdminWritingRoutesOptions {
  articleService: ArticleService;
  adminToken?: string;
}

interface ArticleSlugParams {
  slug: string;
}

interface ArticleBlockParams extends ArticleSlugParams {
  blockId: string;
}

interface WildcardArticleParams {
  "*": string;
}

interface UpsertDraftBody {
  slug?: string;
  title?: string;
  description?: string;
  category?: string;
  sourceText?: string;
  renderedHtml?: string;
  changeSummary?: string;
  authorName?: string;
}

interface BlockDraftBody {
  slug?: string;
  title?: string;
  description?: string;
  category?: string;
  blocks?: BlockEditorBlockInput[];
  changeSummary?: string;
  authorName?: string;
}

interface BlockMutationBody {
  block?: BlockEditorBlockInput;
  changeSummary?: string;
  authorName?: string;
}

interface BlockUpdateBody {
  block?: Partial<BlockEditorBlockInput>;
  changeSummary?: string;
  authorName?: string;
}

interface BlockDeleteBody {
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

const adminWritingTag = ["admin-writing"];
const articleSlugParamSchema = {
  type: "object",
  required: ["slug"],
  properties: { slug: { type: "string" } },
};
const articleBlockParamSchema = {
  type: "object",
  required: ["slug", "blockId"],
  properties: { slug: { type: "string" }, blockId: { type: "string" } },
};
const upsertDraftBodySchema = {
  type: "object",
  properties: {
    slug: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    category: { type: "string", minLength: 1, maxLength: 120 },
    sourceText: { type: "string" },
    renderedHtml: { type: "string" },
    changeSummary: { type: "string" },
    authorName: { type: "string" },
  },
};
const articleBlockBodySchema = {
  type: "object",
  required: ["type", "content"],
  properties: {
    id: { type: "string" },
    type: {
      type: "string",
      enum: [
        "PARAGRAPH",
        "HEADING",
        "CODE",
        "IMAGE",
        "QUOTE",
        "CALLOUT",
        "QUIZ",
      ],
    },
    sortOrder: { type: "number" },
    content: { type: "object", additionalProperties: true },
    plainText: { type: "string" },
    metadata: { type: ["object", "null"], additionalProperties: true },
  },
  additionalProperties: false,
};
const articleBlockPatchSchema = {
  type: "object",
  properties: articleBlockBodySchema.properties,
  minProperties: 1,
  additionalProperties: false,
};
const blockDraftBodySchema = {
  type: "object",
  properties: {
    slug: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    category: { type: "string", minLength: 1, maxLength: 120 },
    blocks: {
      type: "array",
      items: articleBlockBodySchema,
    },
    changeSummary: { type: "string" },
    authorName: { type: "string" },
  },
};
const blockMutationBodySchema = {
  type: "object",
  properties: {
    block: articleBlockBodySchema,
    changeSummary: { type: "string" },
    authorName: { type: "string" },
  },
};
const blockUpdateBodySchema = {
  type: "object",
  properties: {
    block: articleBlockPatchSchema,
    changeSummary: { type: "string" },
    authorName: { type: "string" },
  },
};
const blockDeleteBodySchema = {
  type: "object",
  properties: {
    changeSummary: { type: "string" },
    authorName: { type: "string" },
  },
};

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

  app.get(
    "/admin/writing/snippets",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "List admin editor snippets",
      }),
    },
    () => ({ snippets: componentSnippets }),
  );

  app.post<{ Body: UpsertDraftBody }>(
    "/admin/articles",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Create an unpublished article draft",
        body: {
          ...upsertDraftBodySchema,
          required: ["slug", "title", "sourceText"],
        },
      }),
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const article = await options.articleService.createInitialDraft(
        toCreateArticleInput(body),
      );

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.post<{ Body: BlockDraftBody }>(
    "/admin/articles/blocks",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Create an unpublished block-editor article draft",
        body: {
          ...blockDraftBodySchema,
          required: ["slug", "title", "blocks"],
        },
      }),
    },
    async (request, reply) => {
      const article = await options.articleService.createBlockDraft(
        toBlockDraftInput(request.body ?? {}),
      );

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.get<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug/blocks",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Read current block-editor draft state",
        params: articleSlugParamSchema,
      }),
    },
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

  app.put<{ Params: ArticleSlugParams; Body: BlockDraftBody }>(
    "/admin/articles/:slug/blocks",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Save a block-editor revision",
        params: articleSlugParamSchema,
        body: { ...blockDraftBodySchema, required: ["blocks"] },
      }),
    },
    async (request, reply) => {
      const article = await rejectPublishedArticleEdits(async () =>
        options.articleService.replaceArticleBlocks(
          request.params.slug,
          toBlockDraftInput(request.body ?? {}),
        ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.post<{ Params: ArticleSlugParams; Body: BlockMutationBody }>(
    "/admin/articles/:slug/blocks",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Append a block-editor block as a new revision",
        params: articleSlugParamSchema,
        body: { ...blockMutationBodySchema, required: ["block"] },
      }),
    },
    async (request, reply) => {
      const article = await rejectPublishedArticleEdits(async () =>
        options.articleService.appendArticleBlock(
          request.params.slug,
          toBlockMutationInput(request.body ?? {}),
        ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.patch<{ Params: ArticleBlockParams; Body: BlockUpdateBody }>(
    "/admin/articles/:slug/blocks/:blockId",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Update a block-editor block as a new revision",
        params: articleBlockParamSchema,
        body: { ...blockUpdateBodySchema, required: ["block"] },
      }),
    },
    async (request, reply) => {
      const article = await rejectPublishedArticleEdits(async () =>
        options.articleService.updateArticleBlock(
          request.params.slug,
          request.params.blockId,
          toBlockUpdateInput(request.body ?? {}),
        ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.delete<{ Params: ArticleBlockParams; Body: BlockDeleteBody }>(
    "/admin/articles/:slug/blocks/:blockId",
    {
      preValidation: (request, _reply, done) => {
        request.body ??= {};
        done();
      },
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Delete a block-editor block as a new revision",
        params: articleBlockParamSchema,
        body: blockDeleteBodySchema,
      }),
    },
    async (request, reply) => {
      const article = await rejectPublishedArticleEdits(async () =>
        options.articleService.deleteArticleBlock(
          request.params.slug,
          request.params.blockId,
          request.body ?? {},
        ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.get<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug/editor",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Read admin editor state for an article",
        params: articleSlugParamSchema,
      }),
    },
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
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Save an MDX source-text article revision",
        params: articleSlugParamSchema,
        body: { ...upsertDraftBodySchema, required: ["sourceText"] },
      }),
    },
    async (request, reply) => {
      const article = await rejectPublishedArticleEdits(async () =>
        options.articleService.createEditorRevision(
          request.params.slug,
          toEditorDraftInput(request.body ?? {}),
        ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.post<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug/publish",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Publish the latest saved article revision",
        params: articleSlugParamSchema,
      }),
    },
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

  app.post<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug/unpublish",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Move an article back to draft visibility",
        params: articleSlugParamSchema,
      }),
    },
    async (request, reply) => {
      const article = await options.articleService.unpublishArticle(
        request.params.slug,
      );
      if (!article)
        return reply.status(404).send({ error: "Article not found" });
      return toEditorPayload(article);
    },
  );

  app.post<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug/archive",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Archive an article and remove it from public reads",
        params: articleSlugParamSchema,
      }),
    },
    async (request, reply) => {
      const article = await options.articleService.archiveArticle(
        request.params.slug,
      );
      if (!article)
        return reply.status(404).send({ error: "Article not found" });
      return toEditorPayload(article);
    },
  );

  app.delete<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Permanently delete an article",
        params: articleSlugParamSchema,
      }),
    },
    async (request, reply) => {
      const deleted = await options.articleService.deleteArticle(
        request.params.slug,
      );
      if (!deleted)
        return reply.status(404).send({ error: "Article not found" });
      return reply.status(204).send();
    },
  );

  // Fastify wildcards must terminate a route. These hidden fallbacks preserve the
  // documented flat-slug routes above while accepting a slash-containing slug.
  app.get<{ Params: WildcardArticleParams }>(
    "/admin/articles/*",
    { schema: { hide: true } },
    async (request, reply) => {
      const slug = wildcardSlugForAction(request.params["*"], [
        "blocks",
        "editor",
      ]);
      if (!slug) {
        return reply.status(404).send({ error: "Article not found" });
      }
      const article = await options.articleService.getArticleBySlug(slug);
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return toEditorPayload(article);
    },
  );

  app.put<{
    Params: WildcardArticleParams;
    Body: BlockDraftBody | UpsertDraftBody;
  }>(
    "/admin/articles/*",
    { schema: { hide: true } },
    async (request, reply) => {
      const action = wildcardArticleAction(request.params["*"], [
        "blocks",
        "revisions",
      ]);
      if (!action) {
        return reply.status(404).send({ error: "Article not found" });
      }
      const body = request.body as Record<string, unknown>;
      if (
        (action.name === "blocks" && !Array.isArray(body.blocks)) ||
        (action.name === "revisions" && typeof body.sourceText !== "string")
      ) {
        return reply
          .status(400)
          .send({ error: "Invalid article revision body" });
      }
      const article = await rejectPublishedArticleEdits(async () =>
        action.name === "blocks"
          ? options.articleService.replaceArticleBlocks(
              action.slug,
              toBlockDraftInput(request.body),
            )
          : options.articleService.createEditorRevision(
              action.slug,
              toEditorDraftInput(request.body),
            ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.post<{ Params: WildcardArticleParams; Body: BlockMutationBody }>(
    "/admin/articles/*",
    { schema: { hide: true } },
    async (request, reply) => {
      const action = wildcardArticleAction(request.params["*"], [
        "blocks",
        "publish",
        "unpublish",
        "archive",
      ]);
      if (!action) {
        return reply.status(404).send({ error: "Article not found" });
      }
      if (
        action.name === "blocks" &&
        !(request.body?.block instanceof Object)
      ) {
        return reply.status(400).send({ error: "Invalid article block body" });
      }
      if (["publish", "unpublish", "archive"].includes(action.name)) {
        const article = await (action.name === "publish"
          ? options.articleService.publishCurrentRevision(action.slug)
          : action.name === "unpublish"
            ? options.articleService.unpublishArticle(action.slug)
            : options.articleService.archiveArticle(action.slug));
        if (!article) {
          return reply.status(404).send({ error: "Article not found" });
        }

        return toEditorPayload(article);
      }

      const article = await rejectPublishedArticleEdits(async () =>
        options.articleService.appendArticleBlock(
          action.slug,
          toBlockMutationInput(request.body ?? {}),
        ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.patch<{ Params: WildcardArticleParams; Body: BlockUpdateBody }>(
    "/admin/articles/*",
    { schema: { hide: true } },
    async (request, reply) => {
      const block = wildcardBlockParams(request.params["*"]);
      if (!block) {
        return reply.status(404).send({ error: "Article not found" });
      }
      if (!(request.body?.block instanceof Object)) {
        return reply.status(400).send({ error: "Invalid article block body" });
      }
      const article = await rejectPublishedArticleEdits(async () =>
        options.articleService.updateArticleBlock(
          block.slug,
          block.blockId,
          toBlockUpdateInput(request.body ?? {}),
        ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );

  app.delete<{ Params: WildcardArticleParams; Body: BlockDeleteBody }>(
    "/admin/articles/*",
    {
      preValidation: (request, _reply, done) => {
        request.body ??= {};
        done();
      },
      schema: { hide: true },
    },
    async (request, reply) => {
      const block = wildcardBlockParams(request.params["*"]);
      if (!block) {
        const deleted = await options.articleService.deleteArticle(
          request.params["*"],
        );
        if (!deleted) {
          return reply.status(404).send({ error: "Article not found" });
        }
        return reply.status(204).send();
      }
      const article = await rejectPublishedArticleEdits(async () =>
        options.articleService.deleteArticleBlock(
          block.slug,
          block.blockId,
          request.body ?? {},
        ),
      );
      if (article === "published-edit-rejected") {
        return reply.status(409).send({
          error:
            "Published article edits require a separate unpublished draft model.",
        });
      }
      if (!article) {
        return reply.status(404).send({ error: "Article not found" });
      }

      return reply.status(201).send(toEditorPayload(article));
    },
  );
}

function wildcardSlugForAction(
  path: string,
  actions: string[],
): string | undefined {
  return wildcardArticleAction(path, actions)?.slug;
}

function wildcardArticleAction(
  path: string,
  actions: string[],
): { slug: string; name: string } | undefined {
  for (const name of actions) {
    const suffix = `/${name}`;
    if (!path.endsWith(suffix)) {
      continue;
    }
    const slug = path.slice(0, -suffix.length);
    if (slug) {
      return { slug, name };
    }
  }
  return undefined;
}

function wildcardBlockParams(
  path: string,
): { slug: string; blockId: string } | undefined {
  const marker = "/blocks/";
  const index = path.lastIndexOf(marker);
  if (index <= 0) {
    return undefined;
  }
  const slug = path.slice(0, index);
  const blockId = path.slice(index + marker.length);
  return slug && blockId && !blockId.includes("/")
    ? { slug, blockId }
    : undefined;
}

type OpenApiFastifySchema = FastifySchema & {
  tags?: string[];
  summary?: string;
};

async function rejectPublishedArticleEdits<T>(
  action: () => Promise<T>,
): Promise<T | "published-edit-rejected"> {
  try {
    return await action();
  } catch (error) {
    if (isPublishedArticleEditError(error)) {
      return "published-edit-rejected";
    }
    throw error;
  }
}

function isPublishedArticleEditError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message ===
      "Published article edits require a separate unpublished draft model."
  );
}

function openApiSchema(schema: OpenApiFastifySchema): FastifySchema {
  return { ...schema };
}

function isAuthorized(request: FastifyRequest, adminToken: string | undefined) {
  if (!adminToken) {
    return true;
  }
  return request.headers.authorization === `Bearer ${adminToken}`;
}

function toCreateArticleInput(body: UpsertDraftBody): CreateArticleInput {
  const sourceText = requiredString(body.sourceText, "sourceText");
  const slug = requiredString(body.slug, "slug");
  const title = requiredString(body.title, "title");
  const ingest = ingestMdxArticle(sourceText, { fallbackSlug: slug });
  return {
    slug,
    title,
    description: optionalString(body.description) ?? ingest.description,
    category: optionalString(body.category),
    sourceFormat: "MDX",
    sourceText,
    renderedHtml: optionalString(body.renderedHtml) ?? ingest.renderedHtml,
    changeSummary: optionalString(body.changeSummary) ?? "Admin editor draft",
    authorName: optionalString(body.authorName),
    blocks: ingest.blocks,
    assets: ingest.assets,
  };
}

function toEditorDraftInput(body: UpsertDraftBody): ArticleEditorDraftInput {
  const sourceText = requiredString(body.sourceText, "sourceText");
  const ingest = ingestMdxArticle(sourceText);
  return {
    title: optionalString(body.title) ?? ingest.title,
    description: optionalString(body.description) ?? ingest.description,
    category: optionalString(body.category),
    sourceText,
    renderedHtml: optionalString(body.renderedHtml) ?? ingest.renderedHtml,
    changeSummary:
      optionalString(body.changeSummary) ?? "Admin editor revision",
    authorName: optionalString(body.authorName),
    blocks: ingest.blocks,
    assets: ingest.assets,
  };
}

function toBlockDraftInput(body: BlockDraftBody): BlockEditorDraftInput {
  return {
    slug: optionalString(body.slug),
    title: optionalString(body.title),
    description: optionalString(body.description),
    category: optionalString(body.category),
    blocks: requiredBlocks(body.blocks),
    changeSummary:
      optionalString(body.changeSummary) ?? "Block editor revision",
    authorName: optionalString(body.authorName),
  };
}

function toBlockMutationInput(
  body: BlockMutationBody,
): BlockEditorMutationInput {
  if (!body.block) {
    throw new Error("Admin article block is required.");
  }
  return {
    block: body.block,
    changeSummary: optionalString(body.changeSummary) ?? "Block editor append",
    authorName: optionalString(body.authorName),
  };
}

function toBlockUpdateInput(body: BlockUpdateBody): BlockEditorUpdateInput {
  if (!body.block) {
    throw new Error("Admin article block is required.");
  }
  return {
    block: body.block,
    changeSummary: optionalString(body.changeSummary) ?? "Block editor update",
    authorName: optionalString(body.authorName),
  };
}

function requiredBlocks(
  blocks: BlockEditorBlockInput[] | undefined,
): BlockEditorBlockInput[] {
  if (!blocks?.length) {
    throw new Error("Admin article blocks are required.");
  }
  return blocks;
}

function toEditorPayload(article: ArticleWithContent) {
  const revision = article.currentRevision;
  const blocks = article.blocks
    .filter((block) => block.revisionId === article.currentRevisionId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((block) => ({
      id: block.id,
      type: block.type,
      sortOrder: block.sortOrder,
      content: block.content,
      plainText: block.plainText,
      metadata: block.metadata,
    }));
  return {
    article: {
      id: article.id,
      slug: article.slug,
      title: article.title,
      description: article.description,
      category: article.category,
      status: article.status,
      sourceFormat: article.sourceFormat,
      sourceText: revision?.sourceText ?? article.sourceText,
      renderedHtml: revision?.renderedHtml ?? article.renderedHtml,
      blocks,
      currentRevisionId: article.currentRevisionId,
      currentRevisionNumber: revision?.revisionNumber ?? null,
      publishedAt: article.publishedAt?.toISOString() ?? null,
      updatedAt: article.updatedAt.toISOString(),
    },
    editor: {
      mode: article.sourceFormat === "BLOCKS" ? "blocks" : "mdx",
      autosaveTarget:
        article.sourceFormat === "BLOCKS"
          ? `/admin/articles/${article.slug}/blocks`
          : `/admin/articles/${article.slug}/revisions`,
      publishTarget: `/admin/articles/${article.slug}/publish`,
      insertButtons: componentSnippets,
      blockTypes: [
        "PARAGRAPH",
        "HEADING",
        "CODE",
        "IMAGE",
        "QUOTE",
        "CALLOUT",
        "QUIZ",
      ],
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
