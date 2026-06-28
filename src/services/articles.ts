import type {
  ArticleBlockType,
  ArticleSourceFormat,
  ArticleStatus,
} from "@prisma/client";

import type {
  ArticleAssetDraft,
  ArticleBlockDraft,
  ArticleRepository,
  ArticleWithContent,
} from "../repositories/articles.js";
import {
  blocksToSourceText,
  normalizeBlockEditorInput,
  normalizeBlockEditorInputs,
  renderArticleBlocks,
  type BlockEditorBlockInput,
} from "./block-renderer.js";

export interface CreateArticleInput {
  slug: string;
  title: string;
  description?: string;
  sourceFormat?: ArticleSourceFormat;
  sourceText: string;
  renderedHtml?: string;
  status?: ArticleStatus;
  changeSummary?: string;
  authorName?: string;
  blocks?: ArticleBlockDraft[];
  assets?: ArticleAssetDraft[];
}

export interface ArticleEditorDraftInput {
  title?: string;
  description?: string;
  sourceText: string;
  renderedHtml?: string;
  changeSummary?: string;
  authorName?: string;
  blocks?: ArticleBlockDraft[];
  assets?: ArticleAssetDraft[];
}

export interface BlockEditorDraftInput {
  slug?: string;
  title?: string;
  description?: string;
  blocks: BlockEditorBlockInput[];
  changeSummary?: string;
  authorName?: string;
}

export interface BlockEditorMutationInput {
  block: BlockEditorBlockInput;
  changeSummary?: string;
  authorName?: string;
}

export interface BlockEditorUpdateInput {
  block: Partial<BlockEditorBlockInput> & { type?: ArticleBlockType };
  changeSummary?: string;
  authorName?: string;
}

export class ArticleService {
  constructor(private readonly repository: ArticleRepository) {}

  async createInitialDraft(
    input: CreateArticleInput,
  ): Promise<ArticleWithContent> {
    const slug = normalizeSlug(input.slug);
    if (!slug) {
      throw new Error("Article slug is required.");
    }

    if (!input.title.trim()) {
      throw new Error("Article title is required.");
    }

    if (!input.sourceText.trim()) {
      throw new Error("Article sourceText is required.");
    }

    const existing = await this.repository.findBySlug(slug);
    if (existing) {
      throw new Error(`Article slug already exists: ${slug}`);
    }

    return this.repository.createDraft({
      ...input,
      slug,
      title: input.title.trim(),
      description: input.description?.trim(),
      sourceFormat: input.sourceFormat ?? "MDX",
      status: input.status ?? "DRAFT",
      blocks: input.blocks ?? deriveBlocksFromSource(input.sourceText),
    });
  }

  async getArticleBySlug(slug: string): Promise<ArticleWithContent | null> {
    return this.repository.findBySlug(normalizeSlug(slug));
  }

  async getPublicArticleBySlug(
    slug: string,
  ): Promise<ArticleWithContent | null> {
    return this.repository.findPublishedBySlug(normalizeSlug(slug));
  }

  async listPublicArticles(limit?: number): Promise<ArticleWithContent[]> {
    return this.repository.listPublished(limit);
  }

  async createEditorRevision(
    slug: string,
    input: ArticleEditorDraftInput,
  ): Promise<ArticleWithContent | null> {
    const normalizedSlug = normalizeSlug(slug);
    if (!normalizedSlug) {
      throw new Error("Article slug is required.");
    }
    if (!input.sourceText.trim()) {
      throw new Error("Article sourceText is required.");
    }

    return this.repository.createEditorRevision({
      ...input,
      slug: normalizedSlug,
      title: input.title?.trim(),
      description: input.description?.trim(),
      sourceFormat: "MDX",
      blocks: input.blocks ?? deriveBlocksFromSource(input.sourceText),
    });
  }

  async createBlockDraft(
    input: BlockEditorDraftInput,
  ): Promise<ArticleWithContent> {
    const blocks = normalizeBlockEditorInputs(input.blocks);
    const sourceText = blocksToSourceText(blocks);
    return this.createInitialDraft({
      slug: input.slug ?? "",
      title: input.title ?? "",
      description: input.description,
      sourceFormat: "BLOCKS",
      sourceText,
      renderedHtml: renderArticleBlocks(blocks),
      changeSummary: input.changeSummary ?? "Block editor draft",
      authorName: input.authorName,
      blocks,
    });
  }

  async replaceArticleBlocks(
    slug: string,
    input: BlockEditorDraftInput,
  ): Promise<ArticleWithContent | null> {
    const normalizedSlug = normalizeSlug(slug);
    const blocks = normalizeBlockEditorInputs(input.blocks);
    return this.createBlockRevision(normalizedSlug, input, blocks);
  }

