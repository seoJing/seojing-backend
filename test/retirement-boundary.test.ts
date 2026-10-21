import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ArticleService } from "../src/services/articles.js";

const retiredRoutes = [
  ["GET", "/career/opportunities"],
  ["GET", "/career/opportunities/example"],
  ["POST", "/admin/career/opportunities"],
  ["GET", "/admin/career/opportunities/example"],
  ["PUT", "/admin/career/opportunities/example"],
  ["POST", "/admin/career/opportunities/example/publish"],
  ["GET", "/careers"],
  ["GET", "/careers/example"],
  ["GET", "/career"],
  ["GET", "/admin/careers"],
  ["POST", "/admin/careers"],
  ["PATCH", "/admin/careers/example"],
  ["POST", "/articles/study%2Fbackend%2Fday1/qa"],
  ["GET", "/tts/summary"],
  ["GET", "/tts/jobs"],
  ["POST", "/tts/jobs"],
  ["GET", "/tts/jobs/example"],
  ["GET", "/tts/audio/example"],
  ["GET", "/auth/github/start"],
  ["POST", "/auth/github/callback"],
  ["GET", "/articles/study%2Fbackend%2Fday1/comments"],
  ["POST", "/articles/study%2Fbackend%2Fday1/comments"],
  ["PATCH", "/admin/comments/example/status"],
] as const;

