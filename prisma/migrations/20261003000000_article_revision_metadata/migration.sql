ALTER TABLE "article_revisions"
  ADD COLUMN "title" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "category" TEXT;

UPDATE "article_revisions" AS revision
SET "title" = article."title",
    "description" = article."description",
    "category" = article."category"
FROM "articles" AS article
WHERE revision."article_id" = article."id"
  AND article."current_revision_id" = revision."id";
