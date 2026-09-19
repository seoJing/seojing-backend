import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { CareerAggregate } from "../src/repositories/careers.js";
import type { ArticleService } from "../src/services/articles.js";
import type { CareerService } from "../src/services/careers.js";
import type { CommunityService } from "../src/services/community.js";

const at = new Date("2026-09-19T01:00:00.000Z");
const opportunityId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const recruitmentId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";

interface OpenApiDocument {
  paths: Record<
    string,
    {
      get?: {
        responses?: Record<
          string,
          {
            content?: Record<
              string,
              {
                schema?: {
                  required?: string[];
                  properties?: Record<string, { required?: string[] }>;
                };
              }
            >;
          }
        >;
      };
      put?: { summary?: string };
    }
  >;
}

function source(id = sourceId) {
  return {
    id,
    type: "OFFICIAL",
    title: "Illustrative official source",
    url: "https://example.com/jobs",
    publisher: "Example Company",
    publishedAt: null,
    accessedAt: at,
    createdAt: at,
    updatedAt: at,
  };
}
function fixture(overrides: Partial<CareerAggregate> = {}): CareerAggregate {
  const statusSource = source();
  return {
    id: opportunityId,
    companyId,
    slug: "example-internship",
    title: "Backend Internship",
    role: "Backend Engineer",
    category: "Engineering",
    recruitmentStatus: "CLOSED",
    actualStatusAsOf: at,
    visibility: "PUBLISHED",
    publishedAt: at,
    createdAt: at,
    updatedAt: at,
    company: {
      id: companyId,
      slug: "example-company",
      name: "Example Company",
      englishName: "Example Company",
      careersUrl: "https://example.com/careers",
      createdAt: at,
      updatedAt: at,
    },
    recruitments: [
      {
        id: recruitmentId,
        opportunityId,
        year: 2025,
        title: "2025 Backend Internship",
        openDate: new Date("2025-09-01T00:00:00Z"),
        closeDate: new Date("2025-09-30T00:00:00Z"),
        employmentType: "INTERNSHIP",
        createdAt: at,
        updatedAt: at,
        eligibility: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            recruitmentId,
            sortOrder: 0,
            text: "Illustrative eligibility",
          },
        ],
        process: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            recruitmentId,
            order: 1,
            type: "DOCUMENT",
            label: "Document review",
          },
        ],
        sources: [
          { recruitmentId, sourceId, sortOrder: 0, source: statusSource },
        ],
      },
    ],
    forecast: {
      id: "77777777-7777-4777-8777-777777777777",
      opportunityId,
      expectedOpenFrom: new Date("2026-10-01T00:00:00Z"),
      expectedOpenTo: new Date("2026-10-31T00:00:00Z"),
      confidence: "LOW",
      basedOnRecruitmentCount: 1,
      methodVersion: "illustrative-v1",
      analyzedAt: at,
      createdAt: at,
      updatedAt: at,
      reasons: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          forecastId: "77777777-7777-4777-8777-777777777777",
          sortOrder: 0,
          text: "Illustrative historical pattern",
        },
      ],
      sources: [
        {
          forecastId: "77777777-7777-4777-8777-777777777777",
          sourceId,
          sortOrder: 0,
          source: statusSource,
        },
      ],
    },
    preparationNotes: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        opportunityId,
        sortOrder: 0,
        text: "Review fundamentals",
      },
    ],
    statusSources: [
      { opportunityId, sourceId, sortOrder: 0, source: statusSource },
    ],
    ...overrides,
  };
}
function appWith(careerService: Partial<CareerService>) {
  return buildApp({
    adminToken: "secret",
    careerService: careerService as CareerService,
    articleService: {} as ArticleService,
    communityService: {} as CommunityService,
    prisma: { $disconnect: vi.fn() } as unknown as PrismaClient,
  });
}

