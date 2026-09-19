import type { CareerActualStatus } from "@prisma/client";
import { z } from "zod";

import type {
  CareerAggregate,
  CareerAggregateInput,
  CareerRepository,
} from "../repositories/careers.js";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .transform(normalizeCareerSlug)
  .refine(Boolean, "A valid slug is required");
const shortText = z.string().trim().min(1).max(240);
const optionalShortText = z.string().trim().min(1).max(500).optional();
const publicUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine(
    isSafePublicUrl,
    "Only public HTTP(S) URLs without credentials are allowed",
  );
const optionalPublicUrl = publicUrl.optional();
const dateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const optionalDateTime = dateTime.optional();
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((value) => new Date(`${value}T00:00:00.000Z`));
const optionalDateOnly = dateOnly.optional();

export const careerActualStatuses = [
  "OPEN",
  "CLOSED",
  "UPCOMING",
  "UNKNOWN",
] as const;
export const careerEmploymentTypes = [
  "INTERNSHIP",
  "FULL_TIME",
  "CONTRACT",
  "PART_TIME",
  "OTHER",
] as const;
export const careerForecastConfidences = ["LOW", "MEDIUM", "HIGH"] as const;
export const careerSourceRelationships = [
  "GENERAL",
  "ACTUAL_STATUS",
  "RECRUITMENT_HISTORY",
  "FORECAST",
] as const;

const companySchema = z.object({
  slug: slugSchema,
  name: shortText,
  website: optionalPublicUrl,
  summary: optionalShortText,
  logoUrl: optionalPublicUrl,
});

const opportunitySchema = z.object({
  slug: slugSchema,
  title: shortText,
  employmentType: z.enum(careerEmploymentTypes),
  actualStatus: z.enum(careerActualStatuses),
  actualStatusAsOf: optionalDateTime,
  location: optionalShortText,
  summary: z.string().trim().min(1).max(1000),
  description: z.string().trim().min(1).max(20_000).optional(),
  applicationUrl: optionalPublicUrl,
});

const historySchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    openedOn: optionalDateOnly,
    closedOn: optionalDateOnly,
    actualStatus: z.enum(careerActualStatuses),
    note: optionalShortText,
  })
  .refine(
    (entry) =>
      !entry.openedOn || !entry.closedOn || entry.closedOn >= entry.openedOn,
    { message: "closedOn must not be earlier than openedOn" },
  );

const forecastSchema = z
  .object({
    predictedStatus: z.enum(careerActualStatuses),
    confidence: z.enum(careerForecastConfidences),
    windowStart: optionalDateOnly,
    windowEnd: optionalDateOnly,
    rationale: z.string().trim().min(1).max(2000),
  })
  .refine(
    (forecast) =>
      !forecast.windowStart ||
      !forecast.windowEnd ||
      forecast.windowEnd >= forecast.windowStart,
    { message: "windowEnd must not be earlier than windowStart" },
  );

const sourceSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: shortText,
  publisher: optionalShortText,
  url: publicUrl,
  publishedAt: optionalDateTime,
  retrievedAt: dateTime,
  relationship: z.enum(careerSourceRelationships),
  historyKey: z.string().trim().min(1).max(120).optional(),
  note: optionalShortText,
});

