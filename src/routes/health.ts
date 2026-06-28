import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Report process health.",
        response: {
          200: {
            type: "object",
            required: ["status", "service"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              service: { type: "string" },
            },
          },
        },
      },
    },
    () => ({ status: "ok" as const, service: "seojing-backend" }),
  );
}
