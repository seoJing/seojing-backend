-- Original Career enums survive the immutable retirement migration.
-- Their Career table dependencies have been removed by the preceding migrations.
-- External dependencies must abort this transaction.
BEGIN;

DROP TYPE IF EXISTS "career_actual_status";
DROP TYPE IF EXISTS "career_source_relationship";

COMMIT;
