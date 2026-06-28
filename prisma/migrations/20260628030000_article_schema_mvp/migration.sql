-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "article_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "article_source_format" AS ENUM ('MDX', 'BLOCKS');

-- CreateEnum
CREATE TYPE "article_block_type" AS ENUM ('PARAGRAPH', 'HEADING', 'IMAGE', 'CODE', 'QUOTE', 'CALLOUT', 'QUIZ', 'RAW_MDX');

-- CreateEnum
CREATE TYPE "article_asset_kind" AS ENUM ('COVER', 'INLINE_IMAGE', 'AUDIO', 'VIDEO', 'DOWNLOAD', 'OTHER');

-- CreateTable
CREATE TABLE "articles" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "article_status" NOT NULL DEFAULT 'DRAFT',
    "source_format" "article_source_format" NOT NULL DEFAULT 'MDX',
    "source_text" TEXT NOT NULL,
    "rendered_html" TEXT,
    "current_revision_id" UUID,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_revisions" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "source_format" "article_source_format" NOT NULL,
    "source_text" TEXT NOT NULL,
    "rendered_html" TEXT,
    "change_summary" TEXT,
    "author_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_blocks" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "type" "article_block_type" NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "plain_text" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "article_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_assets" (
    "id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "revision_id" UUID,
    "block_id" UUID,
    "kind" "article_asset_kind" NOT NULL,
    "url" TEXT NOT NULL,
    "storage_key" TEXT,
    "alt_text" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "articles_slug_key" ON "articles"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "articles_current_revision_id_key" ON "articles"("current_revision_id");

-- CreateIndex
CREATE INDEX "articles_status_published_at_idx" ON "articles"("status", "published_at");

-- CreateIndex
CREATE INDEX "article_revisions_article_id_created_at_idx" ON "article_revisions"("article_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "article_revisions_article_id_revision_number_key" ON "article_revisions"("article_id", "revision_number");

-- CreateIndex
CREATE INDEX "article_blocks_article_id_sort_order_idx" ON "article_blocks"("article_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "article_blocks_revision_id_sort_order_key" ON "article_blocks"("revision_id", "sort_order");

-- CreateIndex
CREATE INDEX "article_assets_article_id_kind_idx" ON "article_assets"("article_id", "kind");

-- CreateIndex
CREATE INDEX "article_assets_revision_id_idx" ON "article_assets"("revision_id");

-- CreateIndex
CREATE INDEX "article_assets_block_id_idx" ON "article_assets"("block_id");

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "article_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_blocks" ADD CONSTRAINT "article_blocks_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_blocks" ADD CONSTRAINT "article_blocks_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "article_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_assets" ADD CONSTRAINT "article_assets_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_assets" ADD CONSTRAINT "article_assets_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "article_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_assets" ADD CONSTRAINT "article_assets_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "article_blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
