import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { CommunityService } from "../src/services/community.js";
import { GitHubOAuthService } from "../src/services/github-oauth.js";

const baseDate = new Date("2026-06-28T06:00:00.000Z");
const author = {
  id: "user-1",
  githubLogin: "seoJing",
  displayName: "서징",
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  profileUrl: "https://github.com/seoJing",
};

interface CommentApiPayload {
  comments: Array<{
    id: string;
    status: string;
    author: { githubLogin: string };
    replies?: Array<{ id: string }>;
  }>;
  count: number;
}

interface CreatedCommentPayload {
  comment: { status: string };
}

interface OAuthStartPayload {
  authorizationUrl: string;
}

interface OAuthCallbackPayload {
  token: string;
}

function appWithCommunityService(service: Partial<CommunityService>) {
  return buildApp({
    articleService: {} as never,
    communityService: service as CommunityService,
    adminToken: "test-admin-token",
  });
}

describe("community comments/questions API", () => {
  it("exposes only visible threaded comments for a published article section", async () => {
    const listComments = vi.fn().mockResolvedValue([
      {
        id: "comment-1",
        articleId: "article-1",
        authorId: "user-1",
        parentId: null,
        kind: "QUESTION",
        status: "VISIBLE",
        sectionId: "runtime-cache",
        body: "이 캐시 정책은 언제 무효화되나요?",
        moderationReason: null,
        createdAt: baseDate,
        updatedAt: baseDate,
        author,
        replies: [
          {
            id: "comment-2",
            articleId: "article-1",
            authorId: "user-1",
            parentId: "comment-1",
            kind: "COMMENT",
            status: "VISIBLE",
            sectionId: "runtime-cache",
            body: "ETag가 바뀔 때 같이 바뀝니다.",
            moderationReason: null,
            createdAt: baseDate,
            updatedAt: baseDate,
            author,
          },
        ],
      },
    ]);
    const app = await appWithCommunityService({ listComments });

    const response = await app.inject({
      method: "GET",
      url: "/articles/backend-cache/comments?kind=QUESTION§ionId=runtime-cache".replace(
        "§ionId",
        "&sectionId",
      ),
    });

    expect(response.statusCode).toBe(200);
    expect(listComments).toHaveBeenCalledWith({
      articleSlug: "backend-cache",
      kind: "QUESTION",
      sectionId: "runtime-cache",
    });
    const payload = response.json<CommentApiPayload>();
    expect(payload.count).toBe(1);
    expect(payload.comments[0]?.id).toBe("comment-1");
    expect(payload.comments[0]?.status).toBe("VISIBLE");
    expect(payload.comments[0]?.author.githubLogin).toBe("seoJing");
    expect(payload.comments[0]?.replies?.[0]?.id).toBe("comment-2");

    await app.close();
  });

  it("requires a GitHub reader session before creating a pending comment", async () => {
    const createComment = vi.fn().mockResolvedValue({
      id: "comment-3",
      articleId: "article-1",
      article: { slug: "backend-cache", title: "Backend Cache" },
      authorId: "user-1",
      author,
      parentId: null,
      kind: "COMMENT",
      status: "PENDING",
      sectionId: null,
      body: "좋은 글이라 이어서 질문하고 싶어요.",
      moderationReason: "awaiting-review",
      createdAt: baseDate,
      updatedAt: baseDate,
    });
    const app = await appWithCommunityService({ createComment });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/articles/backend-cache/comments",
      payload: { body: "로그인 없이 댓글" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: "/articles/backend-cache/comments",
      headers: { authorization: "Bearer signed-reader-token" },
      payload: { body: "좋은 글이라 이어서 질문하고 싶어요." },
    });

    expect(created.statusCode).toBe(201);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        articleSlug: "backend-cache",
        authorToken: "signed-reader-token",
        kind: "COMMENT",
      }),
    );
    const createdPayload = created.json<CreatedCommentPayload>();
    expect(createdPayload.comment.status).toBe("PENDING");

    await app.close();
  });

  it("lets admin moderation move comments between pending/visible/hidden", async () => {
    const updateCommentStatus = vi.fn().mockResolvedValue({
      id: "comment-3",
      articleId: "article-1",
      article: { slug: "backend-cache", title: "Backend Cache" },
      authorId: "user-1",
      author,
      parentId: null,
      kind: "COMMENT",
      status: "VISIBLE",
      sectionId: null,
      body: "승인된 댓글",
      moderationReason: "manual-approval",
      createdAt: baseDate,
      updatedAt: baseDate,
    });
    const app = await appWithCommunityService({ updateCommentStatus });

    const response = await app.inject({
      method: "PATCH",
      url: "/admin/comments/comment-3/status",
      headers: { authorization: "Bearer test-admin-token" },
      payload: { status: "VISIBLE", moderationReason: "manual-approval" },
    });

    expect(response.statusCode).toBe(200);
    expect(updateCommentStatus).toHaveBeenCalledWith(
      "comment-3",
      "VISIBLE",
      "manual-approval",
    );
    const payload = response.json<CreatedCommentPayload>();
    expect(payload.comment.status).toBe("VISIBLE");

    await app.close();
  });
});

describe("GitHub OAuth API", () => {
  it("builds the GitHub authorization URL and exchanges code into a reader session", async () => {
    const createSession = vi.fn().mockResolvedValue({
      token: "signed-reader-token",
      user: author,
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "github-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 123,
            login: "seoJing",
            name: "서징",
            avatar_url: author.avatarUrl,
            html_url: author.profileUrl,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const oauth = new GitHubOAuthService(
      {
        clientId: "client-id",
        clientSecret: "client-secret",
        callbackUrl: "https://api.seojing.com/auth/github/callback",
      },
      { createSession } as never,
      fetchImpl,
    );
    const app = await buildApp({
      articleService: {} as never,
      communityService: { listComments: vi.fn() } as never,
      githubOAuthService: oauth,
    });

    const start = await app.inject({
      method: "GET",
      url: "/auth/github/start?state=csrf-token",
    });
    expect(start.statusCode).toBe(200);
    const startPayload = start.json<OAuthStartPayload>();
    expect(startPayload.authorizationUrl).toContain("client_id=client-id");
    expect(startPayload.authorizationUrl).toContain("state=csrf-token");

    const callback = await app.inject({
      method: "POST",
      url: "/auth/github/callback",
      payload: { code: "oauth-code" },
    });
    expect(callback.statusCode).toBe(200);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ githubId: "123", githubLogin: "seoJing" }),
    );
    const callbackPayload = callback.json<OAuthCallbackPayload>();
    expect(callbackPayload.token).toBe("signed-reader-token");

    await app.close();
  });
});
