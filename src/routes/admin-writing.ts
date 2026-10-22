import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifySchema,
} from "fastify";

import type { ArticleWithContent } from "../repositories/articles.js";
import {
  ArticleHistoricalMdxRestoreBlocked,
  ArticlePublicationBlocked,
  previewArticleDraft,
  projectArticleRevision,
  type ArticleService,
  type BlockEditorDraftInput,
  type BlockEditorMutationInput,
  type BlockEditorUpdateInput,
  type DocumentEditorInput,
} from "../services/articles.js";
import type { BlockEditorBlockInput } from "../services/block-renderer.js";
import { ArticleDocumentValidationError } from "../services/article-document.js";

import { toPublicArticleDetail } from "./articles.js";

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

interface ArticleRevisionParams extends ArticleSlugParams {
  revisionNumber: string;
}

interface WildcardArticleParams {
  "*": string;
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

interface DocumentDraftBody extends DocumentEditorInput {
  slug?: string;
}

const documentDraftBodySchema = {
  type: "object",
  required: ["title", "document"],
  properties: {
    slug: { type: "string" },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    category: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    cover: {
      type: ["object", "null"],
      required: ["src", "alt"],
      properties: {
        src: { type: "string" },
        alt: { type: "string" },
        caption: { type: "string" },
        kind: { type: "string" },
      },
      additionalProperties: false,
    },
    summaryVideo: {
      type: ["object", "null"],
      required: ["src"],
      properties: Object.fromEntries(
        ["src", "title", "caption", "poster", "subtitles", "provider"].map(
          (key) => [key, { type: "string" }],
        ),
      ),
      additionalProperties: false,
    },
    displayDate: { type: ["string", "null"] },
    displayUpdatedAt: { type: ["string", "null"] },
    document: { type: "object", additionalProperties: true },
    expectedRevisionId: { type: "string" },
    changeSummary: { type: "string" },
    authorName: { type: "string" },
  },
  additionalProperties: false,
};

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

  app.post<{ Body: (DocumentDraftBody | BlockDraftBody) & { slug: string } }>(
    "/admin/articles/preview",
    {
      bodyLimit: 512 * 1024,
      schema: openApiSchema({
        tags: adminWritingTag,
        summary:
          "Project an unsaved draft through the public sanitizer without writing",
        body: {
          type: "object",
          required: ["slug", "title"],
          properties: {
            ...documentDraftBodySchema.properties,
            ...blockDraftBodySchema.properties,
            slug: { type: "string", minLength: 1, maxLength: 240 },
            title: { type: "string", minLength: 1 },
            blocks: {
              ...blockDraftBodySchema.properties.blocks,
              maxItems: 1000,
            },
          },
          additionalProperties: false,
        },
      }),
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const article = await options.articleService.getArticleBySlug(
        request.body.slug,
      );
      if (!article)
        return reply.status(404).send({ error: "Article not found" });
      try {
        const projected = previewArticleDraft(
          article,
          request.body as DocumentEditorInput | BlockEditorDraftInput,
        );
        return { preview: toPublicArticleDetail(projected) };
      } catch (error) {
        return reply.status(400).send({
          error:
            error instanceof Error ? error.message : "Invalid preview draft",
        });
      }
    },
  );

