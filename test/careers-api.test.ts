import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { CareerAggregate } from "../src/repositories/careers.js";
import type { ArticleService } from "../src/services/articles.js";
import type { CareerService } from "../src/services/careers.js";
import type { CommunityService } from "../src/services/community.js";

const observedAt = new Date("2026-09-19T01:00:00.000Z");

function fixture(overrides: Partial<CareerAggregate> = {}): CareerAggregate {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: "22222222-2222-2222-2222-222222222222",
    slug: "example-internship",
    title: "Backend Internship",
    employmentType: "INTERNSHIP",
    actualStatus: "CLOSED",
    actualStatusAsOf: observedAt,
    location: "Seoul",
    summary: "Evidence-backed opportunity summary",
    description: "Public description",
    applicationUrl: "https://example.com/jobs/backend-intern",
    visibility: "PUBLISHED",
    publishedAt: observedAt,
    createdAt: observedAt,
    updatedAt: observedAt,
    company: {
      id: "22222222-2222-2222-2222-222222222222",
      slug: "example-company",
      name: "Example Company",
      website: "https://example.com",
      summary: "Company summary",
      logoUrl: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    },
    history: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        opportunityId: "11111111-1111-1111-1111-111111111111",
        key: "2025-cycle",
        openedOn: new Date("2025-09-01T00:00:00.000Z"),
        closedOn: new Date("2025-09-30T00:00:00.000Z"),
        actualStatus: "CLOSED",
        note: "Observed historical cycle",
        createdAt: observedAt,
        updatedAt: observedAt,
      },
    ],
    forecast: {
      id: "44444444-4444-4444-4444-444444444444",
      opportunityId: "11111111-1111-1111-1111-111111111111",
      predictedStatus: "UPCOMING",
      confidence: "LOW",
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      windowEnd: new Date("2026-10-31T00:00:00.000Z"),
      rationale: "A forecast, not current status.",
      createdAt: observedAt,
      updatedAt: observedAt,
    },
    sourceLinks: [
      {
        id: "55555555-5555-5555-5555-555555555555",
        opportunityId: "11111111-1111-1111-1111-111111111111",
        sourceId: "66666666-6666-6666-6666-666666666666",
        recruitmentHistoryId: null,
        forecastId: null,
        relationship: "ACTUAL_STATUS",
        note: "admin-only link note",
        createdAt: observedAt,
        source: {
          id: "66666666-6666-6666-6666-666666666666",
          key: "official-status",
          label: "Official careers page",
          publisher: "Example Company",
          url: "https://example.com/jobs",
          publishedAt: null,
          retrievedAt: observedAt,
          createdAt: observedAt,
          updatedAt: observedAt,
        },
        recruitmentHistory: null,
        forecast: null,
      },
    ],
    ...overrides,
  };
}

function injectedApp(
  careerService: Partial<CareerService>,
  adminToken = "secret",
) {
  const disconnect = vi.fn();
  return {
    disconnect,
    app: buildApp({
      adminToken,
      careerService: careerService as CareerService,
      articleService: {} as ArticleService,
      communityService: {} as CommunityService,
      prisma: { $disconnect: disconnect } as unknown as PrismaClient,
    }),
  };
}