  async appendArticleBlock(
    slug: string,
    input: BlockEditorMutationInput,
  ): Promise<ArticleWithContent | null> {
    const article = await this.getArticleBySlug(slug);
    if (!article) {
      return null;
    }
    const currentBlocks = currentArticleBlockDrafts(article);
    const blocks = [
      ...currentBlocks,
      normalizeBlockEditorInput(input.block, currentBlocks.length),
    ];
    return this.createBlockRevision(normalizeSlug(slug), input, blocks);
  }

  async updateArticleBlock(
    slug: string,
    blockId: string,
    input: BlockEditorUpdateInput,
  ): Promise<ArticleWithContent | null> {
    const article = await this.getArticleBySlug(slug);
    if (!article) {
      return null;
    }
    const currentBlocks = currentArticleBlockInputs(article);
    const index = currentBlocks.findIndex((block) => block.id === blockId);
    if (index === -1) {
      throw new Error(`Article block not found: ${blockId}`);
    }
    const previous = currentBlocks[index];
    if (!previous) {
      throw new Error(`Article block not found: ${blockId}`);
    }
    currentBlocks[index] = {
      id: previous.id,
      type: input.block.type ?? previous.type,
      content: {
        ...previous.content,
        ...(input.block.content ?? {}),
      },
      metadata: input.block.metadata ?? previous.metadata,
    };
    const blocks = normalizeBlockEditorInputs(currentBlocks);
    return this.createBlockRevision(normalizeSlug(slug), input, blocks);
  }

  async deleteArticleBlock(
    slug: string,
    blockId: string,
    input: Omit<BlockEditorMutationInput, "block"> = {},
  ): Promise<ArticleWithContent | null> {
    const article = await this.getArticleBySlug(slug);
    if (!article) {
      return null;
    }
    const currentBlocks = currentArticleBlockInputs(article);
    const remaining = currentBlocks.filter((block) => block.id !== blockId);
    if (remaining.length === currentBlocks.length) {
      throw new Error(`Article block not found: ${blockId}`);
    }
    const blocks = normalizeBlockEditorInputs(remaining);
    return this.createBlockRevision(normalizeSlug(slug), input, blocks);
  }

  async publishCurrentRevision(
    slug: string,
  ): Promise<ArticleWithContent | null> {
    return this.repository.publishLatestRevision(normalizeSlug(slug));
  }

  private async createBlockRevision(
    slug: string,
    input: Pick<
      BlockEditorDraftInput,
      "title" | "description" | "changeSummary" | "authorName"
    >,
    blocks: ArticleBlockDraft[],
  ): Promise<ArticleWithContent | null> {
    if (!slug) {
      throw new Error("Article slug is required.");
    }
    const sourceText = blocksToSourceText(blocks);
    return this.repository.createEditorRevision({
      slug,
      title: input.title?.trim(),
      description: input.description?.trim(),
      sourceFormat: "BLOCKS",
      sourceText,
      renderedHtml: renderArticleBlocks(blocks),
      changeSummary: input.changeSummary ?? "Block editor revision",
      authorName: input.authorName,
      blocks,
    });
  }
}

export function normalizeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/")
    .replace(/[^a-z0-9가-힣/_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-\//g, "/")
    .replace(/\/-/g, "/")
    .replace(/^[-/]+|[-/]+$/g, "");
}

function deriveBlocksFromSource(sourceText: string): ArticleBlockDraft[] {
  const lines = sourceText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("---"));

  const firstHeading = lines.find((line) => line.startsWith("# "));
  const firstParagraph = lines.find((line) => !line.startsWith("#"));
  const blocks: ArticleBlockDraft[] = [];

  if (firstHeading) {
    blocks.push({
      type: "HEADING",
      sortOrder: blocks.length,
      content: { level: 1, text: firstHeading.replace(/^#\s+/, "") },
      plainText: firstHeading.replace(/^#\s+/, ""),
    });
  }

  if (firstParagraph) {
    blocks.push({
      type: "PARAGRAPH",
      sortOrder: blocks.length,
      content: { text: firstParagraph },
      plainText: firstParagraph,
    });
  }

  return blocks;
}

function currentArticleBlockDrafts(
  article: ArticleWithContent,
): ArticleBlockDraft[] {
  return currentArticleBlockInputs(article).map((block, sortOrder) =>
    normalizeBlockEditorInput(block, sortOrder),
  );
}

function currentArticleBlockInputs(
  article: ArticleWithContent,
): Array<BlockEditorBlockInput & { id: string }> {
  return article.blocks
    .filter((block) => block.revisionId === article.currentRevisionId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((block) => ({
      id: block.id,
      type: block.type,
      content: isRecord(block.content)
        ? (block.content as Record<string, unknown>)
        : {},
      metadata: isRecord(block.metadata)
        ? (block.metadata as Record<string, unknown>)
        : undefined,
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