  // Explicit IDs only: never interpret an absent/empty list as all articles.
  // Each item's repository write is transactional; batches return partial results.
  app.post<{
    Body: {
      action: "publish" | "unpublish";
      slugs: string[];
      scope: {
        category?: string;
        status?: string;
        query?: string;
        format?: string;
      };
    };
  }>(
    "/admin/articles/bulk-visibility",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary:
          "Change visibility for up to 20 explicit article slugs with per-item results",
        body: {
          type: "object",
          required: ["action", "slugs", "scope"],
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["publish", "unpublish"] },
            slugs: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 240,
                pattern: "^[^?#\\s]+$",
              },
            },
            scope: {
              type: "object",
              additionalProperties: false,
              properties: {
                category: { type: "string", maxLength: 120 },
                status: {
                  type: "string",
                  enum: ["DRAFT", "PUBLISHED", "ARCHIVED"],
                },
                query: { type: "string", maxLength: 200 },
                format: { type: "string", enum: ["DOCUMENT", "BLOCKS", "MDX"] },
              },
            },
          },
        },
      }),
    },
    async (request) => {
      const results = [];
      for (const slug of request.body.slugs) {
        try {
          const article = await options.articleService.getArticleBySlug(slug);
          const scope = request.body.scope;
          if (!article || article.slug !== slug) {
            results.push({ slug, ok: false, error: "article_not_found" });
            continue;
          }
          if (
            (scope.category && article.category !== scope.category) ||
            (scope.status && article.status !== scope.status) ||
            (scope.format && article.sourceFormat !== scope.format) ||
            (scope.query &&
              !`${article.title} ${article.slug} ${article.category}`
                .toLowerCase()
                .includes(scope.query.trim().toLowerCase()))
          ) {
            results.push({ slug, ok: false, error: "article_outside_scope" });
            continue;
          }
          const updated =
            request.body.action === "publish"
              ? await options.articleService.publishCurrentRevision(
                  slug,
                  article.updatedAt,
                )
              : await options.articleService.unpublishArticle(
                  slug,
                  article.updatedAt,
                );
          results.push(
            updated
              ? {
                  slug,
                  ok: true,
                  status: updated.status,
                  ...(request.body.action === "publish"
                    ? { article: toPublicArticleDetail(updated) }
                    : {}),
                }
              : { slug, ok: false, error: "article_changed" },
          );
        } catch (error) {
          results.push({
            slug,
            ok: false,
            error:
              error instanceof ArticlePublicationBlocked
                ? error.message
                : "article_write_failed",
          });
        }
      }
      return { ok: results.every((result) => result.ok), results };
    },
  );

  app.get(
    "/admin/article-review-queue",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "List private CMS articles without source bodies",
      }),
    },
    async () => {
      const articles = await options.articleService.listArticlesForReview();
      return {
        articles: articles.map((article) => ({
          slug: article.slug,
          title: article.title,
          category: article.category,
          status: article.status,
          sourceFormat: article.sourceFormat,
          latestRevisionFormat: article.revisions[0]?.sourceFormat ?? null,
          updatedAt: article.updatedAt.toISOString(),
        })),
      };
    },
  );

  app.get(
    "/admin/articles/published-slugs",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary:
          "List every published article slug for snapshot reconciliation",
      }),
    },
    async () => ({ slugs: await options.articleService.listPublishedSlugs() }),
  );

  app.get<{ Params: ArticleSlugParams }>(
    "/admin/articles/:slug/public-snapshot",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Read a published article snapshot without public rate limits",
        params: articleSlugParamSchema,
      }),
    },
    async (request, reply) => {
      const article = await options.articleService.getPublicArticleBySlug(
        request.params.slug,
      );
      return article
        ? toPublicArticleDetail(article)
        : reply.status(404).send({ error: "Published article not found" });
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

  app.post<{ Body: DocumentDraftBody }>(
    "/admin/articles/documents",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Create an unpublished JSON document article",
        body: {
          ...documentDraftBodySchema,
          required: ["slug", "title", "document"],
        },
      }),
    },
    async (request, reply) => {
      try {
        const article = await options.articleService.createDocumentDraft(
          request.body,
        );
        return reply.status(201).send(toEditorPayload(article));
      } catch (error) {
        if (error instanceof ArticleDocumentValidationError)
          return reply.status(400).send({ error: error.message });
        throw error;
      }
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

  app.put<{ Params: ArticleSlugParams; Body: DocumentDraftBody }>(
    "/admin/articles/:slug/document",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary: "Save a JSON document as a new unpublished revision",
        params: articleSlugParamSchema,
        body: {
          ...documentDraftBodySchema,
          required: ["title", "document", "expectedRevisionId"],
        },
      }),
    },
    async (request, reply) => {
      try {
        const article = await options.articleService.saveDocumentRevision(
          request.params.slug,
          request.body,
        );
        if (!article)
          return reply.status(404).send({ error: "Article not found" });
        return reply.status(201).send(toEditorPayload(article));
      } catch (error) {
        if (error instanceof ArticleDocumentValidationError)
          return reply.status(400).send({ error: error.message });
        if (
          error instanceof Error &&
          error.message ===
            "Article revision changed before save. Reload and retry."
        ) {
          return reply.status(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: ArticleRevisionParams }>(
    "/admin/articles/:slug/revisions/:revisionNumber/restore",
    {
      schema: openApiSchema({
        tags: adminWritingTag,
        summary:
          "Copy an earlier article revision into a new unpublished revision",
        params: {
          type: "object",
          required: ["slug", "revisionNumber"],
          properties: {
            slug: { type: "string" },
            revisionNumber: { type: "string", pattern: "^[1-9][0-9]*$" },
          },
        },
      }),
    },
    async (request, reply) => {
      try {
        const article = await options.articleService.restoreRevision(
          request.params.slug,
          Number(request.params.revisionNumber),
        );
        if (!article) {
          return reply
            .status(404)
            .send({ error: "Article revision not found" });
        }
        return reply.status(201).send(toEditorPayload(article));
      } catch (error) {
        if (error instanceof ArticleHistoricalMdxRestoreBlocked)
          return reply.status(409).send({ error: error.message });
        throw error;
      }
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
      const article = await publishOrReply(
        options.articleService,
        request.params.slug,
        reply,
      );
      if (article === "blocked") return;
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
        "document",
        "public-snapshot",
      ]);
      if (!slug) {
        return reply.status(404).send({ error: "Article not found" });
      }
      if (request.params["*"].endsWith("/public-snapshot")) {
        const published =
          await options.articleService.getPublicArticleBySlug(slug);
        return published
          ? toPublicArticleDetail(published)
          : reply.status(404).send({ error: "Published article not found" });
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
    Body: BlockDraftBody | DocumentDraftBody;
  }>(
    "/admin/articles/*",
    { schema: { hide: true } },
    async (request, reply) => {
      const action = wildcardArticleAction(request.params["*"], [
        "blocks",
        "document",
      ]);
      if (!action) {
        return reply.status(404).send({ error: "Article not found" });
      }
      const body = request.body as Record<string, unknown>;
      if (
        (action.name === "blocks" && !Array.isArray(body.blocks)) ||
        (action.name === "document" &&
          (typeof body.title !== "string" ||
            !body.document ||
            typeof body.document !== "object" ||
            Array.isArray(body.document) ||
            typeof body.expectedRevisionId !== "string"))
      ) {
        return reply
          .status(400)
          .send({ error: "Invalid article revision body" });
      }
      let article: ArticleWithContent | null | "published-edit-rejected";
      try {
        article =
          action.name === "document"
            ? await options.articleService.saveDocumentRevision(
                action.slug,
                request.body as DocumentDraftBody,
              )
            : await rejectPublishedArticleEdits(async () =>
                options.articleService.replaceArticleBlocks(
                  action.slug,
                  toBlockDraftInput(request.body as BlockDraftBody),
                ),
              );
      } catch (error) {
        if (error instanceof ArticleDocumentValidationError)
          return reply.status(400).send({ error: error.message });
        if (
          error instanceof Error &&
          error.message ===
            "Article revision changed before save. Reload and retry."
        ) {
          return reply.status(409).send({ error: error.message });
        }
        throw error;
      }
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
        const article =
          action.name === "publish"
            ? await publishOrReply(options.articleService, action.slug, reply)
            : action.name === "unpublish"
              ? await options.articleService.unpublishArticle(action.slug)
              : await options.articleService.archiveArticle(action.slug);
        if (article === "blocked") return;
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
    return false;
  }
  return request.headers.authorization === `Bearer ${adminToken}`;
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
  const revision = article.revisions[0] ?? article.currentRevision;
  const sourceFormat = revision?.sourceFormat ?? article.sourceFormat;
  const sourceText = revision?.sourceText ?? article.sourceText;
  const blocks = article.blocks
    .filter((block) => block.revisionId === revision?.id)
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
      title: revision?.title ?? article.title,
      description: revision?.description ?? article.description,
      category: revision?.category ?? article.category,
      status: article.status,
      sourceFormat,
      sourceText,
      document: revision?.document ?? null,
      tags: revision?.tags ?? article.tags,
      cover: revision ? revision.cover : article.cover,
      summaryVideo: revision ? revision.summaryVideo : article.summaryVideo,
      displayDate:
        (revision
          ? revision.displayDate
          : article.displayDate
        )?.toISOString() ?? null,
      displayUpdatedAt:
        (revision
          ? revision.displayUpdatedAt
          : article.displayUpdatedAt
        )?.toISOString() ?? null,
      renderedHtml: revision ? revision.renderedHtml : article.renderedHtml,
      // Raw fields above are for editing only; render this public projection.
      preview: toPublicArticleDetail(projectArticleRevision(article, revision)),
      previewRenderedHtml: revision
        ? revision.renderedHtml
        : article.renderedHtml,
      blocks,
      currentRevisionId: article.currentRevisionId,
      currentRevisionNumber: article.currentRevision?.revisionNumber ?? null,
      editingRevisionNumber: revision?.revisionNumber ?? null,
      editingRevisionId: revision?.id ?? null,
      hasUnpublishedChanges: Boolean(
        revision && revision.id !== article.currentRevisionId,
      ),
      previewIssues: [],
      revisions: article.revisions.map((item) => ({
        revisionNumber: item.revisionNumber,
        sourceFormat: item.sourceFormat,
        changeSummary: item.changeSummary,
        createdAt: item.createdAt.toISOString(),
        isPublished:
          item.id === article.currentRevisionId &&
          article.status === "PUBLISHED",
      })),
      publishedAt: article.publishedAt?.toISOString() ?? null,
      updatedAt: article.updatedAt.toISOString(),
    },
    editor: {
      mode:
        revision?.sourceFormat === "DOCUMENT"
          ? "document"
          : revision?.sourceFormat === "BLOCKS"
            ? "blocks"
            : "historical",
      autosaveTarget:
        revision?.sourceFormat === "DOCUMENT"
          ? "/admin/articles/" + article.slug + "/document"
          : revision?.sourceFormat === "BLOCKS"
            ? "/admin/articles/" + article.slug + "/blocks"
            : null,
      publishTarget: `/admin/articles/${article.slug}/publish`,
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

async function publishOrReply(
  articleService: ArticleService,
  slug: string,
  reply: FastifyReply,
): Promise<ArticleWithContent | null | "blocked"> {
  try {
    return await articleService.publishCurrentRevision(slug);
  } catch (error) {
    if (!(error instanceof ArticlePublicationBlocked)) throw error;
    reply.status(409).send({ error: error.message, issues: error.issues });
    return "blocked";
  }
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