export const careerAggregateInputSchema = z
  .object({
    company: companySchema,
    opportunity: opportunitySchema,
    history: z.array(historySchema).max(100).default([]),
    forecast: forecastSchema.optional(),
    sources: z.array(sourceSchema).min(1).max(100),
  })
  .superRefine((input, context) => {
    const historyKeys = new Set<string>();
    for (const entry of input.history) {
      if (historyKeys.has(entry.key)) {
        context.addIssue({
          code: "custom",
          path: ["history"],
          message: `Duplicate recruitment history key: ${entry.key}`,
        });
      }
      historyKeys.add(entry.key);
    }

    const sourceKeys = new Set<string>();
    const linkedHistory = new Set<string>();
    let hasActualStatusSource = false;
    let hasForecastSource = false;
    input.sources.forEach((source, index) => {
      if (sourceKeys.has(source.key)) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "key"],
          message: `Duplicate source key: ${source.key}`,
        });
      }
      sourceKeys.add(source.key);

      if (source.relationship === "ACTUAL_STATUS") {
        hasActualStatusSource = true;
      }
      if (source.relationship === "FORECAST") {
        hasForecastSource = true;
        if (!input.forecast) {
          context.addIssue({
            code: "custom",
            path: ["sources", index, "relationship"],
            message: "FORECAST sources require a forecast",
          });
        }
      }
      if (source.relationship === "RECRUITMENT_HISTORY") {
        if (!source.historyKey || !historyKeys.has(source.historyKey)) {
          context.addIssue({
            code: "custom",
            path: ["sources", index, "historyKey"],
            message:
              "RECRUITMENT_HISTORY sources require a matching historyKey",
          });
        } else {
          linkedHistory.add(source.historyKey);
        }
      } else if (source.historyKey) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "historyKey"],
          message: "historyKey is only valid for RECRUITMENT_HISTORY sources",
        });
      }
    });

    if (!hasActualStatusSource) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "At least one ACTUAL_STATUS source is required",
      });
    }
    if (input.forecast && !hasForecastSource) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "A forecast requires at least one FORECAST source",
      });
    }
    for (const key of historyKeys) {
      if (!linkedHistory.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["history"],
          message: `Recruitment history requires an explicit source link: ${key}`,
        });
      }
    }
  });

export type CareerAggregateRequest = z.input<typeof careerAggregateInputSchema>;

export interface CareerListInput {
  limit?: number;
  company?: string;
  actualStatus?: CareerActualStatus;
}

export class CareerService {
  constructor(
    private readonly repository: CareerRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listPublic(input: CareerListInput = {}): Promise<CareerAggregate[]> {
    return this.repository.listPublished({
      limit: input.limit,
      company: input.company ? normalizeCareerSlug(input.company) : undefined,
      actualStatus: input.actualStatus,
    });
  }

  async getPublic(slug: string): Promise<CareerAggregate | null> {
    return this.repository.findPublishedBySlug(normalizeCareerSlug(slug));
  }

  async getAdmin(slug: string): Promise<CareerAggregate | null> {
    return this.repository.findBySlug(normalizeCareerSlug(slug));
  }

  async create(input: unknown): Promise<CareerAggregate> {
    const parsed = parseCareerAggregate(input);
    const existing = await this.repository.findBySlug(parsed.opportunity.slug);
    if (existing) {
      throw new CareerConflictError(
        `Career opportunity slug already exists: ${parsed.opportunity.slug}`,
      );
    }
    return this.repository.createAggregate(parsed);
  }

  async update(slug: string, input: unknown): Promise<CareerAggregate | null> {
    const normalizedSlug = normalizeCareerSlug(slug);
    const parsed = parseCareerAggregate(input);
    if (parsed.opportunity.slug !== normalizedSlug) {
      throw new CareerValidationError([
        {
          path: "opportunity.slug",
          message: "Opportunity slug must match the route slug",
        },
      ]);
    }
    return this.repository.replaceAggregate(normalizedSlug, parsed);
  }

  async publish(slug: string): Promise<CareerAggregate | null> {
    const normalizedSlug = normalizeCareerSlug(slug);
    const aggregate = await this.repository.findBySlug(normalizedSlug);
    if (!aggregate) return null;
    validatePublishable(aggregate);
    return this.repository.publish(normalizedSlug, this.now());
  }
}

export class CareerValidationError extends Error {
  constructor(
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super("Career aggregate validation failed");
    this.name = "CareerValidationError";
  }
}

export class CareerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CareerConflictError";
  }
}

function parseCareerAggregate(input: unknown): CareerAggregateInput {
  const result = careerAggregateInputSchema.safeParse(input);
  if (!result.success) {
    throw new CareerValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function validatePublishable(aggregate: CareerAggregate): void {
  const issues: Array<{ path: string; message: string }> = [];
  if (!aggregate.actualStatusAsOf) {
    issues.push({
      path: "opportunity.actualStatusAsOf",
      message: "Publishing requires an actual-status observation timestamp",
    });
  }
  if (
    !aggregate.sourceLinks.some((link) => link.relationship === "ACTUAL_STATUS")
  ) {
    issues.push({
      path: "sources",
      message: "Publishing requires an ACTUAL_STATUS source",
    });
  }
  if (issues.length > 0) throw new CareerValidationError(issues);
}

export function normalizeCareerSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9가-힣_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function isSafePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "::1"
    );
  } catch {
    return false;
  }
}
