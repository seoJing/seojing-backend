import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { CareerAggregate } from "../repositories/careers.js";
import {
  careerEmploymentTypes,
  careerForecastConfidences,
  careerRecruitmentStatuses,
  CareerConflictError,
  type CareerService,
  CareerValidationError,
} from "../services/careers.js";

interface Options {
  careerService: CareerService;
  adminToken?: string;
}
interface Query {
  limit?: number;
  company?: string;
  recruitmentStatus?: (typeof careerRecruitmentStatuses)[number];
}
interface Params {
  slug: string;
}

const cacheControl =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: "null" }],
});
const date = { type: "string", format: "date" };
const dateTime = { type: "string", format: "date-time" };
const sourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "title", "url", "accessedAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    type: { type: "string" },
    title: { type: "string" },
    url: { type: "string", format: "uri" },
    publisher: nullable({ type: "string" }),
    publishedAt: nullable(dateTime),
    accessedAt: dateTime,
  },
};
const sourceInputSchema = {
  ...sourceSchema,
  required: ["type", "title", "url", "accessedAt"],
  properties: {
    ...sourceSchema.properties,
    publisher: nullable({ type: "string" }),
    publishedAt: nullable(dateTime),
  },
};
const companySchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "name"],
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    englishName: nullable({ type: "string" }),
    careersUrl: nullable({ type: "string", format: "uri" }),
  },
};
const publicCompanySchema = {
  ...companySchema,
  properties: {
    ...companySchema.properties,
    englishName: nullable({ type: "string" }),
    careersUrl: nullable({ type: "string", format: "uri" }),
  },
};
const processSchema = {
  type: "object",
  additionalProperties: false,
  required: ["order", "type", "label"],
  properties: {
    order: { type: "integer", minimum: 1 },
    type: { type: "string" },
    label: { type: "string" },
  },
};
const recruitmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "year", "title", "eligibility", "process", "sources"],
  properties: {
    id: { type: "string", format: "uuid" },
    year: { type: "integer" },
    title: { type: "string" },
    openDate: nullable(date),
    closeDate: nullable(date),
    employmentType: nullable({ type: "string", enum: careerEmploymentTypes }),
    eligibility: { type: "array", items: { type: "string" } },
    process: { type: "array", items: processSchema },
    sources: { type: "array", items: sourceSchema },
  },
};
const recruitmentInputSchema = {
  ...recruitmentSchema,
  required: ["year", "title", "sources"],
  properties: {
    ...recruitmentSchema.properties,
    openDate: nullable(date),
    closeDate: nullable(date),
    employmentType: nullable({ type: "string", enum: careerEmploymentTypes }),
    eligibility: { type: "array", default: [], items: { type: "string" } },
    process: { type: "array", default: [], items: processSchema },
    sources: { type: "array", minItems: 1, items: sourceInputSchema },
  },
};
const forecastSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "confidence",
    "reasons",
    "basedOnRecruitmentCount",
    "methodVersion",
    "analyzedAt",
  ],
  properties: {
    expectedOpenFrom: nullable(date),
    expectedOpenTo: nullable(date),
    confidence: { type: "string", enum: careerForecastConfidences },
    reasons: { type: "array", items: { type: "string" } },
    basedOnRecruitmentCount: { type: "integer", minimum: 0 },
    methodVersion: { type: "string" },
    analyzedAt: dateTime,
  },
};
const forecastInputSchema = {
  ...forecastSchema,
  required: [...forecastSchema.required, "sources"],
  properties: {
    ...forecastSchema.properties,
    expectedOpenFrom: nullable(date),
    expectedOpenTo: nullable(date),
    sources: { type: "array", minItems: 1, items: sourceInputSchema },
  },
};
const aggregateInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["company", "opportunity", "statusSources"],
  properties: {
    company: companySchema,
    opportunity: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "title", "role", "category", "recruitmentStatus"],
      properties: {
        slug: { type: "string" },
        title: { type: "string" },
        role: { type: "string" },
        category: { type: "string" },
        recruitmentStatus: { type: "string", enum: careerRecruitmentStatuses },
        actualStatusAsOf: nullable(dateTime),
      },
    },
    forecast: nullable(forecastInputSchema),
    recruitments: {
      type: "array",
      default: [],
      maxItems: 100,
      items: recruitmentInputSchema,
    },
    preparationNotes: {
      type: "array",
      default: [],
      maxItems: 100,
      items: { type: "string" },
    },
    statusSources: { type: "array", minItems: 1, items: sourceInputSchema },
  },
};
const metadataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["visibility", "publishedAt", "createdAt", "updatedAt"],
  properties: {
    visibility: { type: "string", enum: ["DRAFT", "PUBLISHED", "ARCHIVED"] },
    publishedAt: nullable(dateTime),
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};
const adminBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["aggregate"],
  properties: { aggregate: aggregateInputSchema, metadata: metadataSchema },
};
const adminAggregateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "company",
    "opportunity",
    "forecast",
    "recruitments",
    "preparationNotes",
    "statusSources",
  ],
  properties: {
    ...aggregateInputSchema.properties,
    forecast: nullable({
      ...forecastSchema,
      required: [...forecastSchema.required, "sources"],
      properties: {
        ...forecastSchema.properties,
        sources: { type: "array", items: sourceSchema },
      },
    }),
    recruitments: { type: "array", items: recruitmentSchema },
    preparationNotes: { type: "array", items: { type: "string" } },
    statusSources: { type: "array", items: sourceSchema },
  },
};
const adminResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["aggregate", "metadata"],
  properties: { aggregate: adminAggregateSchema, metadata: metadataSchema },
};
const publicOpportunitySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "slug",
    "title",
    "role",
    "category",
    "recruitmentStatus",
    "company",
    "forecast",
    "recruitments",
    "preparationNotes",
    "updatedAt",
  ],
  properties: {
    slug: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
    category: { type: "string" },
    recruitmentStatus: { type: "string", enum: careerRecruitmentStatuses },
    company: publicCompanySchema,
    forecast: nullable(forecastSchema),
    recruitments: { type: "array", items: recruitmentSchema },
    preparationNotes: { type: "array", items: { type: "string" } },
    updatedAt: dateTime,
  },
};
const publicDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["opportunity"],
  properties: { opportunity: publicOpportunitySchema },
};
const summarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "slug",
    "title",
    "role",
    "category",
    "recruitmentStatus",
    "company",
    "forecast",
    "updatedAt",
  ],
  properties: {
    slug: { type: "string" },
    title: { type: "string" },
    role: { type: "string" },
    category: { type: "string" },
    recruitmentStatus: { type: "string", enum: careerRecruitmentStatuses },
    company: publicCompanySchema,
    forecast: nullable({
      type: "object",
      additionalProperties: false,
      required: ["expectedOpenFrom", "expectedOpenTo", "confidence"],
      properties: {
        expectedOpenFrom: nullable(date),
        expectedOpenTo: nullable(date),
        confidence: { type: "string", enum: careerForecastConfidences },
      },
    }),
    updatedAt: dateTime,
  },
};
const listSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "count", "updatedAt"],
  properties: {
    items: { type: "array", items: summarySchema },
    count: { type: "integer" },
    updatedAt: nullable(dateTime),
  },
};
const paramsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug"],
  properties: { slug: { type: "string" } },
};

