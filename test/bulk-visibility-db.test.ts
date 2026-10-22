import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ArticleRepository } from "../src/repositories/articles.js";
import { ArticleService } from "../src/services/articles.js";

// Opt-in, disposable loopback database only. Never use the production URL.
const enabled = process.env.RUN_BULK_DB_TESTS === "true";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.pathname.startsWith("/cms_test_")
  )
    throw new Error(
      "Bulk integration requires a disposable loopback cms_test_* database",
    );
}
const integration = enabled ? describe : describe.skip;
integration("bulk publication with real PostgreSQL transactions", () => {
  const db = new PrismaClient();
  const service = new ArticleService(new ArticleRepository(db));
  let app: Awaited<ReturnType<typeof buildApp>>;
  const slugs = ["bulk-test/valid", "bulk-test/rollback", "bulk-test/other"];
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Disposable integration content" }],
      },
    ],
  };
  beforeAll(async () => {
    await db.article.deleteMany({ where: { slug: { in: slugs } } });
    for (const slug of slugs)
      await service.createDocumentDraft({
        slug,
        title: slug,
        category: slug.endsWith("other") ? "Other" : "Study",
        document: doc,
      });
    app = await buildApp({
      articleService: service,
      adminToken: "local-test-only",
    });
    // An actual SQL failure inside the publication transaction must roll back.
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION fail_bulk_test_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.slug = 'bulk-test/rollback' AND NEW.status = 'PUBLISHED' THEN RAISE EXCEPTION 'disposable injected failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER bulk_test_failure BEFORE UPDATE ON "articles" FOR EACH ROW EXECUTE FUNCTION fail_bulk_test_publish()`,
    );
  });
  afterAll(async () => {
    await db.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS bulk_test_failure ON "articles"',
    );
    await db.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS fail_bulk_test_publish()",
    );
    await db.article.deleteMany({ where: { slug: { in: slugs } } });
    await app?.close();
    await db.$disconnect();
  });
  it("publishes allowed items, rejects hidden scope, rolls back one SQL failure, then unpublishes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/articles/bulk-visibility",
      headers: { authorization: "Bearer local-test-only" },
      payload: { action: "publish", slugs, scope: { category: "Study" } },
    });
    expect(response.json()).toMatchObject({
      ok: false,
      results: [
        { slug: slugs[0], ok: true, status: "PUBLISHED" },
        { slug: slugs[1], ok: false },
        { slug: slugs[2], ok: false, error: "article_outside_scope" },
      ],
    });
    expect(
      (await db.article.findUniqueOrThrow({ where: { slug: slugs[1] } }))
        .status,
    ).toBe("DRAFT");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/articles/${encodeURIComponent(slugs[0]!)}`,
        })
      ).statusCode,
    ).toBe(200);
    const stale = await db.article.findUniqueOrThrow({
      where: { slug: slugs[0] },
    });
    await db.article.update({
      where: { id: stale.id },
      data: {
        updatedAt: new Date(stale.updatedAt.getTime() + 1_000),
        title: "Concurrent change",
      },
    });
    await expect(
      service.unpublishArticle(slugs[0]!, stale.updatedAt),
    ).rejects.toThrow();
    expect(
      (await db.article.findUniqueOrThrow({ where: { id: stale.id } })).status,
    ).toBe("PUBLISHED");
    const hidden = await app.inject({
      method: "POST",
      url: "/admin/articles/bulk-visibility",
      headers: { authorization: "Bearer local-test-only" },
      payload: {
        action: "unpublish",
        slugs: [slugs[0]],
        scope: { category: "Study", status: "PUBLISHED" },
      },
    });
    expect(hidden.json()).toMatchObject({
      ok: true,
      results: [{ ok: true, status: "DRAFT" }],
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/articles/${encodeURIComponent(slugs[0]!)}`,
        })
      ).statusCode,
    ).toBe(404);
  });
});
