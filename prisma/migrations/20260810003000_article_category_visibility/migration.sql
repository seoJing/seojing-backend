-- CMS-native articles need a reader-facing category and reversible visibility states.
ALTER TABLE "articles"
ADD COLUMN "category" TEXT NOT NULL DEFAULT 'SEOJing';

CREATE INDEX "articles_category_status_published_at_idx"
ON "articles"("category", "status", "published_at");
