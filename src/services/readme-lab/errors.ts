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