describe("Career Radar API", () => {
  it("lists published summaries with deterministic cache validators", async () => {
    const listPublic = vi.fn().mockResolvedValue([fixture()]);
    const { app: appPromise, disconnect } = injectedApp({ listPublic });
    const app = await appPromise;

    const first = await app.inject({
      method: "GET",
      url: "/career/opportunities?limit=5",
    });
    const second = await app.inject({
      method: "GET",
      url: "/career/opportunities?limit=5",
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toContain("stale-while-revalidate");
    expect(first.headers.etag).toBe(second.headers.etag);
    expect(first.json()).toMatchObject({
      count: 1,
      opportunities: [
        {
          actualStatus: "CLOSED",
          forecast: { predictedStatus: "UPCOMING", confidence: "LOW" },
        },
      ],
    });
    expect(listPublic).toHaveBeenCalledWith({ limit: 5 });

    const cached = await app.inject({
      method: "GET",
      url: "/career/opportunities?limit=5",
      headers: { "if-none-match": `W/${String(first.headers.etag)}` },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");

    await app.close();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("returns a private-safe public detail without database ids or admin notes", async () => {
    const getPublic = vi.fn().mockResolvedValue(fixture());
    const { app: appPromise } = injectedApp({ getPublic });
    const app = await appPromise;

    const response = await app.inject({
      method: "GET",
      url: "/career/opportunities/example-internship",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(response.body).not.toContain("admin-only link note");
    expect(response.body).not.toContain('"visibility"');
    expect(response.json()).toMatchObject({
      actualStatus: "CLOSED",
      recruitmentHistory: [{ key: "2025-cycle" }],
      sources: [
        {
          key: "official-status",
          relationship: "ACTUAL_STATUS",
          url: "https://example.com/jobs",
        },
      ],
    });
    await app.close();
  });

  it("does not expose draft or missing opportunities", async () => {
    const getPublic = vi.fn().mockResolvedValue(null);
    const { app: appPromise } = injectedApp({ getPublic });
    const app = await appPromise;

    const response = await app.inject({
      method: "GET",
      url: "/career/opportunities/private-draft",
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("requires a bearer token for every admin aggregate route", async () => {
    const create = vi.fn();
    const { app: appPromise } = injectedApp({ create });
    const app = await appPromise;

    const response = await app.inject({
      method: "POST",
      url: "/admin/career/opportunities",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it("reads complete aggregates only for an authorized admin with no-store caching", async () => {
    const getAdmin = vi.fn().mockResolvedValue(fixture());
    const { app: appPromise } = injectedApp({ getAdmin });
    const app = await appPromise;

    const response = await app.inject({
      method: "GET",
      url: "/admin/career/opportunities/example-internship",
      headers: { authorization: "Bearer secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      visibility: "PUBLISHED",
      sources: [{ note: "admin-only link note" }],
    });
    await app.close();
  });

  it("creates, updates, and publishes the illustrative Daangn frontend internship concept", async () => {
    const aggregate = fixture({
      slug: "daangn-frontend-internship",
      title: "Daangn Frontend Internship (illustrative)",
      actualStatus: "UNKNOWN",
      actualStatusAsOf: null,
      visibility: "DRAFT",
      publishedAt: null,
      company: {
        ...fixture().company,
        slug: "daangn-illustrative",
        name: "Daangn (illustrative fixture)",
      },
    });
    const create = vi.fn().mockResolvedValue(aggregate);
    const update = vi.fn().mockResolvedValue(aggregate);
    const publish = vi.fn().mockResolvedValue({
      ...aggregate,
      visibility: "PUBLISHED",
      publishedAt: observedAt,
    });
    const { app: appPromise } = injectedApp({ create, update, publish });
    const app = await appPromise;
    const headers = { authorization: "Bearer secret" };
    // This payload proves the first product concept without asserting real dates,
    // recruitment state, or a production Daangn source.
    const payload = {
      company: {
        slug: "daangn-illustrative",
        name: "Daangn (illustrative fixture)",
      },
      opportunity: {
        slug: "daangn-frontend-internship",
        title: "Daangn Frontend Internship (illustrative)",
        employmentType: "INTERNSHIP",
        actualStatus: "UNKNOWN",
        summary: "Non-production contract fixture; not a real job listing.",
      },
      sources: [
        {
          key: "illustrative-status-source",
          label: "Illustrative source (not production evidence)",
          url: "https://example.com/illustrative-daangn-careers",
          retrievedAt: "2026-09-19T01:00:00.000Z",
          relationship: "ACTUAL_STATUS",
        },
      ],
    };

    const created = await app.inject({
      method: "POST",
      url: "/admin/career/opportunities",
      headers,
      payload,
    });
    const updated = await app.inject({
      method: "PUT",
      url: "/admin/career/opportunities/daangn-frontend-internship",
      headers,
      payload,
    });
    const published = await app.inject({
      method: "POST",
      url: "/admin/career/opportunities/daangn-frontend-internship/publish",
      headers,
    });

    expect(created.statusCode).toBe(201);
    expect(updated.statusCode).toBe(200);
    expect(published.statusCode).toBe(200);
    const normalizedPayload = { ...payload, history: [] };
    expect(create).toHaveBeenCalledWith(normalizedPayload);
    expect(update).toHaveBeenCalledWith(
      "daangn-frontend-internship",
      normalizedPayload,
    );
    expect(publish).toHaveBeenCalledWith("daangn-frontend-internship");
    expect(published.json()).toMatchObject({
      slug: "daangn-frontend-internship",
      actualStatus: "UNKNOWN",
      visibility: "PUBLISHED",
    });
    await app.close();
  });

  it("rejects malformed aggregate bodies before calling the service", async () => {
    const create = vi.fn();
    const { app: appPromise } = injectedApp({ create });
    const app = await appPromise;

    const response = await app.inject({
      method: "POST",
      url: "/admin/career/opportunities",
      headers: { authorization: "Bearer secret" },
      payload: { company: {}, opportunity: {}, sources: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it("publishes the public and bearer-admin contracts in OpenAPI", async () => {
    const { app: appPromise } = injectedApp({});
    const app = await appPromise;

    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const document = response.json<{
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes: Record<string, unknown> };
    }>();

    expect(response.statusCode).toBe(200);
    expect(document.paths["/career/opportunities"]).toHaveProperty("get");
    expect(document.paths["/career/opportunities/{slug}"]).toHaveProperty(
      "get",
    );
    expect(document.paths["/admin/career/opportunities"]).toHaveProperty(
      "post",
    );
    expect(document.paths["/admin/career/opportunities/{slug}"]).toHaveProperty(
      "get",
    );
    expect(document.paths["/admin/career/opportunities/{slug}"]).toHaveProperty(
      "put",
    );
    expect(
      document.paths["/admin/career/opportunities/{slug}/publish"],
    ).toHaveProperty("post");
    expect(document.components.securitySchemes).toHaveProperty("bearerAuth");
    await app.close();
  });
});