export function registerCareerRoutes(
  app: FastifyInstance,
  options: Options,
): void {
  app.get<{ Querystring: Query }>(
    "/career/opportunities",
    {
      schema: {
        tags: ["careers"],
        summary: "List published Career Radar opportunities",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50 },
            company: { type: "string" },
            recruitmentStatus: {
              type: "string",
              enum: careerRecruitmentStatuses,
            },
          },
        },
        response: { 200: listSchema },
      },
    },
    async (request, reply) => {
      const items = (await options.careerService.listPublic(request.query)).map(
        toPublicSummary,
      );
      return sendCacheable(request, reply, {
        items,
        count: items.length,
        updatedAt: latestUpdatedAt(items),
      });
    },
  );

  app.get<{ Params: Params }>(
    "/career/opportunities/:slug",
    {
      schema: {
        tags: ["careers"],
        summary: "Read one published Career Radar opportunity",
        params: paramsSchema,
        response: { 200: publicDetailSchema },
      },
    },
    async (request, reply) => {
      const aggregate = await options.careerService.getPublic(
        request.params.slug,
      );
      if (!aggregate)
        return reply
          .status(404)
          .send({ error: "Career opportunity not found" });
      return sendCacheable(request, reply, {
        opportunity: toPublicOpportunity(aggregate),
      });
    },
  );

  app.post<{ Body: unknown }>(
    "/admin/career/opportunities",
    {
      onRequest: adminGuard(options.adminToken),
      schema: {
        tags: ["admin-careers"],
        summary: "Create a private Career Radar aggregate",
        security: [{ bearerAuth: [] }],
        body: adminBodySchema,
        response: { 201: adminResponseSchema },
      },
    },
    async (request, reply) =>
      handleWrite(reply, () => options.careerService.create(request.body), 201),
  );

  app.get<{ Params: Params }>(
    "/admin/career/opportunities/:slug",
    {
      onRequest: adminGuard(options.adminToken),
      schema: {
        tags: ["admin-careers"],
        summary: "Read a round-trip-safe Career Radar aggregate",
        security: [{ bearerAuth: [] }],
        params: paramsSchema,
        response: { 200: adminResponseSchema },
      },
    },
    async (request, reply) => {
      const aggregate = await options.careerService.getAdmin(
        request.params.slug,
      );
      if (!aggregate)
        return reply
          .status(404)
          .send({ error: "Career opportunity not found" });
      reply.header("Cache-Control", "no-store");
      return toAdminDetail(aggregate);
    },
  );

  app.put<{ Params: Params; Body: unknown }>(
    "/admin/career/opportunities/:slug",
    {
      onRequest: adminGuard(options.adminToken),
      schema: {
        tags: ["admin-careers"],
        summary:
          "Transactionally replace a Career Radar aggregate; accepts an admin GET response unchanged",
        security: [{ bearerAuth: [] }],
        params: paramsSchema,
        body: adminBodySchema,
        response: { 200: adminResponseSchema },
      },
    },
    async (request, reply) =>
      handleWrite(reply, () =>
        options.careerService.update(request.params.slug, request.body),
      ),
  );

  app.post<{ Params: Params }>(
    "/admin/career/opportunities/:slug/publish",
    {
      onRequest: adminGuard(options.adminToken),
      schema: {
        tags: ["admin-careers"],
        summary: "Publish a validated Career Radar aggregate",
        security: [{ bearerAuth: [] }],
        params: paramsSchema,
        response: { 200: adminResponseSchema },
      },
    },
    async (request, reply) =>
      handleWrite(reply, () =>
        options.careerService.publish(request.params.slug),
      ),
  );
}

