import { describe, expect, it } from "vitest";

import { loadEnv, parseCorsOrigins } from "../src/config/env.js";

describe("env config", () => {
  it("parses required runtime config", () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://user:password@localhost:5432/seojing_backend",
      CORS_ORIGIN: "https://seojing.com,http://localhost:5173",
    });

    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_URL).toContain("seojing_backend");
    expect(parseCorsOrigins(env.CORS_ORIGIN)).toEqual([
      "https://seojing.com",
      "http://localhost:5173",
    ]);
  });
});
