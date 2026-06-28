import { PrismaClient } from "@prisma/client";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import { ArticleRepository } from "./repositories/articles.js";
import { CommunityRepository } from "./repositories/community.js";
import { registerAdminWritingRoutes } from "./routes/admin-writing.js";
import { registerArticleRoutes } from "./routes/articles.js";
import { registerCommunityRoutes } from "./routes/community.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTtsRoutes } from "./routes/tts.js";
import { ArticleService } from "./services/articles.js";
import { CommunityService } from "./services/community.js";
import { GitHubOAuthService } from "./services/github-oauth.js";
import { type PythonWorkerClient } from "./services/python-worker.js";
import { TtsService } from "./services/tts.js";

export type PythonWorkerGateway = Pick<PythonWorkerClient, "health"> &
  Partial<Pick<PythonWorkerClient, "invoke">>;

export interface BuildAppOptions {
  logger?: boolean;
  corsOrigins?: string[];
  adminToken?: string;
  articleService?: ArticleService;
  communityService?: CommunityService;
  githubOAuth?: {
    clientId: string;
    clientSecret: string;
    callbackUrl?: string;
  };
  githubOAuthService?: GitHubOAuthService;
  communitySessionSecret?: string;
  pythonWorkerClient?: PythonWorkerGateway;
  ttsAudioRoot?: string;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(helmet);
  await app.register(cors, {
    origin: options.corsOrigins ?? ["https://seojing.com"],
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "SEOJing Backend API",
        description: "Content/community backend contract for SEOJing.",
        version: "0.1.0",
      },
      servers: [{ url: "http://localhost:4000", description: "local" }],
      tags: [
        { name: "health", description: "Runtime health checks" },
        { name: "articles", description: "Future public article API" },
        {
          name: "community",
          description: "GitHub-authenticated comments and questions",
        },
        {
          name: "tts",
          description:
            "Node public TTS API backed by an internal Python worker",
        },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  registerHealthRoutes(app, { pythonWorkerClient: options.pythonWorkerClient });
  registerTtsRoutes(app, {
    ttsService: new TtsService(options.pythonWorkerClient, {
      audioRoot: options.ttsAudioRoot,
    }),
  });

  const prisma =
    options.articleService && options.communityService
      ? undefined
      : new PrismaClient();
  const articleService = options.articleService ?? createArticleService(prisma);
  const communityService =
    options.communityService ?? createCommunityService(prisma, options);
  const githubOAuthService =
    options.githubOAuthService ??
    createGitHubOAuthService(options, communityService);
  registerArticleRoutes(app, { articleService });
  registerAdminWritingRoutes(app, {
    articleService,
    adminToken: options.adminToken,
  });
  registerCommunityRoutes(app, {
    communityService,
    githubOAuthService,
    adminToken: options.adminToken,
  });

  if (prisma) {
    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
  }

  app.get(
    "/openapi.json",
    {
      schema: {
        hide: true,
      },
    },
    () => app.swagger(),
  );

  app.get("/", () => ({
    name: "seojing-backend",
    status: "ok",
    docs: "/docs",
    openapi: "/openapi.json",
  }));

  return app;
}

function createArticleService(
  prisma: PrismaClient | undefined,
): ArticleService {
  if (!prisma) {
    throw new Error(
      "Prisma client is required when articleService is not provided.",
    );
  }
  return new ArticleService(new ArticleRepository(prisma));
}

function createCommunityService(
  prisma: PrismaClient | undefined,
  options: BuildAppOptions,
): CommunityService {
  if (!prisma) {
    throw new Error(
      "Prisma client is required when communityService is not provided.",
    );
  }
  return new CommunityService(
    new CommunityRepository(prisma),
    options.communitySessionSecret ?? "local-dev-community-session-secret",
  );
}

function createGitHubOAuthService(
  options: BuildAppOptions,
  communityService: CommunityService,
): GitHubOAuthService | undefined {
  if (!options.githubOAuth) {
    return undefined;
  }
  return new GitHubOAuthService(options.githubOAuth, communityService);
}
