import { buildApp } from "./app.js";
import { loadEnv, parseCorsOrigins } from "./config/env.js";

const env = loadEnv();
const app = await buildApp({
  logger: env.LOG_LEVEL !== "silent",
  corsOrigins: parseCorsOrigins(env.CORS_ORIGIN),
});

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
