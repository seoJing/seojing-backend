import { createHmac, timingSafeEqual } from "node:crypto";

import type { CommentKind, CommentStatus, User } from "@prisma/client";

import type {
  CommunityRepository,
  CreatedCommentRecord,
  GitHubUserIdentity,
  PublicCommentRecord,
} from "../repositories/community.js";

export interface AuthSession {
  token: string;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  githubLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
}

export interface CreateReaderCommentInput {
  articleSlug: string;
  authorToken: string;
  body: string;
  kind?: CommentKind;
  sectionId?: string;
  parentId?: string;
}

export interface ListReaderCommentsInput {
  articleSlug: string;
  kind?: CommentKind;
  sectionId?: string;
}

interface TokenPayload {
  sub: string;
  login: string;
  iat: number;
}

const maxBodyLength = 2000;
const minBodyLength = 3;
const rateLimitWindowMs = 60_000;
const rateLimitMax = 5;
const blockedBodyPattern =
  /(스팸|카지노|도박|바카라|무료\s*머니|viagra|casino|porn)/i;

export class CommunityService {
  private readonly rateLimitBuckets = new Map<string, number[]>();

  constructor(
    private readonly repository: CommunityRepository,
    private readonly sessionSecret: string,
  ) {}

  async createSession(identity: GitHubUserIdentity): Promise<AuthSession> {
    const user = await this.repository.upsertGitHubUser(identity);
    return {
      token: this.signUserToken(user),
      user: toPublicUser(user),
    };
  }

  async getUserFromToken(token: string): Promise<User | null> {
    const payload = this.verifyUserToken(token);
    if (!payload) {
      return null;
    }
    return this.repository.findUserById(payload.sub);
  }

  async listComments(
    input: ListReaderCommentsInput,
  ): Promise<PublicCommentRecord[]> {
    return this.repository.listVisibleComments({
      articleSlug: normalizeArticleSlug(input.articleSlug),
      kind: input.kind,
      sectionId: normalizeOptionalText(input.sectionId, 120),
    });
  }

  async createComment(
    input: CreateReaderCommentInput,
  ): Promise<CreatedCommentRecord | null> {
    const user = await this.getUserFromToken(input.authorToken);
    if (!user) {
      throw new Error("Valid GitHub reader session is required.");
    }

    enforceRateLimit(this.rateLimitBuckets, user.id);
    const body = normalizeCommentBody(input.body);
    const moderation = moderateBody(body);

    return this.repository.createComment({
      articleSlug: normalizeArticleSlug(input.articleSlug),
      authorId: user.id,
      body,
      kind: input.kind ?? "COMMENT",
      status: moderation.status,
      sectionId: normalizeOptionalText(input.sectionId, 120),
      parentId: normalizeOptionalText(input.parentId, 80),
      moderationReason: moderation.reason,
    });
  }

  async updateCommentStatus(
    id: string,
    status: CommentStatus,
    moderationReason?: string,
  ): Promise<CreatedCommentRecord | null> {
    return this.repository.updateCommentStatus({
      id,
      status,
      moderationReason: normalizeOptionalText(moderationReason, 280),
    });
  }

  private signUserToken(user: User): string {
    const payload: TokenPayload = {
      sub: user.id,
      login: user.githubLogin,
      iat: Math.floor(Date.now() / 1000),
    };
    const encodedPayload = base64url(JSON.stringify(payload));
    const signature = signPayload(encodedPayload, this.sessionSecret);
    return `${encodedPayload}.${signature}`;
  }

  private verifyUserToken(token: string): TokenPayload | null {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return null;
    }
    const expected = signPayload(encodedPayload, this.sessionSecret);
    if (!safeEqual(signature, expected)) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8"),
      ) as Partial<TokenPayload>;
      if (typeof parsed.sub !== "string" || typeof parsed.login !== "string") {
        return null;
      }
      return {
        sub: parsed.sub,
        login: parsed.login,
        iat: typeof parsed.iat === "number" ? parsed.iat : 0,
      };
    } catch {
      return null;
    }
  }
}

type PublicUserLike = Pick<
  User,
  "id" | "githubLogin" | "displayName" | "avatarUrl" | "profileUrl"
>;

type PublicCommentLike = {
  id: string;
  kind: CommentKind;
  status: CommentStatus;
  sectionId: string | null;
  parentId: string | null;
  body: string;
  moderationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  author: PublicUserLike;
  article?: { slug: string };
  replies?: PublicCommentLike[];
};

export interface PublicCommentPayload {
  id: string;
  articleSlug?: string;
  kind: CommentKind;
  status: CommentStatus;
  sectionId: string | null;
  parentId: string | null;
  body: string;
  moderationReason: string | null;
  createdAt: string;
  updatedAt: string;
  author: PublicUser;
  replies?: PublicCommentPayload[];
}

export function toPublicUser(user: PublicUserLike): PublicUser {
  return {
    id: user.id,
    githubLogin: user.githubLogin,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profileUrl: user.profileUrl,
  };
}

export function toPublicComment(
  comment: PublicCommentLike,
): PublicCommentPayload {
  return {
    id: comment.id,
    articleSlug: comment.article?.slug,
    kind: comment.kind,
    status: comment.status,
    sectionId: comment.sectionId,
    parentId: comment.parentId,
    body: comment.body,
    moderationReason: comment.moderationReason,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    author: toPublicUser(comment.author),
    replies: comment.replies?.map(toPublicComment),
  };
}

function normalizeArticleSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "");
}

function normalizeCommentBody(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (normalized.length < minBodyLength) {
    throw new Error("Comment body is too short.");
  }
  if (normalized.length > maxBodyLength) {
    throw new Error("Comment body is too long.");
  }
  return normalized;
}

function normalizeOptionalText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}

function moderateBody(body: string): {
  status: CommentStatus;
  reason?: string;
} {
  if (blockedBodyPattern.test(body)) {
    return { status: "HIDDEN", reason: "blocked-keyword" };
  }
  return { status: "PENDING", reason: "awaiting-review" };
}

function enforceRateLimit(buckets: Map<string, number[]>, key: string): void {
  const now = Date.now();
  const windowStart = now - rateLimitWindowMs;
  const bucket = (buckets.get(key) ?? []).filter(
    (entry) => entry > windowStart,
  );
  if (bucket.length >= rateLimitMax) {
    throw new Error("Comment rate limit exceeded.");
  }
  bucket.push(now);
  buckets.set(key, bucket);
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
