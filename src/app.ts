import { PrismaClient } from "@prisma/client";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import { ArticleRepository } from "./repositories/articles.js";
import { registerArticleRoutes } from "./routes/articles.js";
import { registerHealthRoutes } from "./routes/health.js";
import { ArticleService } from "./services/articles.js";

export interface BuildAppOptions {
  logger?: boolean;
  corsOrigins?: string[];
  articleService?: ArticleService;
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
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  registerHealthRoutes(app);

  const prisma = options.articleService ? undefined : new PrismaClient();
  const articleService = options.articleService ?? createArticleService(prisma);
  registerArticleRoutes(app, { articleService });

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
