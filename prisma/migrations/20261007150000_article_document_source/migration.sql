ALTER TYPE "article_source_format" ADD VALUE IF NOT EXISTS 'DOCUMENT';

ALTER TABLE "articles"
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "cover" JSONB,
  ADD COLUMN "display_date" TIMESTAMP(3),
  ADD COLUMN "summary_video" JSONB,
  ADD COLUMN "display_updated_at" TIMESTAMP(3);

ALTER TABLE "article_revisions"
  ADD COLUMN "document" JSONB,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "cover" JSONB,
  ADD COLUMN "display_date" TIMESTAMP(3),
  ADD COLUMN "summary_video" JSONB,
  ADD COLUMN "display_updated_at" TIMESTAMP(3);
