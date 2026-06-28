import { buildApp } from "./app.js";
import { loadEnv, parseCorsOrigins } from "./config/env.js";

const env = loadEnv();
const app = await buildApp({
  logger: env.LOG_LEVEL !== "silent",
  corsOrigins: parseCorsOrigins(env.CORS_ORIGIN),
  adminToken:
    env.ADMIN_API_TOKEN ??
    (env.NODE_ENV === "production" ? "__missing-admin-api-token__" : undefined),
  communitySessionSecret: env.GITHUB_OAUTH_SESSION_SECRET,
  githubOAuth:
    env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET
      ? {
          clientId: env.GITHUB_OAUTH_CLIENT_ID,
          clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
          callbackUrl: env.GITHUB_OAUTH_CALLBACK_URL,
        }
      : undefined,
});

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
