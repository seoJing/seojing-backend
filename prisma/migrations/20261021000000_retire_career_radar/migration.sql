-- Forward-only Career retirement. Export all career_* data and verify a full
-- database backup/restore BEFORE applying; see docs/post-management-retirement.md.
-- No CASCADE: unknown external dependencies must stop the migration.
BEGIN;

DROP TABLE IF EXISTS "career_recruitment_sources";
DROP TABLE IF EXISTS "career_forecast_sources";
DROP TABLE IF EXISTS "career_status_sources";
DROP TABLE IF EXISTS "career_forecast_reasons";
DROP TABLE IF EXISTS "career_preparation_notes";
DROP TABLE IF EXISTS "career_eligibility_items";
DROP TABLE IF EXISTS "career_process_steps";
DROP TABLE IF EXISTS "career_forecasts";
DROP TABLE IF EXISTS "career_recruitments";
DROP TABLE IF EXISTS "career_opportunities";
DROP TABLE IF EXISTS "career_sources";
DROP TABLE IF EXISTS "career_companies";

DROP TYPE IF EXISTS "career_forecast_confidence";
DROP TYPE IF EXISTS "career_employment_type";
DROP TYPE IF EXISTS "career_recruitment_status";
DROP TYPE IF EXISTS "career_visibility";

COMMIT;
