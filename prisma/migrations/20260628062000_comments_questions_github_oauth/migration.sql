-- GitHub-backed reader identity and moderated article comments/questions.

CREATE TYPE "user_role" AS ENUM ('READER', 'MODERATOR', 'ADMIN');
CREATE TYPE "comment_kind" AS ENUM ('COMMENT', 'QUESTION');
CREATE TYPE "comment_status" AS ENUM ('PENDING', 'VISIBLE', 'HIDDEN');

CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "github_id" TEXT NOT NULL,
    "github_login" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "profile_url" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'READER',
    "last_authenticated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "article_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "article_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "parent_id" UUID,
    "kind" "comment_kind" NOT NULL DEFAULT 'COMMENT',
    "status" "comment_status" NOT NULL DEFAULT 'PENDING',
    "section_id" TEXT,
    "body" TEXT NOT NULL,
    "moderation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "article_comments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");
CREATE UNIQUE INDEX "users_github_login_key" ON "users"("github_login");
CREATE INDEX "users_github_login_idx" ON "users"("github_login");
CREATE INDEX "article_comments_article_id_status_kind_created_at_idx" ON "article_comments"("article_id", "status", "kind", "created_at");
CREATE INDEX "article_comments_article_id_section_id_status_idx" ON "article_comments"("article_id", "section_id", "status");
CREATE INDEX "article_comments_author_id_created_at_idx" ON "article_comments"("author_id", "created_at");
CREATE INDEX "article_comments_parent_id_idx" ON "article_comments"("parent_id");

ALTER TABLE "article_comments" ADD CONSTRAINT "article_comments_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "article_comments" ADD CONSTRAINT "article_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "article_comments" ADD CONSTRAINT "article_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "article_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
