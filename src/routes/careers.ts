import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { CareerAggregate } from "../repositories/careers.js";
import {
  careerActualStatuses,
  careerEmploymentTypes,
  careerForecastConfidences,
  careerSourceRelationships,
  CareerConflictError,
  type CareerService,
  CareerValidationError,
} from "../services/careers.js";

interface RegisterCareerRoutesOptions {
  careerService: CareerService;
  adminToken?: string;
}

interface CareerListQuery {
  limit?: number;
  company?: string;
  actualStatus?: (typeof careerActualStatuses)[number];
}

interface CareerSlugParams {
  slug: string;
}

const publicCacheControl =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
const publicTags = ["careers"];
const adminTags = ["admin-careers"];
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableDateTime = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
};
const nullableDate = {
  anyOf: [{ type: "string", format: "date" }, { type: "null" }],
};
const slugParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug"],
  properties: {
    slug: { type: "string", minLength: 1, maxLength: 160 },
  },
};
const aggregateBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["company", "opportunity", "sources"],
  properties: {
    company: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "name"],
      properties: {
        slug: { type: "string", minLength: 1, maxLength: 160 },
        name: { type: "string", minLength: 1, maxLength: 240 },
        website: { type: "string", format: "uri", maxLength: 2048 },
        summary: { type: "string", minLength: 1, maxLength: 500 },
        logoUrl: { type: "string", format: "uri", maxLength: 2048 },
      },
    },
    opportunity: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "title", "employmentType", "actualStatus", "summary"],
      properties: {
        slug: { type: "string", minLength: 1, maxLength: 160 },
        title: { type: "string", minLength: 1, maxLength: 240 },
        employmentType: { type: "string", enum: careerEmploymentTypes },
        actualStatus: { type: "string", enum: careerActualStatuses },
        actualStatusAsOf: { type: "string", format: "date-time" },
        location: { type: "string", minLength: 1, maxLength: 500 },
        summary: { type: "string", minLength: 1, maxLength: 1000 },
        description: { type: "string", minLength: 1, maxLength: 20000 },
        applicationUrl: { type: "string", format: "uri", maxLength: 2048 },
      },
    },
    history: {
      type: "array",
      maxItems: 100,
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "actualStatus"],
        properties: {
          key: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
          openedOn: { type: "string", format: "date" },
          closedOn: { type: "string", format: "date" },
          actualStatus: { type: "string", enum: careerActualStatuses },
          note: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    forecast: {
      type: "object",
      additionalProperties: false,
      required: ["predictedStatus", "confidence", "rationale"],
      properties: {
        predictedStatus: { type: "string", enum: careerActualStatuses },
        confidence: { type: "string", enum: careerForecastConfidences },
        windowStart: { type: "string", format: "date" },
        windowEnd: { type: "string", format: "date" },
        rationale: { type: "string", minLength: 1, maxLength: 2000 },
      },
    },
    sources: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "url", "retrievedAt", "relationship"],
        properties: {
          key: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
          label: { type: "string", minLength: 1, maxLength: 240 },
          publisher: { type: "string", minLength: 1, maxLength: 500 },
          url: { type: "string", format: "uri", maxLength: 2048 },
          publishedAt: { type: "string", format: "date-time" },
          retrievedAt: { type: "string", format: "date-time" },
          relationship: { type: "string", enum: careerSourceRelationships },
          historyKey: { type: "string", minLength: 1, maxLength: 120 },
          note: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  },
};

