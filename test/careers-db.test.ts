import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CareerRepository } from "../src/repositories/careers.js";
import { CareerService } from "../src/services/careers.js";

const runDbTests = process.env.RUN_DB_TESTS === "true";
const describeDb = runDbTests ? describe : describe.skip;
const prisma = new PrismaClient();
const publishedAt = new Date("2026-09-20T00:00:00.000Z");
const repository = new CareerRepository(prisma);
const service = new CareerService(repository, () => publishedAt);
const slug = "integration-career-radar";
const companySlug = "integration-career-company";
const sourceKeys = [
  "integration-status",
  "integration-history",
  "integration-forecast",
];

const aggregateInput = {
  company: {
    slug: companySlug,
    name: "Integration Company",
    website: "https://example.com",
  },
  opportunity: {
    slug,
    title: "Integration Backend Internship",
    employmentType: "INTERNSHIP",
    actualStatus: "CLOSED",
    actualStatusAsOf: "2026-09-19T00:00:00.000Z",
    summary: "Integration-only Career Radar record",
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
    rationale: "Integration-only forecast rationale",
  },
  sources: [
    {
      key: sourceKeys[0],
      label: "Official integration status source",
      url: "https://example.com/jobs",
      retrievedAt: "2026-09-19T01:00:00.000Z",
      relationship: "ACTUAL_STATUS",
    },
    {
      key: sourceKeys[1],
      label: "Integration history source",
      url: "https://example.com/jobs/history",
      retrievedAt: "2026-09-19T01:00:00.000Z",
      relationship: "RECRUITMENT_HISTORY",
      historyKey: "2025-cycle",
    },
    {
      key: sourceKeys[2],
      label: "Integration forecast source",
      url: "https://example.com/jobs/history",
      retrievedAt: "2026-09-19T01:00:00.000Z",
      relationship: "FORECAST",
    },
  ],
} as const;

async function clean(): Promise<void> {
  await prisma.careerOpportunity.deleteMany({ where: { slug } });
  await prisma.careerSource.deleteMany({ where: { key: { in: sourceKeys } } });
  await prisma.careerCompany.deleteMany({ where: { slug: companySlug } });
}

describeDb("Career Radar database integration", () => {
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it("rolls back the whole aggregate when an invalid explicit link reaches the database", async () => {
    await expect(
      repository.createAggregate({
        company: {
          slug: companySlug,
          name: "Integration Company",
          website: "https://example.com",
        },
        opportunity: {
          slug,
          title: "Integration Backend Internship",
          employmentType: "INTERNSHIP",
          actualStatus: "UNKNOWN",
          summary: "Rollback verification",
        },
        history: [],
        sources: [
          {
            key: sourceKeys[0]!,
            label: "Invalid forecast link",
            url: "https://example.com/jobs",
            retrievedAt: new Date("2026-09-19T01:00:00.000Z"),
            relationship: "FORECAST",
          },
        ],
      }),
    ).rejects.toThrow();

    await expect(repository.findBySlug(slug)).resolves.toBeNull();
    await expect(
      prisma.careerCompany.findUnique({ where: { slug: companySlug } }),
    ).resolves.toBeNull();
    await expect(
      prisma.careerSource.findUnique({ where: { key: sourceKeys[0] } }),
    ).resolves.toBeNull();
  });

  it("transactionally writes, replaces, publishes, and reads the aggregate", async () => {
    const created = await service.create(aggregateInput);

    expect(created.visibility).toBe("DRAFT");
    expect(created.history).toHaveLength(1);
    expect(created.forecast?.confidence).toBe("LOW");
    expect(created.sourceLinks).toHaveLength(3);
    await expect(service.getPublic(slug)).resolves.toBeNull();

    const updated = await service.update(slug, {
      ...aggregateInput,
      opportunity: {
        ...aggregateInput.opportunity,
        summary: "Updated integration-only summary",
      },
    });

    expect(updated?.summary).toBe("Updated integration-only summary");
    expect(updated?.history).toHaveLength(1);
    expect(updated?.sourceLinks).toHaveLength(3);

    const published = await service.publish(slug);
    const publicRead = await service.getPublic(slug);

    expect(published?.visibility).toBe("PUBLISHED");
    expect(published?.publishedAt).toEqual(publishedAt);
    expect(publicRead?.actualStatus).toBe("CLOSED");
    expect(publicRead?.forecast?.predictedStatus).toBe("UPCOMING");
    expect(publicRead?.forecast?.confidence).toBe("LOW");
  });
});
