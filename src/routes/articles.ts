import { createHash } from "node:crypto";
import { parseFragment } from "parse5";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ArticleWithContent } from "../repositories/articles.js";
import type { ArticleService } from "../services/articles.js";

const publicCacheControl = "no-store";

interface RegisterArticleRoutesOptions {
  articleService: ArticleService;
}

interface ArticleListQuery {
  limit?: string | number;
  category?: string;
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
  category: string;
  tags: string[];
  cover: { src: string; alt: string; caption?: string; kind?: string } | null;
  displayDate: string | null;
  displayUpdatedAt: string | null;
  summaryVideo: unknown;
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
    document: unknown;
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
            category: { type: "string", minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      const limit = parseLimit(request.query.limit);
      const articles = await options.articleService.listPublicArticles(
        limit,
        request.query.category,
      );
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
    category: scrubLocalPaths(article.category),
    tags: article.tags.map(scrubLocalPaths),
    cover: publicCover(article.cover),
    displayDate: article.displayDate?.toISOString() ?? null,
    displayUpdatedAt: article.displayUpdatedAt?.toISOString() ?? null,
    summaryVideo: publicSummaryVideo(article.summaryVideo),
    status: "PUBLISHED",
    publishedAt: article.publishedAt?.toISOString() ?? null,
    updatedAt: article.updatedAt.toISOString(),
    etag: articleEtag(article),
    toc: currentRevisionBlocks(article).filter(isHeadingBlock).map(toTocItem),
    assets: currentRevisionAssets(article).map(toPublicAsset),
  };
}

export function toPublicArticleDetail(
  article: ArticleWithContent,
): PublicArticleDetail {
  return {
    ...toPublicArticleSummary(article),
    body: {
      document:
        article.currentRevision?.sourceFormat === "DOCUMENT"
          ? article.currentRevision.document
          : null,
      html: sanitizePublicHtml(
        scrubLocalPaths(
          article.renderedHtml ?? article.currentRevision?.renderedHtml ?? "",
        ),
      ),
      blocks: currentRevisionBlocks(article).map((block) => ({
        id: block.id,
        type: block.type,
        sortOrder: block.sortOrder,
        content: scrubPublicBlockContent(block.content),
        plainText: block.plainText ? scrubLocalPaths(block.plainText) : null,
      })),
    },
  };
}

function publicCover(
  value: unknown,
): { src: string; alt: string; caption?: string; kind?: string } | null {
  if (
    !isRecord(value) ||
    typeof value.src !== "string" ||
    typeof value.alt !== "string"
  )
    return null;
  return {
    src: scrubAssetUrl(value.src),
    alt: scrubLocalPaths(value.alt),
    ...(typeof value.caption === "string"
      ? { caption: scrubLocalPaths(value.caption) }
      : {}),
    ...(typeof value.kind === "string"
      ? { kind: scrubLocalPaths(value.kind) }
      : {}),
  };
}

function publicSummaryVideo(value: unknown): unknown {
  if (!isRecord(value) || typeof value.src !== "string") return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, entry]) =>
          [
            "src",
            "title",
            "caption",
            "poster",
            "subtitles",
            "provider",
          ].includes(key) && typeof entry === "string",
      )
      .map(([key, entry]) => [
        key,
        ["src", "poster", "subtitles"].includes(key)
          ? scrubAssetUrl(entry as string)
          : scrubLocalPaths(entry as string),
      ]),
  );
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

function scrubPublicBlockContent(value: unknown): unknown {
  const visit = (entry: unknown, key = ""): unknown => {
    if (typeof entry === "string") {
      return /html$/i.test(key)
        ? sanitizeInlineHtml(scrubLocalPaths(entry))
        : scrubLocalPaths(entry);
    }
    if (Array.isArray(entry)) return entry.map((item) => visit(item, key));
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.entries(entry)
          .filter(([childKey]) => childKey !== "storageKey")
          .map(([childKey, item]) => [childKey, visit(item, childKey)]),
      );
    }
    return entry;
  };
  return visit(value);
}

function sanitizeInlineHtml(value: string): string {
  const allowed = new Set([
    "strong",
    "em",
    "code",
    "del",
    "span",
    "br",
    "a",
    "p",
    "ul",
    "ol",
    "li",
    "pre",
  ]);
  const fragment = parseFragment(value);
  const visit = (node: (typeof fragment.childNodes)[number]): string => {
    if (node.nodeName === "#text")
      return escapeInlineText("value" in node ? String(node.value) : "");
    if (node.nodeName === "#comment") return "";
    const element = node as typeof node & {
      tagName?: string;
      attrs?: Array<{ name: string; value: string }>;
      childNodes?: typeof fragment.childNodes;
    };
    const tag = element.tagName;
    if (!tag || !allowed.has(tag))
      return (element.childNodes ?? []).map(visit).join("");
    const children = (element.childNodes ?? []).map(visit).join("");
    if (tag === "br") return "<br />";
    if (tag === "a") {
      const href =
        element.attrs?.find((attr) => attr.name === "href")?.value ?? "";
      return /^(https?:\/\/[^\s]+|\/(?!\/)[^\s]*|#[^\s]+)$/i.test(href)
        ? `<a href="${escapeInlineText(href)}">${children}</a>`
        : children;
    }
    if (tag === "span") {
      const style =
        element.attrs?.find((attr) => attr.name === "style")?.value ?? "";
      return /^(?:(?:color:#[0-9a-f]{3,8}|color:rgb\([\d,\s]+\)|font-size:\d{1,2}px|font-family:(?:sans-serif|serif|monospace))(?:;|$))+$/i.test(
        style,
      )
        ? `<span style="${escapeInlineText(style)}">${children}</span>`
        : children;
    }
    if (tag === "ol") {
      const start = Number(
        element.attrs?.find((attr) => attr.name === "start")?.value,
      );
      return Number.isInteger(start) && start > 1 && start < 1_000_000
        ? `<ol start="${start}">${children}</ol>`
        : `<ol>${children}</ol>`;
    }
    return `<${tag}>${children}</${tag}>`;
  };
  return fragment.childNodes.map(visit).join("");
}

function escapeInlineText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
