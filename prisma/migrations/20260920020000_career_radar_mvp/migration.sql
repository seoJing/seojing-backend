CREATE TYPE "career_visibility" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "career_recruitment_status" AS ENUM ('OPEN', 'CLOSED', 'UPCOMING', 'UNKNOWN');
CREATE TYPE "career_employment_type" AS ENUM ('INTERNSHIP', 'FULL_TIME', 'CONTRACT', 'PART_TIME', 'OTHER');
CREATE TYPE "career_forecast_confidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TABLE "career_companies" (
  "id" UUID NOT NULL, "slug" TEXT NOT NULL, "name" TEXT NOT NULL,
  "english_name" TEXT, "careers_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_companies_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_opportunities" (
  "id" UUID NOT NULL, "company_id" UUID NOT NULL, "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL, "role" TEXT NOT NULL, "category" TEXT NOT NULL,
  "recruitment_status" "career_recruitment_status" NOT NULL DEFAULT 'UNKNOWN',
  "actual_status_as_of" TIMESTAMP(3),
  "visibility" "career_visibility" NOT NULL DEFAULT 'DRAFT', "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_opportunities_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_recruitments" (
  "id" UUID NOT NULL, "opportunity_id" UUID NOT NULL, "year" INTEGER NOT NULL,
  "title" TEXT NOT NULL, "open_date" DATE, "close_date" DATE,
  "employment_type" "career_employment_type",
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_recruitments_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_eligibility_items" (
  "id" UUID NOT NULL, "recruitment_id" UUID NOT NULL, "sort_order" INTEGER NOT NULL, "text" TEXT NOT NULL,
  CONSTRAINT "career_eligibility_items_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_process_steps" (
  "id" UUID NOT NULL, "recruitment_id" UUID NOT NULL, "order" INTEGER NOT NULL, "type" TEXT NOT NULL, "label" TEXT NOT NULL,
  CONSTRAINT "career_process_steps_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_forecasts" (
  "id" UUID NOT NULL, "opportunity_id" UUID NOT NULL, "expected_open_from" DATE, "expected_open_to" DATE,
  "confidence" "career_forecast_confidence" NOT NULL, "based_on_recruitment_count" INTEGER NOT NULL,
  "method_version" TEXT NOT NULL, "analyzed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_forecasts_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_forecast_reasons" (
  "id" UUID NOT NULL, "forecast_id" UUID NOT NULL, "sort_order" INTEGER NOT NULL, "text" TEXT NOT NULL,
  CONSTRAINT "career_forecast_reasons_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_preparation_notes" (
  "id" UUID NOT NULL, "opportunity_id" UUID NOT NULL, "sort_order" INTEGER NOT NULL, "text" TEXT NOT NULL,
  CONSTRAINT "career_preparation_notes_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_sources" (
  "id" UUID NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL, "url" TEXT NOT NULL,
  "publisher" TEXT, "published_at" TIMESTAMP(3), "accessed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "career_sources_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "career_recruitment_sources" (
  "recruitment_id" UUID NOT NULL, "source_id" UUID NOT NULL, "sort_order" INTEGER NOT NULL,
  CONSTRAINT "career_recruitment_sources_pkey" PRIMARY KEY ("recruitment_id", "source_id")
);
CREATE TABLE "career_forecast_sources" (
  "forecast_id" UUID NOT NULL, "source_id" UUID NOT NULL, "sort_order" INTEGER NOT NULL,
  CONSTRAINT "career_forecast_sources_pkey" PRIMARY KEY ("forecast_id", "source_id")
);
CREATE TABLE "career_status_sources" (
  "opportunity_id" UUID NOT NULL, "source_id" UUID NOT NULL, "sort_order" INTEGER NOT NULL,
  CONSTRAINT "career_status_sources_pkey" PRIMARY KEY ("opportunity_id", "source_id")
);
CREATE UNIQUE INDEX "career_companies_slug_key" ON "career_companies"("slug");
CREATE UNIQUE INDEX "career_opportunities_slug_key" ON "career_opportunities"("slug");
CREATE INDEX "career_opportunities_visibility_published_at_idx" ON "career_opportunities"("visibility", "published_at");
CREATE INDEX "career_opportunities_company_id_recruitment_status_idx" ON "career_opportunities"("company_id", "recruitment_status");
CREATE INDEX "career_recruitments_opportunity_id_year_idx" ON "career_recruitments"("opportunity_id", "year");
CREATE UNIQUE INDEX "career_eligibility_items_recruitment_id_sort_order_key" ON "career_eligibility_items"("recruitment_id", "sort_order");
CREATE UNIQUE INDEX "career_process_steps_recruitment_id_order_key" ON "career_process_steps"("recruitment_id", "order");
CREATE UNIQUE INDEX "career_forecasts_opportunity_id_key" ON "career_forecasts"("opportunity_id");
CREATE UNIQUE INDEX "career_forecast_reasons_forecast_id_sort_order_key" ON "career_forecast_reasons"("forecast_id", "sort_order");
CREATE UNIQUE INDEX "career_preparation_notes_opportunity_id_sort_order_key" ON "career_preparation_notes"("opportunity_id", "sort_order");
CREATE UNIQUE INDEX "career_recruitment_sources_recruitment_id_sort_order_key" ON "career_recruitment_sources"("recruitment_id", "sort_order");
CREATE INDEX "career_recruitment_sources_source_id_idx" ON "career_recruitment_sources"("source_id");
CREATE UNIQUE INDEX "career_forecast_sources_forecast_id_sort_order_key" ON "career_forecast_sources"("forecast_id", "sort_order");
CREATE INDEX "career_forecast_sources_source_id_idx" ON "career_forecast_sources"("source_id");
CREATE UNIQUE INDEX "career_status_sources_opportunity_id_sort_order_key" ON "career_status_sources"("opportunity_id", "sort_order");
CREATE INDEX "career_status_sources_source_id_idx" ON "career_status_sources"("source_id");
ALTER TABLE "career_opportunities" ADD CONSTRAINT "career_opportunities_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "career_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "career_recruitments" ADD CONSTRAINT "career_recruitments_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "career_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_eligibility_items" ADD CONSTRAINT "career_eligibility_items_recruitment_id_fkey" FOREIGN KEY ("recruitment_id") REFERENCES "career_recruitments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_process_steps" ADD CONSTRAINT "career_process_steps_recruitment_id_fkey" FOREIGN KEY ("recruitment_id") REFERENCES "career_recruitments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_forecasts" ADD CONSTRAINT "career_forecasts_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "career_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_forecast_reasons" ADD CONSTRAINT "career_forecast_reasons_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "career_forecasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_preparation_notes" ADD CONSTRAINT "career_preparation_notes_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "career_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_recruitment_sources" ADD CONSTRAINT "career_recruitment_sources_recruitment_id_fkey" FOREIGN KEY ("recruitment_id") REFERENCES "career_recruitments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_recruitment_sources" ADD CONSTRAINT "career_recruitment_sources_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "career_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_forecast_sources" ADD CONSTRAINT "career_forecast_sources_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "career_forecasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_forecast_sources" ADD CONSTRAINT "career_forecast_sources_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "career_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_status_sources" ADD CONSTRAINT "career_status_sources_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "career_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_status_sources" ADD CONSTRAINT "career_status_sources_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "career_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
