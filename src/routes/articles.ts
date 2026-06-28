import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ArticleWithContent } from "../repositories/articles.js";
import type { ArticleService } from "../services/articles.js";

const publicCacheControl =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";

interface RegisterArticleRoutesOptions {
  articleService: ArticleService;
}

interface ArticleListQuery {
  limit?: string | number;
}

interface ArticleSlugParams {
  slug: string;
}

interface WildcardArticleSlugParams {
  "*": string;
}

interface PublicArticleSummary {
  slug: string;
  title: string;
  description: string | null;
  status: "PUBLISHED";
  publishedAt: string | null;
  updatedAt: string;
  etag: string;
  toc: PublicTocItem[];
  assets: PublicArticleAsset[];
}

interface PublicArticleDetail extends PublicArticleSummary {
  body: {
    html: string;
    blocks: PublicArticleBlock[];
  };
}

interface PublicTocItem {
  id: string;
  depth: number;
  text: string;
}

interface PublicArticleBlock {
  id: string;
  type: string;
  sortOrder: number;
  content: unknown;
  plainText: string | null;
}

interface PublicArticleAsset {
  kind: string;
  url: string;
  altText: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}

export function registerArticleRoutes(
  app: FastifyInstance,
  options: RegisterArticleRoutesOptions,
): void {
  app.get<{ Querystring: ArticleListQuery }>(
    "/articles",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const limit = parseLimit(request.query.limit);
      const articles = await options.articleService.listPublicArticles(limit);
      const items = articles.map(toPublicArticleSummary);
      const etag = makeEtag(items);

      setPublicCacheHeaders(reply, etag);
      if (isNotModified(request, etag)) {
        return reply.status(304).send();
      }

      return {
        articles: items,
        count: items.length,
        updatedAt: latestUpdatedAt(items),
        etag,
      };
    },
  );

  app.get<{ Params: ArticleSlugParams }>(
    "/articles/:slug",
    {
      schema: {
        params: {
          type: "object",
          required: ["slug"],
          properties: {
            slug: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      return sendPublicArticle(
        request.params.slug,
        options.articleService,
        request,
        reply,
      );
    },
  );

  app.get<{ Params: WildcardArticleSlugParams }>(
    "/articles/*",
    async (request, reply) => {
      return sendPublicArticle(
        request.params["*"],
        options.articleService,
        request,
        reply,
      );
    },
  );
}

async function sendPublicArticle(
  slug: string,
  articleService: ArticleService,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const article = await articleService.getPublicArticleBySlug(slug);
  if (!article) {
    return reply.status(404).send({ error: "Article not found" });
  }

  const payload = toPublicArticleDetail(article);
  setPublicCacheHeaders(reply, payload.etag);
  if (isNotModified(request, payload.etag)) {
    return reply.status(304).send();
  }

  return payload;
}

function parseLimit(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toPublicArticleSummary(
  article: ArticleWithContent,
): PublicArticleSummary {
  return {
    slug: article.slug,
    title: scrubLocalPaths(article.title),
    description: article.description
      ? scrubLocalPaths(article.description)
      : null,
    status: "PUBLISHED",
    publishedAt: article.publishedAt?.toISOString() ?? null,
    updatedAt: article.updatedAt.toISOString(),
    etag: articleEtag(article),
    toc: currentRevisionBlocks(article).filter(isHeadingBlock).map(toTocItem),
    assets: currentRevisionAssets(article).map(toPublicAsset),
  };
}

function toPublicArticleDetail(
  article: ArticleWithContent,
): PublicArticleDetail {
  return {
    ...toPublicArticleSummary(article),
    body: {
      html: sanitizePublicHtml(
        scrubLocalPaths(
          article.renderedHtml ?? article.currentRevision?.renderedHtml ?? "",
        ),
      ),
      blocks: currentRevisionBlocks(article).map((block) => ({
        id: block.id,
        type: block.type,
        sortOrder: block.sortOrder,
        content: scrubJsonValue(block.content),
        plainText: block.plainText ? scrubLocalPaths(block.plainText) : null,
      })),
    },
  };
}

function isHeadingBlock(block: ArticleWithContent["blocks"][number]): boolean {
  return block.type === "HEADING";
}

function currentRevisionBlocks(
  article: ArticleWithContent,
): ArticleWithContent["blocks"] {
  return article.blocks.filter(
    (block) => block.revisionId === article.currentRevisionId,
  );
}

function currentRevisionAssets(
  article: ArticleWithContent,
): ArticleWithContent["assets"] {
  return article.assets.filter(
    (asset) => asset.revisionId === article.currentRevisionId,
  );
}

function toTocItem(block: ArticleWithContent["blocks"][number]): PublicTocItem {
  const content = isRecord(block.content) ? block.content : {};
  const text = readString(content.text) ?? block.plainText ?? "section";
  const depth = readNumber(content.level) ?? 2;
  const id = readString(content.id) ?? slugifyForToc(text);

  return {
    id: scrubLocalPaths(id),
    depth: Math.min(Math.max(depth, 1), 6),
    text: scrubLocalPaths(text),
  };
}

function toPublicAsset(
  asset: ArticleWithContent["assets"][number],
): PublicArticleAsset {
  return {
    kind: asset.kind,
    url: scrubAssetUrl(asset.url),
    altText: asset.altText ? scrubLocalPaths(asset.altText) : null,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
  };
}

function articleEtag(article: ArticleWithContent): string {
  return makeEtag({
    slug: article.slug,
    updatedAt: article.updatedAt.toISOString(),
    currentRevisionId: article.currentRevisionId,
  });
}

function makeEtag(value: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 24);
  return `"${digest}"`;
}

function setPublicCacheHeaders(reply: FastifyReply, etag: string): void {
  reply.header("Cache-Control", publicCacheControl);
  reply.header("ETag", etag);
}

function isNotModified(request: FastifyRequest, etag: string): boolean {
  return request.headers["if-none-match"] === etag;
}

function latestUpdatedAt(items: PublicArticleSummary[]): string | null {
  return items.reduce<string | null>((latest, item) => {
    if (!latest || item.updatedAt > latest) {
      return item.updatedAt;
    }
    return latest;
  }, null);
}

function scrubAssetUrl(url: string): string {
  const scrubbed = scrubLocalPaths(url);
  if (
    scrubbed === "[local-path-redacted]" ||
    /^(?:file:|\.\.?\/|\/Users\/|\/tmp\/|\/var\/folders\/)/.test(scrubbed)
  ) {
    return "#redacted-local-asset";
  }
  return scrubbed;
}

function scrubJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubLocalPaths(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "storageKey")
        .map(([key, entry]) => [key, scrubJsonValue(entry)]),
    );
  }
  return value;
}

function scrubLocalPaths(value: string): string {
  return value.replace(
    /(?:file:\/\/)?(?:\/Users\/[^\s"'<>)]*|\/tmp\/[^\s"'<>)]*|\/var\/folders\/[^\s"'<>)]*)/g,
    "[local-path-redacted]",
  );
}

function sanitizePublicHtml(value: string): string {
  return value
    .replace(
      /<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      "",
    )
    .replace(
      /<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi,
      "",
    )
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s+(href|src)\s*=\s*("|')\s*javascript:[\s\S]*?\2/gi,
      ' $1="#removed-javascript-url"',
    )
    .replace(
      /\s+(href|src)\s*=\s*javascript:[^\s>]+/gi,
      ' $1="#removed-javascript-url"',
    );
}

function slugifyForToc(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9가-힣_-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
