import { z } from "zod";

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4000"),
  CORS_ORIGIN: z.string().default("http://localhost:5173,https://seojing.com"),
  ADMIN_API_TOKEN: z.string().min(1).optional(),
  PYTHON_WORKER_BASE_URL: z.string().url().default("http://127.0.0.1:4037"),
  PYTHON_WORKER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PYTHON_WORKER_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(1),
  PYTHON_WORKER_ENABLED: envBoolean.default(false),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_OAUTH_CALLBACK_URL: z.string().url().optional(),
  GITHUB_OAUTH_SESSION_SECRET: z.string().min(16).optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(input);
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
