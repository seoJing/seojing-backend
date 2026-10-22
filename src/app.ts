import { PrismaClient } from "@prisma/client";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import { ArticleRepository } from "./repositories/articles.js";
import { registerAdminWritingRoutes } from "./routes/admin-writing.js";
import { registerArticleRoutes } from "./routes/articles.js";
import { registerHealthRoutes } from "./routes/health.js";
import { ArticleService } from "./services/articles.js";
import { type PythonWorkerClient } from "./services/python-worker.js";
import { registerPublicRateLimit } from "./services/public-rate-limit.js";

export type PythonWorkerGateway = Pick<PythonWorkerClient, "health"> &
  Partial<Pick<PythonWorkerClient, "invoke">>;

export interface BuildAppOptions {
  logger?: boolean;
  corsOrigins?: string[];
  adminToken?: string;
  articleService?: ArticleService;
  prisma?: PrismaClient;
  pythonWorkerClient?: PythonWorkerGateway;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(helmet);
  await app.register(cors, {
    origin: options.corsOrigins ?? ["https://seojing.com"],
  });

  const publicRateLimitBuckets = new Map<
    string,
    { count: number; resetAt: number }
  >();
  app.addHook("onRequest", async (request, reply) => {
    if (!registerPublicRateLimit(request, reply, publicRateLimitBuckets)) {
      return reply;
    }
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "SEOJing Backend API",
        description: "Content backend contract for SEOJing.",
        version: "0.1.0",
      },
      servers: [{ url: "http://localhost:4000", description: "local" }],
      tags: [
        { name: "health", description: "Runtime health checks" },
        {
          name: "articles",
          description: "Public article metadata, body, and cache API",
        },
        {
          name: "admin-writing",
          description:
            "Admin-only article draft, revision, block editor, and publish workflow",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  registerHealthRoutes(app, { pythonWorkerClient: options.pythonWorkerClient });
  const needsPrisma = !options.articleService;
  const ownsPrisma = needsPrisma && !options.prisma;
  const prisma = needsPrisma
    ? (options.prisma ?? new PrismaClient())
    : undefined;
  const articleService = options.articleService ?? createArticleService(prisma);
  registerArticleRoutes(app, { articleService });
  registerAdminWritingRoutes(app, {
    articleService,
    adminToken: options.adminToken,
  });

  if (prisma && ownsPrisma) {
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
