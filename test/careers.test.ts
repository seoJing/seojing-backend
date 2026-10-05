import { describe, expect, it, vi } from "vitest";

import type {
  CareerAggregate,
  CareerAggregateInput,
  CareerRepository,
} from "../src/repositories/careers.js";
import {
  CareerService,
  CareerValidationError,
} from "../src/services/careers.js";

const request = {
  aggregate: {
    company: {
      slug: "example-company",
      name: "Example Company",
      careersUrl: "https://example.com/careers",
    },
    opportunity: {
      slug: "example-internship",
      title: "Backend Internship",
      role: "Backend Engineer",
      category: "Engineering",
      recruitmentStatus: "CLOSED",
      actualStatusAsOf: "2026-09-19T00:00:00.000Z",
    },
    forecast: {
      expectedOpenFrom: "2026-10-01",
      expectedOpenTo: "2026-10-31",
      confidence: "LOW",
      reasons: ["Illustrative historical pattern"],
      basedOnRecruitmentCount: 1,
      methodVersion: "test-v1",
      analyzedAt: "2026-09-19T01:00:00.000Z",
      sources: [
        {
          type: "ARCHIVE",
          title: "Illustrative archive",
          url: "https://example.com/archive",
          accessedAt: "2026-09-19T01:00:00.000Z",
        },
      ],
    },
    recruitments: [
      {
        year: 2025,
        title: "2025 Backend Internship",
        openDate: "2025-09-01",
        closeDate: "2025-09-30",
        employmentType: "INTERNSHIP",
        eligibility: ["Illustrative eligibility"],
        process: [{ order: 1, type: "DOCUMENT", label: "Document review" }],
        sources: [
          {
            type: "OFFICIAL",
            title: "Illustrative posting",
            url: "https://example.com/jobs/2025",
            accessedAt: "2026-09-19T01:00:00.000Z",
          },
        ],
      },
    ],
    preparationNotes: ["Review fundamentals"],
    statusSources: [
      {
        type: "OFFICIAL",
        title: "Illustrative careers page",
        url: "https://example.com/jobs",
        accessedAt: "2026-09-19T01:00:00.000Z",
      },
    ],
  },
} as const;

function repository(overrides: Partial<CareerRepository> = {}) {
  return {
    listPublished: vi.fn(),
    findPublishedBySlug: vi.fn(),
    findBySlug: vi.fn(),
    createAggregate: vi.fn(),
    replaceAggregate: vi.fn(),
    publish: vi.fn(),
    ...overrides,
  } as unknown as CareerRepository;
}
function aggregate(overrides: Partial<CareerAggregate> = {}): CareerAggregate {
  const at = new Date("2026-09-19T01:00:00Z");
  const id = "11111111-1111-4111-8111-111111111111";
  return {
    id,
    companyId: id,
    slug: "example-internship",
    title: "Backend Internship",
    role: "Backend Engineer",
    category: "Engineering",
    recruitmentStatus: "CLOSED",
    actualStatusAsOf: at,
    visibility: "DRAFT",
    publishedAt: null,
    createdAt: at,
    updatedAt: at,
    company: {
      id,
      slug: "example-company",
      name: "Example Company",
      englishName: null,
      careersUrl: null,
      createdAt: at,
      updatedAt: at,
    },
    recruitments: [],
    forecast: null,
    preparationNotes: [],
    statusSources: [
      {
        opportunityId: id,
        sourceId: id,
        sortOrder: 0,
        source: {
          id,
          type: "OFFICIAL",
          title: "Status",
          url: "https://example.com",
          publisher: null,
          publishedAt: null,
          accessedAt: at,
          createdAt: at,
          updatedAt: at,
        },
      },
    ],
    ...overrides,
  };
}

describe("CareerService", () => {
  it("parses the envelope into structured values while keeping status separate from forecast confidence", async () => {
    let captured: CareerAggregateInput | undefined;
    const createAggregate = vi.fn((value: CareerAggregateInput) => {
      captured = value;
      return Promise.resolve(aggregate());
    });
    const service = new CareerService(
      repository({
        findBySlug: vi.fn().mockResolvedValue(null),
        createAggregate,
      }),
    );
    await service.create(request);
    expect(captured?.opportunity.recruitmentStatus).toBe("CLOSED");
    expect(captured?.forecast?.confidence).toBe("LOW");
    expect(captured?.forecast?.analyzedAt).toBeInstanceOf(Date);
    expect(captured?.recruitments[0]?.openDate).toBeInstanceOf(Date);
  });

  it("rejects forecasts without evidence and invalid date windows", async () => {
    const service = new CareerService(repository());
    await expect(
      service.create({
        ...request,
        aggregate: {
          ...request.aggregate,
          forecast: {
            ...request.aggregate.forecast,
            expectedOpenFrom: "2026-11-01",
            expectedOpenTo: "2026-10-01",
            sources: [],
          },
        },
      }),
    ).rejects.toBeInstanceOf(CareerValidationError);
  });

  it("requires observed actual status and its source before publish", async () => {
    const service = new CareerService(
      repository({
        findBySlug: vi
          .fn()
          .mockResolvedValue(
            aggregate({ actualStatusAsOf: null, statusSources: [] }),
          ),
      }),
    );
    try {
      await service.publish("example-internship");
      throw new Error("Expected publish validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CareerValidationError);
      const paths = (error as CareerValidationError).issues.map(
        (issue) => issue.path,
      );
      expect(paths).toContain("aggregate.opportunity.actualStatusAsOf");
      expect(paths).toContain("aggregate.statusSources");
    }
  });

  it("publishes with deterministic time", async () => {
    const now = new Date("2026-09-20T00:00:00Z");
    const publish = vi
      .fn()
      .mockResolvedValue(
        aggregate({ visibility: "PUBLISHED", publishedAt: now }),
      );
    const service = new CareerService(
      repository({
        findBySlug: vi.fn().mockResolvedValue(aggregate()),
        publish,
      }),
      () => now,
    );
    await service.publish("Example Internship");
    expect(publish).toHaveBeenCalledWith("example-internship", now);
  });
});
