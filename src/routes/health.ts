import type { FastifyInstance } from "fastify";

import type { PythonWorkerGateway } from "../app.js";

interface HealthRouteOptions {
  pythonWorkerClient?: PythonWorkerGateway;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions = {},
): void {
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

  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["health"],
        summary:
          "Report backend readiness and internal worker dependency state.",
        response: {
          200: {
            type: "object",
            required: ["status", "service", "dependencies"],
            properties: readinessResponseSchemaProperties,
          },
          503: {
            type: "object",
            required: ["status", "service", "dependencies"],
            properties: readinessResponseSchemaProperties,
          },
        },
      },
    },
    async (_request, reply) => {
      if (!options.pythonWorkerClient) {
        return {
          status: "ok" as const,
          service: "seojing-backend",
          dependencies: {
            pythonWorker: {
              status: "not_configured" as const,
              required: false,
            },
          },
        };
      }

      try {
        const workerHealth = await options.pythonWorkerClient.health();
        return {
          status: workerHealth.status,
          service: "seojing-backend",
          dependencies: {
            pythonWorker: {
              status: workerHealth.status,
              required: true,
              capabilities: workerHealth.capabilities,
            },
          },
        };
      } catch (error) {
        app.log.warn({ error }, "Python worker readiness check failed");
        reply.code(503);
        return {
          status: "degraded" as const,
          service: "seojing-backend",
          dependencies: {
            pythonWorker: {
              status: "unavailable" as const,
              required: true,
            },
          },
        };
      }
    },
  );
}

const readinessResponseSchemaProperties = {
  status: { type: "string", enum: ["ok", "degraded"] },
  service: { type: "string" },
  dependencies: {
    type: "object",
    required: ["pythonWorker"],
    properties: {
      pythonWorker: {
        type: "object",
        required: ["status", "required"],
        properties: {
          status: {
            type: "string",
            enum: ["ok", "degraded", "not_configured", "unavailable"],
          },
          required: { type: "boolean" },
          capabilities: {
            type: "array",
            items: { type: "string", enum: ["tts", "qa", "rag"] },
          },
        },
      },
    },
  },
};
