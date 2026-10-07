import { z } from "zod";
import type { ReadmeUploadInput } from "../readme-upload.js";
import { LabError } from "./errors.js";

const documentFields = {
  document_type: z.enum(["resume", "cover_letter"]).default("resume"),
  essay_prompts: z
    .array(z.string().trim().max(1000))
    .max(10)
    .default([])
    .transform((values) => values.filter(Boolean)),
};
type NormalizedContext = {
  document_type: "resume" | "cover_letter";
  essay_prompts: string[];
};
function validContext(value: NormalizedContext): boolean {
  return (
    value.essay_prompts.reduce((total, text) => total + text.length, 0) <=
      6000 &&
    (value.document_type === "cover_letter" || !value.essay_prompts.length)
  );
}

export const labUploadSchema = z
  .object({
    job_text: z.string().trim().min(20).max(6000),
    resume_filename: z.string().min(1).max(120),
    resume_media_type: z.string().max(120),
    resume_base64: z.string().min(1).max(2666672),
    ...documentFields,
  })
  .strict()
  .refine(validContext);

export type LabUploadInput = ReadmeUploadInput & {
  document_type?: "resume" | "cover_letter";
  essay_prompts?: string[];
};

const contextSchema = z.object(documentFields).refine(validContext);

/** Snapshot before hashing/queuing; external context never enters the parser. */
export function normalizeLabInput(input: LabUploadInput) {
  const context = contextSchema.safeParse(input);
  if (!context.success) throw new LabError("invalid_input", 400);
  const source: ReadmeUploadInput = {
    job_text: input.job_text,
    resume_filename: input.resume_filename,
    resume_media_type: input.resume_media_type,
    resume_base64: input.resume_base64,
  };
  return { source, ...context.data };
}
