import type {
  CareerEmploymentType,
  CareerForecastConfidence,
  CareerRecruitmentStatus,
  CareerVisibility,
  Prisma,
} from "@prisma/client";

export interface CareerSourceInput {
  id?: string;
  type: string;
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: Date;
  accessedAt: Date;
}

export interface CareerRecruitmentInput {
  id?: string;
  year: number;
  title: string;
  openDate?: Date;
  closeDate?: Date;
  employmentType?: CareerEmploymentType;
  eligibility: string[];
  process: Array<{ order: number; type: string; label: string }>;
  sources: CareerSourceInput[];
}

export interface CareerAggregateInput {
  company: {
    slug: string;
    name: string;
    englishName?: string;
    careersUrl?: string;
  };
  opportunity: {
    slug: string;
    title: string;
    role: string;
    category: string;
    recruitmentStatus: CareerRecruitmentStatus;
    actualStatusAsOf?: Date;
  };
  forecast?: {
    expectedOpenFrom?: Date;
    expectedOpenTo?: Date;
    confidence: CareerForecastConfidence;
    reasons: string[];
    basedOnRecruitmentCount: number;
    methodVersion: string;
    analyzedAt: Date;
    sources: CareerSourceInput[];
  };
  recruitments: CareerRecruitmentInput[];
  preparationNotes: string[];
  statusSources: CareerSourceInput[];
}

const careerAggregateInclude = {
  company: true,
  recruitments: {
    orderBy: [{ year: "desc" }, { title: "asc" }],
    include: {
      eligibility: { orderBy: { sortOrder: "asc" } },
      process: { orderBy: { order: "asc" } },
      sources: { orderBy: { sortOrder: "asc" }, include: { source: true } },
    },
  },
  forecast: {
    include: {
      reasons: { orderBy: { sortOrder: "asc" } },
      sources: { orderBy: { sortOrder: "asc" }, include: { source: true } },
    },
  },
  preparationNotes: { orderBy: { sortOrder: "asc" } },
  statusSources: {
    orderBy: { sortOrder: "asc" },
    include: { source: true },
  },
} satisfies Prisma.CareerOpportunityInclude;

export type CareerAggregate = Prisma.CareerOpportunityGetPayload<{
  include: typeof careerAggregateInclude;
}>;

export interface CareerListFilter {
  limit?: number;
  company?: string;
  recruitmentStatus?: CareerRecruitmentStatus;
}

type CareerRepositoryTx = Prisma.TransactionClient;
type CareerRepositoryDb = Pick<
  Prisma.TransactionClient,
  "careerOpportunity"
> & {
  $transaction<T>(fn: (tx: CareerRepositoryTx) => Promise<T>): Promise<T>;
};

export class CareerRepository {
  constructor(private readonly db: CareerRepositoryDb) {}

  async listPublished(filter: CareerListFilter): Promise<CareerAggregate[]> {
    return this.db.careerOpportunity.findMany({
      where: {
        visibility: "PUBLISHED",
        recruitmentStatus: filter.recruitmentStatus,
        company: filter.company ? { slug: filter.company } : undefined,
      },
      orderBy: [
        { publishedAt: "desc" },
        { updatedAt: "desc" },
        { slug: "asc" },
      ],
      take: Math.min(Math.max(filter.limit ?? 20, 1), 50),
      include: careerAggregateInclude,
    });
  }

  async findPublishedBySlug(slug: string): Promise<CareerAggregate | null> {
    return this.db.careerOpportunity.findFirst({
      where: { slug, visibility: "PUBLISHED" },
      include: careerAggregateInclude,
    });
  }

  async findBySlug(slug: string): Promise<CareerAggregate | null> {
    return this.db.careerOpportunity.findUnique({
      where: { slug },
      include: careerAggregateInclude,
    });
  }

  async createAggregate(input: CareerAggregateInput): Promise<CareerAggregate> {
    return this.db.$transaction(async (tx) => {
      const company = await upsertCompany(tx, input.company);
      const opportunity = await tx.careerOpportunity.create({
        data: {
          companyId: company.id,
          ...input.opportunity,
          visibility: "DRAFT",
        },
      });
      await writeChildren(tx, opportunity.id, input);
      return readAggregate(tx, opportunity.id);
    });
  }

