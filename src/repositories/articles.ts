import type {
  Article,
  ArticleAsset,
  ArticleBlock,
  ArticleBlockType,
  ArticleRevision,
  ArticleSourceFormat,
  ArticleStatus,
  Prisma,
} from "@prisma/client";

export interface ArticleBlockDraft {
  type: ArticleBlockType;
  sortOrder: number;
  content: Prisma.InputJsonValue;
  plainText?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface ArticleAssetDraft {
  kind: "COVER" | "INLINE_IMAGE" | "AUDIO" | "VIDEO" | "DOWNLOAD" | "OTHER";
  url: string;
  storageKey?: string;
  altText?: string;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface CreateArticleDraftInput {
  slug: string;
  title: string;
  description?: string;
  sourceFormat: ArticleSourceFormat;
  sourceText: string;
  renderedHtml?: string;
  status?: ArticleStatus;
  changeSummary?: string;
  authorName?: string;
  blocks?: ArticleBlockDraft[];
  assets?: ArticleAssetDraft[];
}

export type ArticleWithContent = Article & {
  currentRevision: ArticleRevision | null;
  revisions: ArticleRevision[];
  blocks: ArticleBlock[];
  assets: ArticleAsset[];
};

type ArticleRepositoryTx = Pick<
  Prisma.TransactionClient,
  "article" | "articleRevision" | "articleBlock" | "articleAsset"
>;

type ArticleRepositoryDb = ArticleRepositoryTx & {
  $transaction<T>(
    fn: (tx: ArticleRepositoryTx) => Promise<T>,
    options?: { timeout?: number },
  ): Promise<T>;
};

export class ArticleRepository {
  constructor(private readonly db: ArticleRepositoryDb) {}

  async findBySlug(slug: string): Promise<ArticleWithContent | null> {
    return this.db.article.findUnique({
      where: { slug },
      include: {
        currentRevision: true,
        revisions: { orderBy: { revisionNumber: "desc" } },
        blocks: { orderBy: { sortOrder: "asc" } },
        assets: { orderBy: { createdAt: "asc" } },
      },
    });
  }

  async createDraft(
    input: CreateArticleDraftInput,
  ): Promise<ArticleWithContent> {
    return this.db.$transaction(async (tx) => {
      const article = await tx.article.create({
        data: {
          slug: input.slug,
          title: input.title,
          description: input.description,
          status: input.status ?? "DRAFT",
          sourceFormat: input.sourceFormat,
          sourceText: input.sourceText,
          renderedHtml: input.renderedHtml,
        },
      });

      const revision = await tx.articleRevision.create({
        data: {
          articleId: article.id,
          revisionNumber: 1,
          sourceFormat: input.sourceFormat,
          sourceText: input.sourceText,
          renderedHtml: input.renderedHtml,
          changeSummary: input.changeSummary,
          authorName: input.authorName,
        },
      });

      if (input.blocks?.length) {
        await tx.articleBlock.createMany({
          data: input.blocks.map((block) => ({
            articleId: article.id,
            revisionId: revision.id,
            type: block.type,
            sortOrder: block.sortOrder,
            content: block.content,
            plainText: block.plainText,
            metadata: block.metadata,
          })),
        });
      }

      if (input.assets?.length) {
        await tx.articleAsset.createMany({
          data: input.assets.map((asset) => ({
            articleId: article.id,
            revisionId: revision.id,
            kind: asset.kind,
            url: asset.url,
            storageKey: asset.storageKey,
            altText: asset.altText,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            width: asset.width,
            height: asset.height,
            metadata: asset.metadata,
          })),
        });
      }

      await tx.article.update({
        where: { id: article.id },
        data: { currentRevisionId: revision.id },
      });

      const created = await tx.article.findUnique({
        where: { id: article.id },
        include: {
          currentRevision: true,
          revisions: { orderBy: { revisionNumber: "desc" } },
          blocks: { orderBy: { sortOrder: "asc" } },
          assets: { orderBy: { createdAt: "asc" } },
        },
      });

      if (!created) {
        throw new Error(`Article disappeared during creation: ${article.id}`);
      }

      return created;
    });
  }
}
