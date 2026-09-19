import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CareerRepository } from "../src/repositories/careers.js";
import { CareerService } from "../src/services/careers.js";

const describeDb =
  process.env.RUN_DB_TESTS === "true" ? describe : describe.skip;
const prisma = new PrismaClient();
const repository = new CareerRepository(prisma);
const publishedAt = new Date("2026-09-20T00:00:00Z");
const service = new CareerService(repository, () => publishedAt);
const slug = "integration-career-radar";
const companySlug = "integration-career-company";

const body = {
  aggregate: {
    company: {
      slug: companySlug,
      name: "Integration Company",
      englishName: "Integration Company",
      careersUrl: "https://example.com/careers",
    },
    opportunity: {
      slug,
      title: "Integration Backend Internship",
      role: "Backend Engineer",
      category: "Engineering",
      recruitmentStatus: "CLOSED",
      actualStatusAsOf: "2026-09-19T00:00:00.000Z",
    },
    forecast: {
      expectedOpenFrom: "2026-10-01",
      expectedOpenTo: "2026-10-31",
      confidence: "LOW",
      reasons: ["Integration-only reason"],
      basedOnRecruitmentCount: 1,
      methodVersion: "integration-v1",
      analyzedAt: "2026-09-19T01:00:00.000Z",
      sources: [
        {
          type: "ARCHIVE",
          title: "Integration forecast source",
          url: "https://example.com/archive",
          accessedAt: "2026-09-19T01:00:00.000Z",
        },
      ],
    },
    recruitments: [
      {
        year: 2025,
        title: "Integration 2025 cycle",
        openDate: "2025-09-01",
        closeDate: "2025-09-30",
        employmentType: "INTERNSHIP",
        eligibility: ["Integration eligibility"],
        process: [{ order: 1, type: "DOCUMENT", label: "Document review" }],
        sources: [
          {
            type: "OFFICIAL",
            title: "Integration recruitment source",
            url: "https://example.com/jobs/2025",
            accessedAt: "2026-09-19T01:00:00.000Z",
          },
        ],
      },
    ],
    preparationNotes: ["Integration preparation note"],
    statusSources: [
      {
        type: "OFFICIAL",
        title: "Integration status source",
        url: "https://example.com/jobs",
        accessedAt: "2026-09-19T01:00:00.000Z",
      },
    ],
  },
} as const;

async function clean() {
  await prisma.careerOpportunity.deleteMany({ where: { slug } });
  await prisma.careerSource.deleteMany({
    where: { title: { startsWith: "Integration" } },
  });
  await prisma.careerCompany.deleteMany({ where: { slug: companySlug } });
}

describeDb("Career Radar database integration", () => {
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  it("rolls back the aggregate when a normalized child constraint fails", async () => {
    await expect(
      repository.createAggregate({
        company: { slug: companySlug, name: "Integration Company" },
        opportunity: {
          slug,
          title: "Rollback",
          role: "Engineer",
          category: "Engineering",
          recruitmentStatus: "UNKNOWN",
        },
        recruitments: [
          {
            year: 2025,
            title: "Integration invalid cycle",
            eligibility: [],
            process: [
              { order: 1, type: "ONE", label: "One" },
              { order: 1, type: "TWO", label: "Two" },
            ],
            sources: [
              {
                type: "OFFICIAL",
                title: "Integration invalid source",
                url: "https://example.com",
                accessedAt: new Date("2026-09-19T01:00:00Z"),
              },
            ],
          },
        ],
        preparationNotes: [],
        statusSources: [
          {
            type: "OFFICIAL",
            title: "Integration rollback status",
            url: "https://example.com/status",
            accessedAt: new Date("2026-09-19T01:00:00Z"),
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(repository.findBySlug(slug)).resolves.toBeNull();
    await expect(
      prisma.careerCompany.findUnique({ where: { slug: companySlug } }),
    ).resolves.toBeNull();
  });

  it("writes, replaces, publishes, and reads all normalized fields transactionally", async () => {
    const created = await service.create(body);
    expect(created.visibility).toBe("DRAFT");
    expect(created.recruitments[0]?.eligibility[0]?.text).toBe(
      "Integration eligibility",
    );
    expect(created.forecast?.reasons[0]?.text).toBe("Integration-only reason");
    expect(created.statusSources).toHaveLength(1);
    await expect(service.getPublic(slug)).resolves.toBeNull();

    const updated = await service.update(slug, {
      ...body,
      aggregate: {
        ...body.aggregate,
        preparationNotes: ["Updated integration note"],
      },
    });
    expect(updated?.preparationNotes[0]?.text).toBe("Updated integration note");
    expect(updated?.recruitments[0]?.sources).toHaveLength(1);

    const published = await service.publish(slug);
    const publicRead = await service.getPublic(slug);
    expect(published?.visibility).toBe("PUBLISHED");
    expect(published?.publishedAt).toEqual(publishedAt);
    expect(publicRead?.recruitmentStatus).toBe("CLOSED");
    expect(publicRead?.forecast?.confidence).toBe("LOW");
  });
});
