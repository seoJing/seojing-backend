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

export interface CreateArticleRevisionInput {
  slug: string;
  title?: string;
  description?: string;
  sourceFormat: ArticleSourceFormat;
  sourceText: string;
  renderedHtml?: string;
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

const articleContentInclude = {
  currentRevision: true,
  revisions: { orderBy: { revisionNumber: "desc" } },
  blocks: { orderBy: { sortOrder: "asc" } },
  assets: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ArticleInclude;

export class ArticleRepository {
  constructor(private readonly db: ArticleRepositoryDb) {}

  async findBySlug(slug: string): Promise<ArticleWithContent | null> {
    return this.db.article.findUnique({
      where: { slug },
      include: articleContentInclude,
    });
  }

  async findPublishedBySlug(slug: string): Promise<ArticleWithContent | null> {
    return this.db.article.findFirst({
      where: {
        slug,
        status: "PUBLISHED",
      },
      include: articleContentInclude,
    });
  }

  async listPublished(limit = 20): Promise<ArticleWithContent[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);

    return this.db.article.findMany({
      where: {
        status: "PUBLISHED",
      },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      take: safeLimit,
      include: articleContentInclude,
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

      const revision = await this.createRevisionRecord(
        tx,
        article.id,
        1,
        input,
      );
      await this.createRevisionContent(tx, article.id, revision.id, input);

      await tx.article.update({
        where: { id: article.id },
        data: { currentRevisionId: revision.id },
      });

      return this.readCreatedArticle(tx, article.id);
    });
  }

  async createEditorRevision(
    input: CreateArticleRevisionInput,
  ): Promise<ArticleWithContent | null> {
    return this.db.$transaction(async (tx) => {
      const article = await tx.article.findUnique({
        where: { slug: input.slug },
        include: { revisions: { orderBy: { revisionNumber: "desc" } } },
      });
      if (!article) {
        return null;
      }

      const nextRevisionNumber =
        (article.revisions[0]?.revisionNumber ?? 0) + 1;
      const revision = await this.createRevisionRecord(
        tx,
        article.id,
        nextRevisionNumber,
        input,
      );
      await this.createRevisionContent(tx, article.id, revision.id, input);

      await tx.article.update({
        where: { id: article.id },
        data: {
          title: input.title ?? article.title,
          description: input.description,
          sourceFormat: input.sourceFormat,
          sourceText: input.sourceText,
          renderedHtml: input.renderedHtml,
        },
      });

      return this.readCreatedArticle(tx, article.id);
    });
  }

  async publishLatestRevision(
    slug: string,
  ): Promise<ArticleWithContent | null> {
    return this.db.$transaction(async (tx) => {
      const article = await tx.article.findUnique({
        where: { slug },
        include: { revisions: { orderBy: { revisionNumber: "desc" } } },
      });
      const revision = article?.revisions[0];
      if (!article || !revision) {
        return null;
      }

      await tx.article.update({
        where: { id: article.id },
        data: {
          status: "PUBLISHED",
          currentRevisionId: revision.id,
          publishedAt: article.publishedAt ?? new Date(),
          sourceFormat: revision.sourceFormat,
          sourceText: revision.sourceText,
          renderedHtml: revision.renderedHtml,
        },
      });

      return this.readCreatedArticle(tx, article.id);
    });
  }

  private async createRevisionRecord(
    tx: ArticleRepositoryTx,
    articleId: string,
    revisionNumber: number,
    input: Pick<
      CreateArticleDraftInput,
      | "sourceFormat"
      | "sourceText"
      | "renderedHtml"
      | "changeSummary"
      | "authorName"
    >,
  ): Promise<ArticleRevision> {
    return tx.articleRevision.create({
      data: {
        articleId,
        revisionNumber,
        sourceFormat: input.sourceFormat,
        sourceText: input.sourceText,
        renderedHtml: input.renderedHtml,
        changeSummary: input.changeSummary,
        authorName: input.authorName,
      },
    });
  }

  private async createRevisionContent(
    tx: ArticleRepositoryTx,
    articleId: string,
    revisionId: string,
    input: Pick<CreateArticleDraftInput, "blocks" | "assets">,
  ): Promise<void> {
    if (input.blocks?.length) {
      await tx.articleBlock.createMany({
        data: input.blocks.map((block) => ({
          articleId,
          revisionId,
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
          articleId,
          revisionId,
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
  }

  private async readCreatedArticle(
    tx: ArticleRepositoryTx,
    id: string,
  ): Promise<ArticleWithContent> {
    const created = await tx.article.findUnique({
      where: { id },
      include: articleContentInclude,
    });

    if (!created) {
      throw new Error(`Article disappeared during write: ${id}`);
    }

    return created;
  }
}