  async replaceAggregate(
    slug: string,
    input: CareerAggregateInput,
  ): Promise<CareerAggregate | null> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.careerOpportunity.findUnique({
        where: { slug },
      });
      if (!current) return null;
      const company = await upsertCompany(tx, input.company);
      await tx.careerStatusSource.deleteMany({
        where: { opportunityId: current.id },
      });
      await tx.careerRecruitment.deleteMany({
        where: { opportunityId: current.id },
      });
      await tx.careerForecast.deleteMany({
        where: { opportunityId: current.id },
      });
      await tx.careerPreparationNote.deleteMany({
        where: { opportunityId: current.id },
      });
      await tx.careerOpportunity.update({
        where: { id: current.id },
        data: {
          companyId: company.id,
          ...input.opportunity,
          visibility: current.visibility,
          publishedAt: current.publishedAt,
        },
      });
      await writeChildren(tx, current.id, input);
      return readAggregate(tx, current.id);
    });
  }

  async publish(
    slug: string,
    publishedAt: Date,
  ): Promise<CareerAggregate | null> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.careerOpportunity.findUnique({
        where: { slug },
      });
      if (!current) return null;
      await tx.careerOpportunity.update({
        where: { id: current.id },
        data: {
          visibility: "PUBLISHED" satisfies CareerVisibility,
          publishedAt: current.publishedAt ?? publishedAt,
        },
      });
      return readAggregate(tx, current.id);
    });
  }
}

async function upsertCompany(
  tx: CareerRepositoryTx,
  input: CareerAggregateInput["company"],
) {
  return tx.careerCompany.upsert({
    where: { slug: input.slug },
    create: input,
    update: {
      name: input.name,
      englishName: input.englishName,
      careersUrl: input.careersUrl,
    },
  });
}

async function createSource(tx: CareerRepositoryTx, input: CareerSourceInput) {
  const data = {
    type: input.type,
    title: input.title,
    url: input.url,
    publisher: input.publisher,
    publishedAt: input.publishedAt,
    accessedAt: input.accessedAt,
  };
  return input.id
    ? tx.careerSource.upsert({
        where: { id: input.id },
        create: { id: input.id, ...data },
        update: data,
      })
    : tx.careerSource.create({ data });
}

async function writeChildren(
  tx: CareerRepositoryTx,
  opportunityId: string,
  input: CareerAggregateInput,
): Promise<void> {
  for (const [index, note] of input.preparationNotes.entries()) {
    await tx.careerPreparationNote.create({
      data: { opportunityId, sortOrder: index, text: note },
    });
  }
  for (const [index, sourceInput] of input.statusSources.entries()) {
    const source = await createSource(tx, sourceInput);
    await tx.careerStatusSource.create({
      data: { opportunityId, sourceId: source.id, sortOrder: index },
    });
  }
  for (const recruitmentInput of input.recruitments) {
    const { id, eligibility, process, sources, ...recruitmentData } =
      recruitmentInput;
    const recruitment = await tx.careerRecruitment.create({
      data: { ...(id ? { id } : {}), opportunityId, ...recruitmentData },
    });
    if (eligibility.length)
      await tx.careerEligibilityItem.createMany({
        data: eligibility.map((text, sortOrder) => ({
          recruitmentId: recruitment.id,
          sortOrder,
          text,
        })),
      });
    if (process.length)
      await tx.careerProcessStep.createMany({
        data: process.map((step) => ({
          recruitmentId: recruitment.id,
          ...step,
        })),
      });
    for (const [sortOrder, sourceInput] of sources.entries()) {
      const source = await createSource(tx, sourceInput);
      await tx.careerRecruitmentSource.create({
        data: { recruitmentId: recruitment.id, sourceId: source.id, sortOrder },
      });
    }
  }
  if (input.forecast) {
    const { reasons, sources, ...forecastData } = input.forecast;
    const forecast = await tx.careerForecast.create({
      data: { opportunityId, ...forecastData },
    });
    if (reasons.length)
      await tx.careerForecastReason.createMany({
        data: reasons.map((text, sortOrder) => ({
          forecastId: forecast.id,
          sortOrder,
          text,
        })),
      });
    for (const [sortOrder, sourceInput] of sources.entries()) {
      const source = await createSource(tx, sourceInput);
      await tx.careerForecastSource.create({
        data: { forecastId: forecast.id, sourceId: source.id, sortOrder },
      });
    }
  }
}

async function readAggregate(
  tx: CareerRepositoryTx,
  id: string,
): Promise<CareerAggregate> {
  const aggregate = await tx.careerOpportunity.findUnique({
    where: { id },
    include: careerAggregateInclude,
  });
  if (!aggregate)
    throw new Error(`Career opportunity disappeared during write: ${id}`);
  return aggregate;
}