describe("Career Radar API contract", () => {
  it("returns {items,count,updatedAt} summaries and keeps ETag in the header", async () => {
    const listPublic = vi.fn().mockResolvedValue([fixture()]);
    const app = await appWith({ listPublic });
    const first = await app.inject({
      method: "GET",
      url: "/career/opportunities?recruitmentStatus=CLOSED",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      items: [
        {
          slug: "example-internship",
          title: "Backend Internship",
          role: "Backend Engineer",
          category: "Engineering",
          recruitmentStatus: "CLOSED",
          company: {
            slug: "example-company",
            name: "Example Company",
            englishName: "Example Company",
            careersUrl: "https://example.com/careers",
          },
          forecast: {
            expectedOpenFrom: "2026-10-01",
            expectedOpenTo: "2026-10-31",
            confidence: "LOW",
          },
          updatedAt: at.toISOString(),
        },
      ],
      count: 1,
      updatedAt: at.toISOString(),
    });
    expect(first.headers.etag).toMatch(/^"/);
    expect(first.body).not.toContain("etag");
    const cached = await app.inject({
      method: "GET",
      url: "/career/opportunities?recruitmentStatus=CLOSED",
      headers: { "if-none-match": `W/${String(first.headers.etag)}` },
    });
    expect(cached.statusCode).toBe(304);
    expect(listPublic).toHaveBeenCalledWith({ recruitmentStatus: "CLOSED" });
    await app.close();
  });

  it("returns the exact public detail envelope and does not confuse status with confidence", async () => {
    const app = await appWith({
      getPublic: vi.fn().mockResolvedValue(fixture()),
    });
    const response = await app.inject({
      method: "GET",
      url: "/career/opportunities/example-internship",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      opportunity: {
        slug: "example-internship",
        title: "Backend Internship",
        role: "Backend Engineer",
        category: "Engineering",
        recruitmentStatus: "CLOSED",
        company: {
          slug: "example-company",
          name: "Example Company",
          englishName: "Example Company",
          careersUrl: "https://example.com/careers",
        },
        forecast: {
          expectedOpenFrom: "2026-10-01",
          expectedOpenTo: "2026-10-31",
          confidence: "LOW",
          reasons: ["Illustrative historical pattern"],
          basedOnRecruitmentCount: 1,
          methodVersion: "illustrative-v1",
          analyzedAt: at.toISOString(),
        },
        recruitments: [
          {
            id: recruitmentId,
            year: 2025,
            title: "2025 Backend Internship",
            openDate: "2025-09-01",
            closeDate: "2025-09-30",
            employmentType: "INTERNSHIP",
            eligibility: ["Illustrative eligibility"],
            process: [{ order: 1, type: "DOCUMENT", label: "Document review" }],
            sources: [
              {
                id: sourceId,
                type: "OFFICIAL",
                title: "Illustrative official source",
                url: "https://example.com/jobs",
                publisher: "Example Company",
                accessedAt: at.toISOString(),
              },
            ],
          },
        ],
        preparationNotes: ["Review fundamentals"],
        updatedAt: at.toISOString(),
      },
    });
    expect(response.body).not.toContain("visibility");
    expect(response.body).not.toContain("actualStatusAsOf");
    await app.close();
  });

  it("makes admin GET directly round-tripable through PUT", async () => {
    const aggregate = fixture();
    const getAdmin = vi.fn().mockResolvedValue(aggregate);
    const update = vi.fn().mockResolvedValue(aggregate);
    const app = await appWith({ getAdmin, update });
    const headers = { authorization: "Bearer secret" };
    const read = await app.inject({
      method: "GET",
      url: "/admin/career/opportunities/example-internship",
      headers,
    });
    const body = read.json<Record<string, unknown>>();
    const replaced = await app.inject({
      method: "PUT",
      url: "/admin/career/opportunities/example-internship",
      headers,
      payload: body,
    });
    expect(read.statusCode).toBe(200);
    expect(replaced.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(body).toHaveProperty("aggregate.statusSources");
    expect(body).toHaveProperty("metadata.visibility", "PUBLISHED");
    expect(update).toHaveBeenCalledWith("example-internship", body);
    await app.close();
  });

  it("protects admin routes and documents exact response schemas", async () => {
    const create = vi.fn();
    const app = await appWith({ create });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/career/opportunities",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const openapi = (
      await app.inject({ method: "GET", url: "/openapi.json" })
    ).json<OpenApiDocument>();
    const listSchema =
      openapi.paths["/career/opportunities"]?.get?.responses?.["200"]
        ?.content?.["application/json"]?.schema;
    expect(listSchema?.required).toEqual(["items", "count", "updatedAt"]);
    const detailSchema =
      openapi.paths["/career/opportunities/{slug}"]?.get?.responses?.["200"]
        ?.content?.["application/json"]?.schema;
    expect(detailSchema?.required).toEqual(["opportunity"]);
    expect(detailSchema?.properties?.opportunity?.required).toContain(
      "recruitments",
    );
    expect(
      openapi.paths["/admin/career/opportunities/{slug}"]?.put?.summary,
    ).toContain("accepts an admin GET response unchanged");
    const adminReadSchema =
      openapi.paths["/admin/career/opportunities/{slug}"]?.get?.responses?.[
        "200"
      ]?.content?.["application/json"]?.schema;
    expect(adminReadSchema?.required).toEqual(["aggregate", "metadata"]);
    await app.close();
  });
});
