import type {
  CareerActualStatus,
  CareerEmploymentType,
  CareerForecastConfidence,
  CareerSourceRelationship,
  CareerVisibility,
  Prisma,
} from "@prisma/client";

export interface CareerCompanyInput {
  slug: string;
  name: string;
  website?: string;
  summary?: string;
  logoUrl?: string;
}

export interface CareerOpportunityInput {
  slug: string;
  title: string;
  employmentType: CareerEmploymentType;
  actualStatus: CareerActualStatus;
  actualStatusAsOf?: Date;
  location?: string;
  summary: string;
  description?: string;
  applicationUrl?: string;
}

export interface CareerHistoryInput {
  key: string;
  openedOn?: Date;
  closedOn?: Date;
  actualStatus: CareerActualStatus;
  note?: string;
}

export interface CareerForecastInput {
  predictedStatus: CareerActualStatus;
  confidence: CareerForecastConfidence;
  windowStart?: Date;
  windowEnd?: Date;
  rationale: string;
}

export interface CareerSourceInput {
  key: string;
  label: string;
  publisher?: string;
  url: string;
  publishedAt?: Date;
  retrievedAt: Date;
  relationship: CareerSourceRelationship;
  historyKey?: string;
  note?: string;
}

export interface CareerAggregateInput {
  company: CareerCompanyInput;
  opportunity: CareerOpportunityInput;
  history: CareerHistoryInput[];
  forecast?: CareerForecastInput;
  sources: CareerSourceInput[];
}

const careerAggregateInclude = {
  company: true,
  history: { orderBy: [{ openedOn: "desc" }, { key: "asc" }] },
  forecast: true,
  sourceLinks: {
    orderBy: { createdAt: "asc" },
    include: { source: true, recruitmentHistory: true, forecast: true },
  },
} satisfies Prisma.CareerOpportunityInclude;

export type CareerAggregate = Prisma.CareerOpportunityGetPayload<{
  include: typeof careerAggregateInclude;
}>;

export interface CareerListFilter {
  limit?: number;
  company?: string;
  actualStatus?: CareerActualStatus;
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
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 50);
    return this.db.careerOpportunity.findMany({
      where: {
        visibility: "PUBLISHED",
        actualStatus: filter.actualStatus,
        company: filter.company ? { slug: filter.company } : undefined,
      },
      orderBy: [
        { publishedAt: "desc" },
        { updatedAt: "desc" },
        { slug: "asc" },
      ],
      take: limit,
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
      await tx.careerSourceLink.deleteMany({
        where: { opportunityId: current.id },
      });
      await tx.careerRecruitmentHistory.deleteMany({
        where: { opportunityId: current.id },
      });
      await tx.careerForecast.deleteMany({
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
  input: CareerCompanyInput,
) {
  return tx.careerCompany.upsert({
    where: { slug: input.slug },
    create: input,
    update: {
      name: input.name,
      website: input.website,
      summary: input.summary,
      logoUrl: input.logoUrl,
    },
  });
}

async function writeChildren(
  tx: CareerRepositoryTx,
  opportunityId: string,
  input: CareerAggregateInput,
): Promise<void> {
  if (input.history.length > 0) {
    await tx.careerRecruitmentHistory.createMany({
      data: input.history.map((entry) => ({ opportunityId, ...entry })),
    });
  }

  const history = await tx.careerRecruitmentHistory.findMany({
    where: { opportunityId },
    select: { id: true, key: true },
  });
  const historyIds = new Map(history.map((entry) => [entry.key, entry.id]));

  const forecast = input.forecast
    ? await tx.careerForecast.create({
        data: { opportunityId, ...input.forecast },
      })
    : undefined;

  for (const sourceInput of input.sources) {
    const { relationship, historyKey, note, ...source } = sourceInput;
    const persistedSource = await tx.careerSource.upsert({
      where: { key: source.key },
      create: source,
      update: {
        label: source.label,
        publisher: source.publisher,
        url: source.url,
        publishedAt: source.publishedAt,
        retrievedAt: source.retrievedAt,
      },
    });
    await tx.careerSourceLink.create({
      data: {
        opportunityId,
        sourceId: persistedSource.id,
        relationship,
        recruitmentHistoryId:
          relationship === "RECRUITMENT_HISTORY" && historyKey
            ? historyIds.get(historyKey)
            : undefined,
        forecastId: relationship === "FORECAST" ? forecast?.id : undefined,
        note,
      },
    });
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
  if (!aggregate) {
    throw new Error(`Career opportunity disappeared during write: ${id}`);
  }
  return aggregate;
}
