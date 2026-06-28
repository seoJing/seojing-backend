import type { ArticleSourceFormat, ArticleStatus } from "@prisma/client";

import type {
  ArticleAssetDraft,
  ArticleBlockDraft,
  ArticleRepository,
  ArticleWithContent,
} from "../repositories/articles.js";

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