export function registerCareerRoutes(
  app: FastifyInstance,
  options: RegisterCareerRoutesOptions,
): void {
  app.get<{ Querystring: CareerListQuery }>(
    "/career/opportunities",
    {
      schema: {
        tags: publicTags,
        summary: "List published Career Radar opportunities",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50 },
            company: { type: "string", minLength: 1, maxLength: 160 },
            actualStatus: { type: "string", enum: careerActualStatuses },
          },
        },
      },
    },
    async (request, reply) => {
      const aggregates = await options.careerService.listPublic(request.query);
      const items = aggregates.map(toPublicSummary);
      const payload = {
        opportunities: items,
        count: items.length,
        updatedAt: latestUpdatedAt(items),
      };
      return sendCacheable(request, reply, payload);
    },
  );

  app.get<{ Params: CareerSlugParams }>(
    "/career/opportunities/:slug",
    {
      schema: {
        tags: publicTags,
        summary: "Read one published Career Radar opportunity",
        params: slugParamsSchema,
      },
    },
    async (request, reply) => {
      const aggregate = await options.careerService.getPublic(
        request.params.slug,
      );
      if (!aggregate) {
        return reply
          .status(404)
          .send({ error: "Career opportunity not found" });
      }
      return sendCacheable(request, reply, toPublicDetail(aggregate));
    },
  );

  app.post<{ Body: unknown }>(
    "/admin/career/opportunities",
    {
      onRequest: adminGuard(options.adminToken),
      schema: {
        tags: adminTags,
        summary: "Create a private Career Radar aggregate",
        security: [{ bearerAuth: [] }],
        body: aggregateBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const aggregate = await options.careerService.create(request.body);
        reply.header("Cache-Control", "no-store");
        return reply.status(201).send(toAdminDetail(aggregate));
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get<{ Params: CareerSlugParams }>(
    "/admin/career/opportunities/:slug",
    {
      onRequest: adminGuard(options.adminToken),
      schema: {
        tags: adminTags,
        summary: "Read a private or published Career Radar aggregate",
        security: [{ bearerAuth: [] }],
        params: slugParamsSchema,
      },
    },
    async (request, reply) => {
      const aggregate = await options.careerService.getAdmin(
        request.params.slug,
      );
      if (!aggregate) {
        return reply
          .status(404)
          .send({ error: "Career opportunity not found" });
      }
      reply.header("Cache-Control", "no-store");
      return toAdminDetail(aggregate);
    },
  );

  app.put<{ Params: CareerSlugParams; Body: unknown }>(
    "/admin/career/opportunities/:slug",
    {
      onRequest: adminGuard(options.adminToken),
      schema: {
        tags: adminTags,
        summary: "Transactionally replace a Career Radar aggregate",
        security: [{ bearerAuth: [] }],
        params: slugParamsSchema,
        body: aggregateBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const aggregate = await options.careerService.update(
          request.params.slug,
          request.body,
        );
        if (!aggregate) {
          return reply
            .status(404)
            .send({ error: "Career opportunity not found" });
        }
        reply.header("Cache-Control", "no-store");
        return toAdminDetail(aggregate);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{ Params: CareerSlugParams }>(
    "/admin/career/opportunities/:slug/publish",
    {
      onRequest: adminGuard(options.adminToken),
      schema: {
        tags: adminTags,
        summary: "Publish a validated Career Radar aggregate",
        security: [{ bearerAuth: [] }],
        params: slugParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const aggregate = await options.careerService.publish(
          request.params.slug,
        );
        if (!aggregate) {
          return reply
            .status(404)
            .send({ error: "Career opportunity not found" });
        }
        reply.header("Cache-Control", "no-store");
        return toAdminDetail(aggregate);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );
}

function adminGuard(adminToken: string | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : undefined;
    if (!adminToken || !token || !safeEqual(token, adminToken)) {
      return reply.status(401).send({ error: "Unauthorized admin request" });
    }
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function sendDomainError(reply: FastifyReply, error: unknown) {
  if (error instanceof CareerValidationError) {
    return reply
      .status(400)
      .send({ error: error.message, issues: error.issues });
  }
  if (error instanceof CareerConflictError) {
    return reply.status(409).send({ error: error.message });
  }
  throw error;
}

function toPublicSummary(aggregate: CareerAggregate) {
  return {
    slug: aggregate.slug,
    title: aggregate.title,
    employmentType: aggregate.employmentType,
    actualStatus: aggregate.actualStatus,
    actualStatusAsOf: aggregate.actualStatusAsOf?.toISOString() ?? null,
    location: aggregate.location,
    summary: aggregate.summary,
    applicationUrl: aggregate.applicationUrl,
    company: {
      slug: aggregate.company.slug,
      name: aggregate.company.name,
      website: aggregate.company.website,
      summary: aggregate.company.summary,
      logoUrl: aggregate.company.logoUrl,
    },
    forecast: aggregate.forecast
      ? {
          predictedStatus: aggregate.forecast.predictedStatus,
          confidence: aggregate.forecast.confidence,
          windowStart: toDateOnly(aggregate.forecast.windowStart),
          windowEnd: toDateOnly(aggregate.forecast.windowEnd),
          rationale: aggregate.forecast.rationale,
        }
      : null,
    publishedAt: aggregate.publishedAt?.toISOString() ?? null,
    updatedAt: aggregate.updatedAt.toISOString(),
  };
}

function toPublicDetail(aggregate: CareerAggregate) {
  return {
    ...toPublicSummary(aggregate),
    description: aggregate.description,
    recruitmentHistory: aggregate.history.map((entry) => ({
      key: entry.key,
      openedOn: toDateOnly(entry.openedOn),
      closedOn: toDateOnly(entry.closedOn),
      actualStatus: entry.actualStatus,
      note: entry.note,
    })),
    sources: [...aggregate.sourceLinks]
      .sort((left, right) =>
        `${left.relationship}:${left.source.key}`.localeCompare(
          `${right.relationship}:${right.source.key}`,
        ),
      )
      .map((link) => ({
        key: link.source.key,
        label: link.source.label,
        publisher: link.source.publisher,
        url: link.source.url,
        publishedAt: link.source.publishedAt?.toISOString() ?? null,
        retrievedAt: link.source.retrievedAt.toISOString(),
        relationship: link.relationship,
        historyKey: link.recruitmentHistory?.key ?? null,
      })),
  };
}

function toAdminDetail(aggregate: CareerAggregate) {
  const detail = toPublicDetail(aggregate);
  return {
    ...detail,
    visibility: aggregate.visibility,
    createdAt: aggregate.createdAt.toISOString(),
    sources: detail.sources.map((source) => {
      const link = aggregate.sourceLinks.find(
        (candidate) =>
          candidate.source.key === source.key &&
          candidate.relationship === source.relationship &&
          (candidate.recruitmentHistory?.key ?? null) === source.historyKey,
      );
      return { ...source, note: link?.note ?? null };
    }),
  };
}

function sendCacheable(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
) {
  const etag = makeEtag(payload);
  reply.header("Cache-Control", publicCacheControl);
  reply.header("ETag", etag);
  if (matchesEtag(request.headers["if-none-match"], etag)) {
    return reply.status(304).send();
  }
  return reply.send(payload);
}

function makeEtag(value: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 24);
  return `"${digest}"`;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === etag);
}

function latestUpdatedAt(items: Array<{ updatedAt: string }>): string | null {
  return items.reduce<string | null>(
    (latest, item) =>
      !latest || item.updatedAt > latest ? item.updatedAt : latest,
    null,
  );
}

function toDateOnly(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

export const careerOpenApiSchemas = {
  nullableString,
  nullableDateTime,
  nullableDate,
};
