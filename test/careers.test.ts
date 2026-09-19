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
  company: {
    slug: "example-company",
    name: "Example Company",
    website: "https://example.com",
  },
  opportunity: {
    slug: "example-internship",
    title: "Backend Internship",
    employmentType: "INTERNSHIP",
    actualStatus: "CLOSED",
    actualStatusAsOf: "2026-09-19T00:00:00.000Z",
    summary: "Evidence-backed opportunity summary",
    applicationUrl: "https://example.com/jobs/backend-intern",
  },
  history: [
    {
      key: "2025-cycle",
      openedOn: "2025-09-01",
      closedOn: "2025-09-30",
      actualStatus: "CLOSED",
    },
  ],
  forecast: {
    predictedStatus: "UPCOMING",
    confidence: "LOW",
    windowStart: "2026-10-01",
    windowEnd: "2026-10-31",
    rationale: "A forecast based on the linked historical source.",
  },
  sources: [
    {
      key: "official-status",
      label: "Official careers page",
      url: "https://example.com/jobs",
      retrievedAt: "2026-09-19T01:00:00.000Z",
      relationship: "ACTUAL_STATUS",
    },
    {
      key: "history-2025",
      label: "Archived 2025 posting",
      url: "https://example.com/jobs/2025",
      retrievedAt: "2026-09-19T01:00:00.000Z",
      relationship: "RECRUITMENT_HISTORY",
      historyKey: "2025-cycle",
    },
    {
      key: "forecast-basis",
      label: "Forecast basis",
      url: "https://example.com/jobs/2025",
      retrievedAt: "2026-09-19T01:00:00.000Z",
      relationship: "FORECAST",
    },
  ],
} as const;

function aggregate(overrides: Partial<CareerAggregate> = {}): CareerAggregate {
  const createdAt = new Date("2026-09-19T01:00:00.000Z");
  return {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: "22222222-2222-2222-2222-222222222222",
    slug: "example-internship",
    title: "Backend Internship",
    employmentType: "INTERNSHIP",
    actualStatus: "CLOSED",
    actualStatusAsOf: createdAt,
    location: null,
    summary: "Evidence-backed opportunity summary",
    description: null,
    applicationUrl: "https://example.com/jobs/backend-intern",
    visibility: "DRAFT",
    publishedAt: null,
    createdAt,
    updatedAt: createdAt,
    company: {
      id: "22222222-2222-2222-2222-222222222222",
      slug: "example-company",
      name: "Example Company",
      website: "https://example.com",
      summary: null,
      logoUrl: null,
      createdAt,
      updatedAt: createdAt,
    },
    history: [],
    forecast: {
      id: "33333333-3333-3333-3333-333333333333",
      opportunityId: "11111111-1111-1111-1111-111111111111",
      predictedStatus: "UPCOMING",
      confidence: "LOW",
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      windowEnd: new Date("2026-10-31T00:00:00.000Z"),
      rationale: "A forecast, not the actual status.",
      createdAt,
      updatedAt: createdAt,
    },
    sourceLinks: [
      {
        id: "44444444-4444-4444-4444-444444444444",
        opportunityId: "11111111-1111-1111-1111-111111111111",
        sourceId: "55555555-5555-5555-5555-555555555555",
        recruitmentHistoryId: null,
        forecastId: null,
        relationship: "ACTUAL_STATUS",
        note: null,
        createdAt,
        source: {
          id: "55555555-5555-5555-5555-555555555555",
          key: "official-status",
          label: "Official careers page",
          publisher: null,
          url: "https://example.com/jobs",
          publishedAt: null,
          retrievedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        },
        recruitmentHistory: null,
        forecast: null,
      },
    ],
    ...overrides,
  };
}

function repositoryMock(overrides: Partial<CareerRepository> = {}) {
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

describe("CareerService", () => {
  it("keeps actual status independent from forecast confidence and prediction", async () => {
    let captured: CareerAggregateInput | undefined;
    const createAggregate = vi.fn(
      (input: CareerAggregateInput): Promise<CareerAggregate> => {
        captured = input;
        const baseForecast = aggregate().forecast;
        return Promise.resolve(
          aggregate({
            actualStatus: input.opportunity.actualStatus,
            forecast:
              baseForecast && input.forecast
                ? {
                    ...baseForecast,
                    predictedStatus: input.forecast.predictedStatus,
                    confidence: input.forecast.confidence,
                  }
                : null,
          }),
        );
      },
    );
    const repository = repositoryMock({
      findBySlug: vi.fn().mockResolvedValue(null),
      createAggregate,
    });
    const service = new CareerService(repository);

    const created = await service.create(request);

    expect(created.actualStatus).toBe("CLOSED");
    expect(created.forecast?.predictedStatus).toBe("UPCOMING");
    expect(created.forecast?.confidence).toBe("LOW");
    expect(captured?.opportunity.actualStatusAsOf).toBeInstanceOf(Date);
    expect(captured?.history[0]?.openedOn).toBeInstanceOf(Date);
  });

  it("rejects unsupported history and forecast records without explicit source links", async () => {
    const service = new CareerService(repositoryMock());
    const invalid = {
      ...request,
      sources: request.sources.filter(
        (source) => source.relationship === "ACTUAL_STATUS",
      ),
    };

    await expect(service.create(invalid)).rejects.toBeInstanceOf(
      CareerValidationError,
    );
  });

  it("requires a timestamped actual-status observation before publishing", async () => {
    const repository = repositoryMock({
      findBySlug: vi
        .fn()
        .mockResolvedValue(aggregate({ actualStatusAsOf: null })),
    });
    const service = new CareerService(repository);

    await expect(service.publish("example-internship")).rejects.toMatchObject({
      issues: [
        expect.objectContaining({ path: "opportunity.actualStatusAsOf" }),
      ],
    });
  });

  it("publishes with an injected deterministic clock", async () => {
    const publishedAt = new Date("2026-09-20T00:00:00.000Z");
    const publish = vi
      .fn()
      .mockResolvedValue(aggregate({ visibility: "PUBLISHED", publishedAt }));
    const repository = repositoryMock({
      findBySlug: vi.fn().mockResolvedValue(aggregate()),
      publish,
    });
    const service = new CareerService(repository, () => publishedAt);

    await service.publish("Example Internship");

    expect(publish).toHaveBeenCalledWith("example-internship", publishedAt);
  });
});
