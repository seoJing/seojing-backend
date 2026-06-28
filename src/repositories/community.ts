import type {
  Article,
  ArticleComment,
  CommentKind,
  CommentStatus,
  Prisma,
  User,
} from "@prisma/client";

export interface GitHubUserIdentity {
  githubId: string;
  githubLogin: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl?: string;
}

export interface CreateCommentInput {
  articleSlug: string;
  authorId: string;
  body: string;
  kind: CommentKind;
  status: CommentStatus;
  sectionId?: string;
  parentId?: string;
  moderationReason?: string;
}

export interface ListCommentsInput {
  articleSlug: string;
  kind?: CommentKind;
  sectionId?: string;
  includePending?: boolean;
}

export interface UpdateCommentStatusInput {
  id: string;
  status: CommentStatus;
  moderationReason?: string;
}

export type PublicCommentRecord = ArticleComment & {
  author: Pick<
    User,
    "id" | "githubLogin" | "displayName" | "avatarUrl" | "profileUrl"
  >;
  replies: Array<
    ArticleComment & {
      author: Pick<
        User,
        "id" | "githubLogin" | "displayName" | "avatarUrl" | "profileUrl"
      >;
    }
  >;
};

export type CreatedCommentRecord = ArticleComment & {
  author: Pick<
    User,
    "id" | "githubLogin" | "displayName" | "avatarUrl" | "profileUrl"
  >;
  article: Pick<Article, "slug" | "title">;
};

type CommunityRepositoryDb = Pick<
  Prisma.TransactionClient,
  "article" | "articleComment" | "user"
>;

const publicAuthorSelect = {
  id: true,
  githubLogin: true,
  displayName: true,
  avatarUrl: true,
  profileUrl: true,
} satisfies Prisma.UserSelect;

export class CommunityRepository {
  constructor(private readonly db: CommunityRepositoryDb) {}

  async upsertGitHubUser(identity: GitHubUserIdentity): Promise<User> {
    return this.db.user.upsert({
      where: { githubId: identity.githubId },
      create: {
        githubId: identity.githubId,
        githubLogin: identity.githubLogin,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        profileUrl: identity.profileUrl,
      },
      update: {
        githubLogin: identity.githubLogin,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        profileUrl: identity.profileUrl,
        lastAuthenticatedAt: new Date(),
      },
    });
  }

  async findUserById(id: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { id } });
  }

  async listVisibleComments(
    input: ListCommentsInput,
  ): Promise<PublicCommentRecord[]> {
    const article = await this.db.article.findFirst({
      where: { slug: input.articleSlug, status: "PUBLISHED" },
      select: { id: true },
    });
    if (!article) {
      return [];
    }

    return this.db.articleComment.findMany({
      where: {
        articleId: article.id,
        parentId: null,
        status: input.includePending ? undefined : "VISIBLE",
        kind: input.kind,
        sectionId: input.sectionId,
      },
      orderBy: { createdAt: "asc" },
      include: {
        author: { select: publicAuthorSelect },
        replies: {
          where: { status: input.includePending ? undefined : "VISIBLE" },
          orderBy: { createdAt: "asc" },
          include: { author: { select: publicAuthorSelect } },
        },
      },
    });
  }

  async createComment(
    input: CreateCommentInput,
  ): Promise<CreatedCommentRecord | null> {
    const article = await this.db.article.findFirst({
      where: { slug: input.articleSlug, status: "PUBLISHED" },
      select: { id: true },
    });
    if (!article) {
      return null;
    }

    if (input.parentId) {
      const parent = await this.db.articleComment.findFirst({
        where: { id: input.parentId, articleId: article.id },
        select: { id: true },
      });
      if (!parent) {
        throw new Error("Parent comment not found for this article.");
      }
    }

    return this.db.articleComment.create({
      data: {
        articleId: article.id,
        authorId: input.authorId,
        parentId: input.parentId,
        kind: input.kind,
        status: input.status,
        sectionId: input.sectionId,
        body: input.body,
        moderationReason: input.moderationReason,
      },
      include: {
        article: { select: { slug: true, title: true } },
        author: { select: publicAuthorSelect },
      },
    });
  }

  async updateCommentStatus(
    input: UpdateCommentStatusInput,
  ): Promise<CreatedCommentRecord | null> {
    const existing = await this.db.articleComment.findUnique({
      where: { id: input.id },
      select: { id: true },
    });
    if (!existing) {
      return null;
    }

    return this.db.articleComment.update({
      where: { id: input.id },
      data: {
        status: input.status,
        moderationReason: input.moderationReason,
      },
      include: {
        article: { select: { slug: true, title: true } },
        author: { select: publicAuthorSelect },
      },
    });
  }
}
