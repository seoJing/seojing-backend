import { createHash } from "node:crypto";
import { z } from "zod";
import type { JobPosting, ReaderProfile } from "./contracts.js";
import { LabError } from "./errors.js";

export const readerProfileSchema = z
  .object({
    criteria: z
      .array(
        z
          .object({
            requirement_id: z.string(),
            checks: z
              .array(
                z
                  .object({
                    facet: z.enum(["role", "method", "result", "basis"]),
                    trigger: z.string().min(1).max(120),
                    sufficient: z.string().min(1).max(160),
                    insufficient: z.string().min(1).max(160),
                  })
                  .strict(),
              )
              .min(1)
              .max(4),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export function validateReaderProfile(
  value: unknown,
  job: JobPosting,
): ReaderProfile {
  const parsed = readerProfileSchema.safeParse(value);
  if (!parsed.success)
    throw new LabError("engine_output_invalid", 503, "reader_profile_invalid");
  const seen = new Set<string>();
  const criteria = parsed.data.criteria.map((item) => {
    const requirement = job.requirements.find(
      (r) => r.id === item.requirement_id,
    );
    if (
      !requirement ||
      requirement.kind === "other" ||
      seen.has(requirement.id) ||
      new Set(item.checks.map((check) => check.facet)).size !==
        item.checks.length
    )
      throw new LabError(
        "engine_output_invalid",
        503,
        "reader_criterion_reference_invalid",
      );
    seen.add(requirement.id);
    return {
      id: `c_${requirement.id}`,
      requirement_id: requirement.id,
      label: requirement.label,
      checks: item.checks,
    };
  });
  if (job.requirements.some((r) => r.kind !== "other" && !seen.has(r.id)))
    throw new LabError(
      "engine_output_invalid",
      503,
      "reader_criterion_missing",
    );
  return {
    version: "reader-profile-v2",
    id: createHash("sha256")
      .update(JSON.stringify({ text: job.text, criteria }))
      .digest("hex")
      .slice(0, 24),
    criteria,
  };
}
