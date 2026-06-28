import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import { registerHealthRoutes } from "./routes/health.js";

export interface BuildAppOptions {
  logger?: boolean;
  corsOrigins?: string[];
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
