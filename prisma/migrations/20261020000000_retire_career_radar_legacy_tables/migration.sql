-- Remove original Career children before the immutable retirement migration.
-- Export/backup prerequisites: docs/post-management-retirement.md.
-- External dependencies must abort this transaction.
BEGIN;

DROP TABLE IF EXISTS "career_source_links";
DROP TABLE IF EXISTS "career_recruitment_history";

COMMIT;