describe("post-management retirement boundary", () => {
  it("returns 404 for retired routes and retains public articles and protected management", async () => {
    const listPublicArticles = vi.fn().mockResolvedValue([]);
    const app = await buildApp({
      adminToken: "retention-test-token",
      articleService: {
        listPublicArticles,
        getPublicArticleBySlug: vi.fn().mockResolvedValue(null),
      } as unknown as ArticleService,
    });
    try {
      for (const [method, url] of retiredRoutes) {
        const response = await app.inject({
          method,
          url,
          headers: { authorization: "Bearer retention-test-token" },
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await app.inject("/articles")).statusCode).toBe(200);
      expect(listPublicArticles).toHaveBeenCalledOnce();
      expect((await app.inject("/admin/articles")).statusCode).toBe(401);
      const response = await app.inject("/openapi.json");
      const { paths } = response.json<{ paths: Record<string, unknown> }>();
      expect(Object.keys(paths).join("\n")).not.toMatch(
        /career|\/tts|\/qa(?:\/|$)|comments|\/auth\/github|community/i,
      );
      for (const route of [
        "/articles",
        "/articles/{slug}",
        "/admin/articles",
        "/admin/articles/{slug}/public-snapshot",
        "/admin/articles/{slug}/migration-snapshot",
      ]) {
        expect(paths, route).toHaveProperty(route);
      }
    } finally {
      await app.close();
    }
  });

  it("keeps retired modules absent, with MDX/native-document conversion contracts intact", () => {
    for (const path of [
      "src/routes/careers.ts",
      "src/services/careers.ts",
      "src/repositories/careers.ts",
      "src/routes/article-qa.ts",
      "src/services/article-qa.ts",
      "src/routes/tts.ts",
      "src/services/tts.ts",
      "src/routes/community.ts",
      "src/services/community.ts",
      "src/repositories/community.ts",
      "src/services/github-oauth.ts",
    ])
      expect(existsSync(resolve(path)), path).toBe(false);
    for (const path of [
      "scripts/convert-mdx-articles-to-documents.ts",
      "scripts/import-mdx-drafts.ts",
      "scripts/ingest-mdx.ts",
      "src/services/mdx-ingest.ts",
      "src/services/mdx-to-document.ts",
      "src/services/mdx-editor-renderer.ts",
      "src/services/article-document.ts",
      "src/routes/admin-writing.ts",
      "src/repositories/articles.ts",
    ])
      expect(existsSync(resolve(path)), path).toBe(true);
    const schema = readFileSync(resolve("prisma/schema.prisma"), "utf8");
    expect(schema).not.toMatch(/career/i);
    for (const model of [
      "Article",
      "ArticleRevision",
      "ArticleBlock",
      "ArticleAsset",
      "User",
      "ArticleComment",
    ]) {
      expect(schema).toMatch(new RegExp(`model ${model} \\{`));
    }
    expect(schema).toMatch(
      /enum ArticleSourceFormat\s*\{\s*MDX\s+BLOCKS\s+DOCUMENT/,
    );
    expect(schema).toMatch(/\bRAW_MDX\b/);
    expect(schema.match(/sourceText\s+String/g)).toHaveLength(2);
    expect(schema).toMatch(/document\s+Json\?/);
  });
});

describe("forward-only Career Prisma migration (static, no database)", () => {
  it("drops exactly the historical Career objects, children first, and no retained object", () => {
    const root = resolve("prisma/migrations");
    const migration = "20261021000000_retire_career_radar";
    const history = readdirSync(root)
      .filter(
        (name) =>
          name < migration && existsSync(resolve(root, name, "migration.sql")),
      )
      .sort()
      .map((name) => readFileSync(resolve(root, name, "migration.sql"), "utf8"))
      .join("\n");
    const sql = readFileSync(
      resolve(root, migration, "migration.sql"),
      "utf8",
    ).replace(/--[^\n]*/g, "");
    const statements = sql
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(
      statements
        .slice(1, -1)
        .every((value) =>
          /^DROP (TABLE|TYPE) IF EXISTS "career_[a-z_]+"$/.test(value),
        ),
    ).toBe(true);
    const created = (kind: string) =>
      [
        ...history.matchAll(
          new RegExp(`CREATE ${kind} "(career_[a-z_]+)"`, "g"),
        ),
      ].map((match) => match[1]!);
    const dropped = (kind: string) =>
      [
        ...sql.matchAll(new RegExp(`DROP ${kind} IF EXISTS "([a-z_]+)"`, "g")),
      ].map((match) => match[1]!);
    expect(created("TABLE")).toHaveLength(12);
    expect(created("TYPE")).toHaveLength(4);
    expect(dropped("TABLE").sort()).toEqual(created("TABLE").sort());
    expect(dropped("TYPE").sort()).toEqual(created("TYPE").sort());
    const order = dropped("TABLE");
    for (const [, child, parent] of history.matchAll(
      /ALTER TABLE "([a-z_]+)" ADD CONSTRAINT [^;]+ REFERENCES "([a-z_]+)"/g,
    )) {
      if (order.includes(parent!)) {
        expect(order, `${child} must not survive ${parent}`).toContain(child);
        expect(order.indexOf(child!), `${child} before ${parent}`).toBeLessThan(
          order.indexOf(parent!),
        );
      }
    }
    expect(sql.indexOf("DROP TYPE")).toBeGreaterThan(
      sql.lastIndexOf("DROP TABLE"),
    );
    const remainingTables = [...history.matchAll(/CREATE TABLE "([a-z_]+)"/g)]
      .map((match) => match[1]!)
      .filter((name) => !order.includes(name));
    const schema = readFileSync(resolve("prisma/schema.prisma"), "utf8");
    const schemaTables = [
      ...schema.matchAll(
        /model \w+ \{[\s\S]*?@@map\("([a-z_]+)"\)[\s\S]*?\n\}/g,
      ),
    ].map((match) => match[1]!);
    expect(remainingTables.sort()).toEqual(schemaTables.sort());
    const remainingTypes = [...history.matchAll(/CREATE TYPE "([a-z_]+)"/g)]
      .map((match) => match[1]!)
      .filter((name) => !dropped("TYPE").includes(name));
    const schemaTypes = [
      ...schema.matchAll(
        /enum \w+ \{[\s\S]*?@@map\("([a-z_]+)"\)[\s\S]*?\n\}/g,
      ),
    ].map((match) => match[1]!);
    expect(remainingTypes.sort()).toEqual(schemaTypes.sort());
  });
});
