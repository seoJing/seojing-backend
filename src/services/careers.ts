import type { CareerRecruitmentStatus } from "@prisma/client";
import { z } from "zod";

import type {
  CareerAggregate,
  CareerAggregateInput,
  CareerRepository,
} from "../repositories/careers.js";

export const careerRecruitmentStatuses = [
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

const slug = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .transform(normalizeCareerSlug)
  .refine(Boolean, "A valid slug is required");
const short = z.string().trim().min(1).max(240);
const text = z.string().trim().min(1).max(2000);
const uuid = z.string().uuid();
const publicUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine(
    isSafePublicUrl,
    "Only public HTTP(S) URLs without credentials are allowed",
  );
const dateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

const sourceSchema = z.object({
  id: uuid.optional(),
  type: short,
  title: short,
  url: publicUrl,
  publisher: short.nullish().transform((value) => value ?? undefined),
  publishedAt: dateTime.nullish().transform((value) => value ?? undefined),
  accessedAt: dateTime,
});

const recruitmentSchema = z
  .object({
    id: uuid.optional(),
    year: z.number().int().min(2000).max(2200),
    title: short,
    openDate: dateOnly.nullish().transform((value) => value ?? undefined),
    closeDate: dateOnly.nullish().transform((value) => value ?? undefined),
    employmentType: z
      .enum(careerEmploymentTypes)
      .nullish()
      .transform((value) => value ?? undefined),
    eligibility: z.array(text).max(50).default([]),
    process: z
      .array(
        z.object({ order: z.number().int().min(1), type: short, label: short }),
      )
      .max(50)
      .default([]),
    sources: z.array(sourceSchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    if (value.openDate && value.closeDate && value.closeDate < value.openDate)
      context.addIssue({
        code: "custom",
        path: ["closeDate"],
        message: "closeDate must not be earlier than openDate",
      });
    if (
      new Set(value.process.map((step) => step.order)).size !==
      value.process.length
    )
      context.addIssue({
        code: "custom",
        path: ["process"],
        message: "Process order values must be unique",
      });
  });

const aggregateSchema = z
  .object({
    company: z.object({
      slug,
      name: short,
      englishName: short.nullish().transform((value) => value ?? undefined),
      careersUrl: publicUrl.nullish().transform((value) => value ?? undefined),
    }),
    opportunity: z.object({
      slug,
      title: short,
      role: short,
      category: short,
      recruitmentStatus: z.enum(careerRecruitmentStatuses),
      actualStatusAsOf: dateTime
        .nullish()
        .transform((value) => value ?? undefined),
    }),
    forecast: z
      .object({
        expectedOpenFrom: dateOnly
          .nullish()
          .transform((value) => value ?? undefined),
        expectedOpenTo: dateOnly
          .nullish()
          .transform((value) => value ?? undefined),
        confidence: z.enum(careerForecastConfidences),
        reasons: z.array(text).min(1).max(50),
        basedOnRecruitmentCount: z.number().int().min(0),
        methodVersion: short,
        analyzedAt: dateTime,
        sources: z.array(sourceSchema).min(1).max(50),
      })
      .superRefine((value, context) => {
        if (
          value.expectedOpenFrom &&
          value.expectedOpenTo &&
          value.expectedOpenTo < value.expectedOpenFrom
        )
          context.addIssue({
            code: "custom",
            path: ["expectedOpenTo"],
            message: "expectedOpenTo must not be earlier than expectedOpenFrom",
          });
      })
      .optional()
      .nullable()
      .transform((value) => value ?? undefined),
    recruitments: z.array(recruitmentSchema).max(100).default([]),
    preparationNotes: z.array(text).max(100).default([]),
    statusSources: z.array(sourceSchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    const recruitmentIds = value.recruitments
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));
    if (new Set(recruitmentIds).size !== recruitmentIds.length)
      context.addIssue({
        code: "custom",
        path: ["recruitments"],
        message: "Recruitment ids must be unique within an aggregate",
      });
  });

export const careerAdminBodySchema = z.object({
  aggregate: aggregateSchema,
  metadata: z
    .object({
      visibility: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),
      publishedAt: dateTime.optional().nullable(),
      createdAt: dateTime,
      updatedAt: dateTime,
    })
    .optional(),
});

export type CareerAdminRequest = z.input<typeof careerAdminBodySchema>;

export interface CareerListInput {
  limit?: number;
  company?: string;
  recruitmentStatus?: CareerRecruitmentStatus;
}

export class CareerService {
  constructor(
    private readonly repository: CareerRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listPublic(input: CareerListInput = {}): Promise<CareerAggregate[]> {
    return this.repository.listPublished({
      ...input,
      company: input.company ? normalizeCareerSlug(input.company) : undefined,
    });
  }
  async getPublic(slugValue: string) {
    return this.repository.findPublishedBySlug(normalizeCareerSlug(slugValue));
  }
  async getAdmin(slugValue: string) {
    return this.repository.findBySlug(normalizeCareerSlug(slugValue));
  }

  async create(input: unknown): Promise<CareerAggregate> {
    const parsed = parseAdminBody(input);
    if (await this.repository.findBySlug(parsed.opportunity.slug))
      throw new CareerConflictError(
        `Career opportunity slug already exists: ${parsed.opportunity.slug}`,
      );
    return this.repository.createAggregate(parsed);
  }

  async update(
    slugValue: string,
    input: unknown,
  ): Promise<CareerAggregate | null> {
    const normalized = normalizeCareerSlug(slugValue);
    const parsed = parseAdminBody(input);
    if (parsed.opportunity.slug !== normalized)
      throw new CareerValidationError([
        {
          path: "aggregate.opportunity.slug",
          message: "Opportunity slug must match the route slug",
        },
      ]);
    return this.repository.replaceAggregate(normalized, parsed);
  }

  async publish(slugValue: string): Promise<CareerAggregate | null> {
    const normalized = normalizeCareerSlug(slugValue);
    const aggregate = await this.repository.findBySlug(normalized);
    if (!aggregate) return null;
    const issues: Array<{ path: string; message: string }> = [];
    if (!aggregate.actualStatusAsOf)
      issues.push({
        path: "aggregate.opportunity.actualStatusAsOf",
        message: "Publishing requires an actual-status observation timestamp",
      });
    if (!aggregate.statusSources.length)
      issues.push({
        path: "aggregate.statusSources",
        message: "Publishing requires an actual-status source",
      });
    if (issues.length) throw new CareerValidationError(issues);
    return this.repository.publish(normalized, this.now());
  }
}

function parseAdminBody(input: unknown): CareerAggregateInput {
  const result = careerAdminBodySchema.safeParse(input);
  if (!result.success)
    throw new CareerValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  return result.data.aggregate;
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
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
