import { createHash } from "node:crypto";
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

describe("Career applied history and forward compatibility (static, no database)", () => {
  const root = resolve("prisma/migrations");
  const original = "20260920020000_career_radar_mvp";
  const prerequisite = "20261020000000_retire_career_radar_legacy_tables";
  const retirement = "20261021000000_retire_career_radar";
  const cleanup = "20261022000000_retire_career_radar_legacy_enums";
  const read = (name: string) =>
    readFileSync(resolve(root, name, "migration.sql"), "utf8");
  const drops = (sql: string, kind: string) =>
    [
      ...sql.matchAll(new RegExp(`DROP ${kind} IF EXISTS "([a-z_]+)"`, "g")),
    ].map((match) => match[1]!);

  it("pins the restored production-applied bytes and the immutable retirement bytes", () => {
    for (const [name, checksum] of [
      [
        original,
        "41cf6c57de4fb7c4cf45a1889bc924b5bf842d9d755ce8f9aad4ec84f64c2f19",
      ],
      [
        retirement,
        "c9f8198ddd2973206de9306471aaeaf7bfa83e527f98f9ec8d62aac9dbae36aa",
      ],
    ] as const) {
      expect(
        createHash("sha256")
          .update(readFileSync(resolve(root, name, "migration.sql")))
          .digest("hex"),
        name,
      ).toBe(checksum);
    }
  });

  it("permits only the exact ordered Career drops in three explicit transactions", () => {
    expect(prerequisite > "20261007150000_article_document_source").toBe(true);
    expect(prerequisite < retirement && retirement < cleanup).toBe(true);
    const expected = [
      [prerequisite, ["career_source_links", "career_recruitment_history"], []],
      [
        retirement,
        [
          "career_recruitment_sources",
          "career_forecast_sources",
          "career_status_sources",
          "career_forecast_reasons",
          "career_preparation_notes",
          "career_eligibility_items",
          "career_process_steps",
          "career_forecasts",
          "career_recruitments",
          "career_opportunities",
          "career_sources",
          "career_companies",
        ],
        [
          "career_forecast_confidence",
          "career_employment_type",
          "career_recruitment_status",
          "career_visibility",
        ],
      ],
      [cleanup, [], ["career_actual_status", "career_source_relationship"]],
    ] as const;
    for (const [name, tables, types] of expected) {
      const statements = read(name)
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean);
      expect(statements, name).toEqual([
        "BEGIN",
        ...tables.map((table) => `DROP TABLE IF EXISTS "${table}"`),
        ...types.map((type) => `DROP TYPE IF EXISTS "${type}"`),
        "COMMIT",
      ]);
    }
  });

  it("covers restored history, FK order and every surviving Prisma table and enum", () => {
    const history = readdirSync(root)
      .filter(
        (name) =>
          name < prerequisite &&
          existsSync(resolve(root, name, "migration.sql")),
      )
      .sort()
      .map(read)
      .join("\n");
    const sql = [prerequisite, retirement, cleanup].map(read).join("\n");
    const created = (kind: string) =>
      [
        ...history.matchAll(
          new RegExp(`CREATE ${kind} "(career_[a-z_]+)"`, "g"),
        ),
      ].map((match) => match[1]!);
    expect(created("TABLE")).toHaveLength(6);
    expect(created("TYPE")).toHaveLength(5);
    // The immutable retirement also tolerates the later rewritten schema.
    // Keep its extra DROP set explicit; do not silently accept arbitrary names.
    expect(
      drops(sql, "TABLE")
        .filter((name) => !created("TABLE").includes(name))
        .sort(),
    ).toEqual([
      "career_eligibility_items",
      "career_forecast_reasons",
      "career_forecast_sources",
      "career_preparation_notes",
      "career_process_steps",
      "career_recruitment_sources",
      "career_recruitments",
      "career_status_sources",
    ]);
    expect(
      drops(sql, "TYPE").filter((name) => !created("TYPE").includes(name)),
    ).toEqual(["career_recruitment_status"]);
    for (const kind of ["TABLE", "TYPE"]) {
      expect(
        drops(sql, kind)
          .filter((name) => created(kind).includes(name))
          .sort(),
      ).toEqual(created(kind).sort());
    }
    const order = drops(sql, "TABLE");
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
    const schema = readFileSync(resolve("prisma/schema.prisma"), "utf8");
    for (const [kind, schemaKind] of [
      ["TABLE", "model"],
      ["TYPE", "enum"],
    ]) {
      const remaining = [
        ...history.matchAll(new RegExp(`CREATE ${kind} "([a-z_]+)"`, "g")),
      ]
        .map((match) => match[1]!)
        .filter((name) => !drops(sql, kind!).includes(name));
      const mapped = [
        ...schema.matchAll(
          new RegExp(
            `${schemaKind} \\w+ \\{[\\s\\S]*?@@map\\("([a-z_]+)"\\)[\\s\\S]*?\\n\\}`,
            "g",
          ),
        ),
      ].map((match) => match[1]!);
      expect(remaining.sort(), kind).toEqual(mapped.sort());
    }
  });
});
