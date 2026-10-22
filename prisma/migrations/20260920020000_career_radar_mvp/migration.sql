CREATE TYPE "career_visibility" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "career_actual_status" AS ENUM ('OPEN', 'CLOSED', 'UPCOMING', 'UNKNOWN');
CREATE TYPE "career_employment_type" AS ENUM ('INTERNSHIP', 'FULL_TIME', 'CONTRACT', 'PART_TIME', 'OTHER');
CREATE TYPE "career_forecast_confidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "career_source_relationship" AS ENUM ('GENERAL', 'ACTUAL_STATUS', 'RECRUITMENT_HISTORY', 'FORECAST');

CREATE TABLE "career_companies" (
  "id" UUID NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "website" TEXT,
  "summary" TEXT,
  "logo_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_companies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "career_opportunities" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "employment_type" "career_employment_type" NOT NULL,
  "actual_status" "career_actual_status" NOT NULL DEFAULT 'UNKNOWN',
  "actual_status_as_of" TIMESTAMP(3),
  "location" TEXT,
  "summary" TEXT NOT NULL,
  "description" TEXT,
  "application_url" TEXT,
  "visibility" "career_visibility" NOT NULL DEFAULT 'DRAFT',
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_opportunities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "career_recruitment_history" (
  "id" UUID NOT NULL,
  "opportunity_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "opened_on" DATE,
  "closed_on" DATE,
  "actual_status" "career_actual_status" NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_recruitment_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "career_forecasts" (
  "id" UUID NOT NULL,
  "opportunity_id" UUID NOT NULL,
  "predicted_status" "career_actual_status" NOT NULL,
  "confidence" "career_forecast_confidence" NOT NULL,
  "window_start" DATE,
  "window_end" DATE,
  "rationale" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_forecasts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "career_sources" (
  "id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "publisher" TEXT,
  "url" TEXT NOT NULL,
  "published_at" TIMESTAMP(3),
  "retrieved_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "career_source_links" (
  "id" UUID NOT NULL,
  "opportunity_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "recruitment_history_id" UUID,
  "forecast_id" UUID,
  "relationship" "career_source_relationship" NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "career_source_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "career_source_links_target_check" CHECK (
    ("relationship" = 'RECRUITMENT_HISTORY' AND "recruitment_history_id" IS NOT NULL AND "forecast_id" IS NULL)
    OR ("relationship" = 'FORECAST' AND "forecast_id" IS NOT NULL AND "recruitment_history_id" IS NULL)
    OR ("relationship" IN ('GENERAL', 'ACTUAL_STATUS') AND "recruitment_history_id" IS NULL AND "forecast_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "career_companies_slug_key" ON "career_companies"("slug");
CREATE UNIQUE INDEX "career_opportunities_slug_key" ON "career_opportunities"("slug");
CREATE INDEX "career_opportunities_visibility_published_at_idx" ON "career_opportunities"("visibility", "published_at");
CREATE INDEX "career_opportunities_company_id_actual_status_idx" ON "career_opportunities"("company_id", "actual_status");
CREATE UNIQUE INDEX "career_recruitment_history_opportunity_id_key_key" ON "career_recruitment_history"("opportunity_id", "key");
CREATE INDEX "career_recruitment_history_opportunity_id_opened_on_idx" ON "career_recruitment_history"("opportunity_id", "opened_on");
CREATE UNIQUE INDEX "career_forecasts_opportunity_id_key" ON "career_forecasts"("opportunity_id");
CREATE UNIQUE INDEX "career_sources_key_key" ON "career_sources"("key");
CREATE UNIQUE INDEX "career_source_links_opportunity_id_source_id_relationship_r_key" ON "career_source_links"("opportunity_id", "source_id", "relationship", "recruitment_history_id", "forecast_id");
CREATE INDEX "career_source_links_source_id_idx" ON "career_source_links"("source_id");
CREATE INDEX "career_source_links_recruitment_history_id_idx" ON "career_source_links"("recruitment_history_id");
CREATE INDEX "career_source_links_forecast_id_idx" ON "career_source_links"("forecast_id");

ALTER TABLE "career_opportunities" ADD CONSTRAINT "career_opportunities_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "career_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "career_recruitment_history" ADD CONSTRAINT "career_recruitment_history_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "career_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_forecasts" ADD CONSTRAINT "career_forecasts_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "career_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_source_links" ADD CONSTRAINT "career_source_links_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "career_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_source_links" ADD CONSTRAINT "career_source_links_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "career_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "career_source_links" ADD CONSTRAINT "career_source_links_recruitment_history_id_fkey" FOREIGN KEY ("recruitment_history_id") REFERENCES "career_recruitment_history"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_source_links" ADD CONSTRAINT "career_source_links_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "career_forecasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
