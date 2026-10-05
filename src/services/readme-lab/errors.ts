export class LabError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 422,
    public readonly validationReason?: string,
    public readonly validationDetails?: unknown,
  ) {
    super(code);
  }
}
export function errorCode(error: unknown): string {
  if (error instanceof LabError) return error.code;
  return "engine_unavailable";
}

const preparationReasons = new Set([
  "profile_schema_invalid",
  "profile_quote_missing",
  "profile_quote_duplicate",
  "reader_profile_invalid",
  "reader_criterion_reference_invalid",
  "reader_criterion_missing",
  "profile_semantic_review_failed",
]);
/** Only fixed codes may cross into logs, never model issues or source text. */
export function preparationFailureReason(error: unknown): string {
  if (error instanceof LabError) {
    if (
      error.validationReason &&
      preparationReasons.has(error.validationReason)
    )
      return error.validationReason;
    if (
      [
        "engine_timeout",
        "engine_unavailable",
        "engine_output_invalid",
        "cancelled",
      ].includes(error.code)
    )
      return error.code;
  }
  return "preparation_failed";
}
