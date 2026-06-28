import type { CommentKind, CommentStatus } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { GitHubOAuthService } from "../services/github-oauth.js";
import {
  toPublicComment,
  type CommunityService,
} from "../services/community.js";

interface RegisterCommunityRoutesOptions {
  communityService: CommunityService;
  githubOAuthService?: GitHubOAuthService;
  adminToken?: string;
}

interface AuthStartQuery {
  state?: string;
  redirectUri?: string;
}

interface AuthCallbackBody {
  code?: string;
  redirectUri?: string;
}

interface ArticleSlugParams {
  slug: string;
}

interface CommentListQuery {
  kind?: string;
  sectionId?: string;
}

interface CreateCommentBody {
  body?: string;
  kind?: string;
  sectionId?: string;
  parentId?: string;
}

interface CommentStatusParams {
  id: string;
}

interface UpdateCommentStatusBody {
  status?: string;
  moderationReason?: string;
}

export function registerCommunityRoutes(
  app: FastifyInstance,
  options: RegisterCommunityRoutesOptions,
): void {
  app.get<{ Querystring: AuthStartQuery }>(
    "/auth/github/start",
    async (request, reply) => {
      if (!options.githubOAuthService) {
        return reply
          .status(503)
          .send({ error: "GitHub OAuth is not configured" });
      }
      return {
        authorizationUrl: options.githubOAuthService.authorizationUrl(
          request.query.state,
          request.query.redirectUri,
        ),
      };
    },
  );

  app.post<{ Body: AuthCallbackBody }>(
    "/auth/github/callback",
    async (request, reply) => {
      if (!options.githubOAuthService) {
        return reply
          .status(503)
          .send({ error: "GitHub OAuth is not configured" });
      }
      if (!request.body.code) {
        return reply.status(400).send({ error: "code is required" });
      }
      const session = await options.githubOAuthService.exchangeCode({
        code: request.body.code,
        redirectUri: request.body.redirectUri,
      });
      return session;
    },
  );

  app.get<{ Params: ArticleSlugParams; Querystring: CommentListQuery }>(
    "/articles/:slug/comments",
    async (request) => {
      const comments = await options.communityService.listComments({
        articleSlug: request.params.slug,
        kind: parseCommentKind(request.query.kind),
        sectionId: request.query.sectionId,
      });
      return {
        comments: comments.map(toPublicComment),
        count: comments.length,
      };
    },
  );

  app.post<{ Params: ArticleSlugParams; Body: CreateCommentBody }>(
    "/articles/:slug/comments",
    async (request, reply) => {
      const token = bearerToken(request);
      if (!token) {
        return reply
          .status(401)
          .send({ error: "GitHub reader session required" });
      }
      if (!request.body.body) {
        return reply.status(400).send({ error: "body is required" });
      }

      try {
        const created = await options.communityService.createComment({
          articleSlug: request.params.slug,
          authorToken: token,
          body: request.body.body,
          kind: parseCommentKind(request.body.kind) ?? "COMMENT",
          sectionId: request.body.sectionId,
          parentId: request.body.parentId,
        });
        if (!created) {
          return reply.status(404).send({ error: "Article not found" });
        }
        return reply.status(201).send({ comment: toPublicComment(created) });
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : "Comment rejected",
        });
      }
    },
  );

  app.patch<{ Params: CommentStatusParams; Body: UpdateCommentStatusBody }>(
    "/admin/comments/:id/status",
    async (request, reply) => {
      if (!isAdminRequest(request, options.adminToken)) {
        return reply.status(401).send({ error: "Admin token required" });
      }
      const status = parseCommentStatus(request.body.status);
      if (!status) {
        return reply.status(400).send({ error: "Valid status is required" });
      }
      const updated = await options.communityService.updateCommentStatus(
        request.params.id,
        status,
        request.body.moderationReason,
      );
      if (!updated) {
        return reply.status(404).send({ error: "Comment not found" });
      }
      return { comment: toPublicComment(updated) };
    },
  );
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  return authorization.slice("Bearer ".length).trim();
}

function isAdminRequest(
  request: FastifyRequest,
  adminToken: string | undefined,
): boolean {
  const token = bearerToken(request);
  return Boolean(adminToken && token && token === adminToken);
}

function parseCommentKind(value: string | undefined): CommentKind | undefined {
  if (value === "COMMENT" || value === "QUESTION") {
    return value;
  }
  return undefined;
}

function parseCommentStatus(
  value: string | undefined,
): CommentStatus | undefined {
  if (value === "PENDING" || value === "VISIBLE" || value === "HIDDEN") {
    return value;
  }
  return undefined;
}