async function handleWrite(
  reply: FastifyReply,
  operation: () => Promise<CareerAggregate | null>,
  status = 200,
) {
  try {
    const aggregate = await operation();
    if (!aggregate)
      return reply.status(404).send({ error: "Career opportunity not found" });
    reply.header("Cache-Control", "no-store");
    return reply.status(status).send(toAdminDetail(aggregate));
  } catch (error) {
    if (error instanceof CareerValidationError)
      return reply
        .status(400)
        .send({ error: error.message, issues: error.issues });
    if (error instanceof CareerConflictError)
      return reply.status(409).send({ error: error.message });
    throw error;
  }
}

function toSource(source: CareerAggregate["statusSources"][number]["source"]) {
  return {
    id: source.id,
    type: source.type,
    title: source.title,
    url: source.url,
    ...(source.publisher ? { publisher: source.publisher } : {}),
    ...(source.publishedAt
      ? { publishedAt: source.publishedAt.toISOString() }
      : {}),
    accessedAt: source.accessedAt.toISOString(),
  };
}
function toForecast(aggregate: CareerAggregate, includeSources = false) {
  if (!aggregate.forecast) return null;
  const value = {
    ...(aggregate.forecast.expectedOpenFrom
      ? { expectedOpenFrom: toDate(aggregate.forecast.expectedOpenFrom) }
      : {}),
    ...(aggregate.forecast.expectedOpenTo
      ? { expectedOpenTo: toDate(aggregate.forecast.expectedOpenTo) }
      : {}),
    confidence: aggregate.forecast.confidence,
    reasons: aggregate.forecast.reasons.map((reason) => reason.text),
    basedOnRecruitmentCount: aggregate.forecast.basedOnRecruitmentCount,
    methodVersion: aggregate.forecast.methodVersion,
    analyzedAt: aggregate.forecast.analyzedAt.toISOString(),
  };
  return includeSources
    ? {
        ...value,
        sources: aggregate.forecast.sources.map((link) =>
          toSource(link.source),
        ),
      }
    : value;
}
function toRecruitments(aggregate: CareerAggregate) {
  return aggregate.recruitments.map((item) => ({
    id: item.id,
    year: item.year,
    title: item.title,
    ...(item.openDate ? { openDate: toDate(item.openDate) } : {}),
    ...(item.closeDate ? { closeDate: toDate(item.closeDate) } : {}),
    ...(item.employmentType ? { employmentType: item.employmentType } : {}),
    eligibility: item.eligibility.map((entry) => entry.text),
    process: item.process.map(({ order, type, label }) => ({
      order,
      type,
      label,
    })),
    sources: item.sources.map((link) => toSource(link.source)),
  }));
}
function toCompany(aggregate: CareerAggregate) {
  return {
    slug: aggregate.company.slug,
    name: aggregate.company.name,
    ...(aggregate.company.englishName
      ? { englishName: aggregate.company.englishName }
      : {}),
    ...(aggregate.company.careersUrl
      ? { careersUrl: aggregate.company.careersUrl }
      : {}),
  };
}
function toPublicOpportunity(aggregate: CareerAggregate) {
  return {
    slug: aggregate.slug,
    title: aggregate.title,
    role: aggregate.role,
    category: aggregate.category,
    recruitmentStatus: aggregate.recruitmentStatus,
    company: toCompany(aggregate),
    forecast: toForecast(aggregate),
    recruitments: toRecruitments(aggregate),
    preparationNotes: aggregate.preparationNotes.map((note) => note.text),
    updatedAt: aggregate.updatedAt.toISOString(),
  };
}
function toPublicSummary(aggregate: CareerAggregate) {
  const forecast = aggregate.forecast
    ? {
        ...(aggregate.forecast.expectedOpenFrom
          ? { expectedOpenFrom: toDate(aggregate.forecast.expectedOpenFrom) }
          : {}),
        ...(aggregate.forecast.expectedOpenTo
          ? { expectedOpenTo: toDate(aggregate.forecast.expectedOpenTo) }
          : {}),
        confidence: aggregate.forecast.confidence,
      }
    : null;
  return {
    slug: aggregate.slug,
    title: aggregate.title,
    role: aggregate.role,
    category: aggregate.category,
    recruitmentStatus: aggregate.recruitmentStatus,
    company: toCompany(aggregate),
    forecast,
    updatedAt: aggregate.updatedAt.toISOString(),
  };
}
function toAdminDetail(aggregate: CareerAggregate) {
  return {
    aggregate: {
      company: toCompany(aggregate),
      opportunity: {
        slug: aggregate.slug,
        title: aggregate.title,
        role: aggregate.role,
        category: aggregate.category,
        recruitmentStatus: aggregate.recruitmentStatus,
        ...(aggregate.actualStatusAsOf
          ? { actualStatusAsOf: aggregate.actualStatusAsOf.toISOString() }
          : {}),
      },
      forecast: toForecast(aggregate, true),
      recruitments: toRecruitments(aggregate),
      preparationNotes: aggregate.preparationNotes.map((note) => note.text),
      statusSources: aggregate.statusSources.map((link) =>
        toSource(link.source),
      ),
    },
    metadata: {
      visibility: aggregate.visibility,
      publishedAt: aggregate.publishedAt?.toISOString() ?? null,
      createdAt: aggregate.createdAt.toISOString(),
      updatedAt: aggregate.updatedAt.toISOString(),
    },
  };
}

function adminGuard(adminToken: string | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : undefined;
    if (!adminToken || !token || !safeEqual(token, adminToken))
      return reply.status(401).send({ error: "Unauthorized admin request" });
  };
}
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function sendCacheable(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
) {
  const etag = `"${createHash("sha256").update(JSON.stringify(payload)).digest("base64url").slice(0, 24)}"`;
  reply.header("Cache-Control", cacheControl).header("ETag", etag);
  const matches = request.headers["if-none-match"]
    ?.split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === etag);
  return matches ? reply.status(304).send() : reply.send(payload);
}
function latestUpdatedAt(items: Array<{ updatedAt: string }>) {
  return items.reduce<string | null>(
    (latest, item) =>
      !latest || item.updatedAt > latest ? item.updatedAt : latest,
    null,
  );
}
function toDate(value: Date) {
  return value.toISOString().slice(0, 10);
}
