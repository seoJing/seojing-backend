# Post-management retirement runbook

This change prepares Career database migrations and an offline MDX retirement gate. Local rehearsals use disposable PostgreSQL only; they do not apply production migrations, publish articles, synchronize D1, deploy, restart services, or delete MDX. Production execution belongs to the coordinator and its authorized operations window.

## Career database retirement

The Prisma schema already excludes Career. Restore the production-applied `20260920020000_career_radar_mvp/migration.sql` to the exact bytes from commit `69fb48c0339a39f7d2b8fd3b47ad930b9fab47f7`, SHA-256 `41cf6c57de4fb7c4cf45a1889bc924b5bf842d9d755ce8f9aad4ec84f64c2f19`. This repairs a later in-place rewrite; it is not permission to revise applied SQL or migration ledger checksums. The original history creates **six Career tables and five enums**. The later rewrite described twelve tables and four enums, which is why the existing retirement alone cannot handle the applied schema.

Deploy the forward migrations in this order after `20261007150000_article_document_source`:

1. `20261020000000_retire_career_radar_legacy_tables`: drop `career_source_links`, then `career_recruitment_history`, before their parents.
2. `20261021000000_retire_career_radar`: retain byte-for-byte, SHA-256 `c9f8198ddd2973206de9306471aaeaf7bfa83e527f98f9ec8d62aac9dbae36aa`. Its twelve table drops and four enum drops also tolerate objects absent from the applied schema.
3. `20261022000000_retire_career_radar_legacy_enums`: drop `career_actual_status`, then `career_source_relationship`, after all dependent Career tables are gone.

Each migration has its own explicit transaction, uses `IF EXISTS`, and omits `CASCADE`. An unexpected dependency aborts that migration; earlier committed migrations remain applied. Inventory of the restored history and disposable PostgreSQL catalogs shows no additional Career object needs an explicit drop: table-owned indexes, constraints and row types disappear with their tables, and enum array types disappear with their enums. Never extend this cleanup to non-Career objects.

**Export and backup are mandatory prerequisites before production application.**

1. Identify the exact target PostgreSQL database and stop Career writers through the authorized operational procedure. Inventory all `career_*` tables, types and dependencies; check that no external consumer or foreign key depends on them.
2. Export **all Career tables actually present**, including source/junction tables, using a custom-format `pg_dump --data-only --table='public.career_*'`. Expect six tables for the restored applied schema; do not assume the rewritten twelve-table inventory. Also take a full custom-format database backup, including schema, article revisions, assets, users and comments. Use `scripts/backup-postgres.ts` and `docs/postgres-backup-restore.md`. Keep credentials out of shell history and reports.
3. Record target identity, capture time, table row counts, archive locations and SHA-256 checksums. Inspect the archives with `pg_restore --list` and rehearse a full restore into an isolated disposable database. Verify Career row counts and article/revision/asset records there. An existing filename or an untested export is insufficient.
4. Review all three SQL files and run the checks below. Confirm both pinned checksums and child-before-parent ordering. Do not edit or mark historical migrations applied to bypass a failed deployment.
5. In the production operations window, use the normal Prisma deployment workflow against the verified target. Afterward verify no Career tables/types remain and compare retained article/revision/block/asset/user/comment definitions and counts with the backup. A local synthetic fixture is not a substitute for the actual target's backup rehearsal.

There is no automatic down migration. Recovery requires the verified backup/export and an approved restore plan; do not recreate empty Career tables and call that recovery.

Static verification, requiring no database connection:

```sh
pnpm test:retirement
DATABASE_URL=postgresql://static:static@127.0.0.1:1/static pnpm exec prisma validate
```

Disposable PostgreSQL verification (requires local `initdb`, `pg_ctl`, `psql`, `pg_dump`, `pg_restore`, tested with PostgreSQL 16):

```sh
pnpm test:retirement:postgres
```

The static tests pin both immutable checksums, allow only the exact DROP statements in each transaction, check the combined foreign-key order and compare surviving tables/enums with the Prisma schema. The opt-in integration test creates its own temporary, socket-only cluster with no TCP listener and ignores caller database URLs. It exercises Prisma `migrate deploy`/`status` and schema diff from empty and from a custom-format dump/restore of a synthetic production-shaped fixture with the original migration ledger checksum. It preserves all six non-Career tables and rows, a sentinel table/row/sequence/view/enum, and their definitions; injects external dependencies to prove rollback after earlier drops in each transaction; checks repeat execution and remaining Career catalogs; then stops and removes only its own cluster and archive. It never reads production data or uses the repository's `.local/postgres-data`.

**Existing schema-diff blocker:** both completed paths still differ from `schema.prisma` in three non-Career details: the historical `articles_category_status_published_at_idx` index and the database UUID defaults on `article_comments.id` and `users.id`. Prisma's database-to-datamodel diff returns exit **2**, proposing removal of those objects/defaults. The same exact diff occurs in an independently deployed database containing only the five non-Career migrations; the retirement introduces zero additional drift. The integration test pins this complete baseline diff and requires an empty database-to-baseline diff. A passing retirement test does **not** mean an exact current Prisma schema match. Reconciliation requires separate non-Career scope; do not execute that diff as part of Career retirement.

On the production checkout, direct build output to a disposable directory (for example `pnpm build --outDir /private/tmp/<verification-directory>/build`); `dist/` is the live service artifact. Do not use `migrate dev`, reset the shared local cluster, or run deployment commands with inherited production credentials during verification.

## MDX: preparation only

Retain all **201 blog MDX files**, the separate resume source, the web migration manifest, conversion/import/audit tools, migration review UI, canonical `/blog` routes, protected `/ops/articles`, `MDX`/`BLOCKS`/`DOCUMENT` and `RAW_MDX` enum values, both `sourceText` fields, all article/revision/document/asset models, historical revisions, referenced media, and D1 snapshot synchronization.

Run the corpus-only audit from this repository:

```sh
pnpm mdx:retirement-audit --content-root /Users/seojing/Projects/SEOJing/apps/web/content --manifest /Users/seojing/Projects/SEOJing/apps/web/src/shared/content/mdx-migration-manifest.json --corpus-only
```

This checks the actual exact-case file/slug sets, exactly 201 entries, original byte hashes, and conversion of every document. Exit 0 means the retained corpus is valid; it explicitly reports `retirementReady: false` without review evidence. The older conversion audit now exits nonzero on conversion errors or an empty input directory.

For final review, gather an offline evidence bundle from one frozen release/capture window. Do not perform a conversion, publish, or D1 write to make an audit green. Store the bundle privately because it includes original source text. Use real exports/readbacks and human review records, never generated acceptance records.

The bundle is JSON with these required fields (the executable schema is in `src/services/mdx-retirement-readiness.ts`):

- `version: 1`, ISO `capturedAt`, and the reviewed 40-character `webCommit` and `backendCommit`. The reviewer must verify these commits/deployed artifacts and that no edits/publications occurred during capture; the offline gate cannot attest to deployment provenance or freshness.
- `database`: exactly 201 records, each with the Article's `id`, `slug`, `status: "PUBLISHED"`, `sourceFormat: "DOCUMENT"`, `sourceText: ""`, `currentRevisionId`, and `latestRevisionId`. Include the actual original `legacyRevision: { id, articleId, sourceFormat: "MDX", sourceText }` and the actual published `currentRevision: { id, articleId, sourceFormat: "DOCUMENT", sourceText: "", document }`. Both revisions must belong to the Article; Article IDs must be unique and all legacy/current revision IDs must be distinct. Article and current revision source fields must agree and follow current DOCUMENT semantics: `sourceText` is exactly empty, not whitespace or retained MDX. Include the raw public metadata fields `title`, `description`, `category`, `tags`, `cover`, `summaryVideo`, `displayDate`, `displayUpdatedAt`, `publishedAt`, and `updatedAt` (ISO dates or null where supported); these must match the API. Obtain these through a read-only database export, including the original MDX revision. The gate derives the legacy hash from `legacyRevision.sourceText` and hashes the actual current document; a free-standing `legacySourceText` or exported hash cannot substitute for the original revision. The latest revision must be the published current revision. A one-newline source difference blocks final retirement until explicitly reconciled and reviewed; do not silently normalize it.
- `api`: exactly 201 **raw** public article detail responses from `/articles/<encoded-slug>`, including metadata, HTML, blocks and document. Obtain the complete slug inventory independently; do not infer completeness from successful requests to a subset. A staged `migration-snapshot` is not proof of publication.
- `d1`: exactly 201 raw rows from `SELECT slug,title,description,category,tags_json,cover_json,display_date,display_updated_at,published_at,updated_at,payload_json FROM public_articles ORDER BY slug`. Flatten the read-only export envelope to the rows, preserving all column strings and the raw `payload_json`. This is a read, not the snapshot SQL generator's planned output.
- `visualAcceptances`: exactly one record per slug with `accepted: true`, named `reviewer`, ISO `reviewedAt`, `sourceSha256`, `documentSha256`, `publicPayloadSha256`, and both `desktop` and `mobile` objects `{ "path": "relative/path/to/evidence.png", "sha256": "64-character hash" }`. Paths resolve relative to the bundle. Capture and compare the original MDX rendering and published native document at both viewport classes, including images, tables, code metadata, quizzes/answers, links and media. Each evidence artifact should show the comparison. The gate reads and hashes the artifacts; human reviewers remain responsible for visual acceptance.

`documentSha256` hashes sorted-key canonical JSON (array order preserved) using the exported `stableJson`/`sha256` functions. `publicPayloadSha256` uses the exported `publicPayloadHash` function: the complete raw API response with only `body` projected to `{ document, html: "", blocks: [] }`, matching the existing D1 exporter. This still checks every metadata field, including assets, cover, video, dates and ETag. D1's separately indexed columns must also match. Altered documents require renewed conversion/manifest review and renewed visual acceptance; an arbitrary new hash cannot override the source-derived expectation.

Run the final gate:

```sh
pnpm mdx:retirement-audit --content-root /Users/seojing/Projects/SEOJing/apps/web/content --manifest /Users/seojing/Projects/SEOJing/apps/web/src/shared/content/mdx-migration-manifest.json --evidence /private/path/review/evidence.json
```

Exit 1 blocks removal on absent/malformed evidence, any missing/extra/duplicate/case-changed slug, fewer than 201 acceptances, source or DOCUMENT hash differences, unpublished/private revisions, API/D1 payload or index-column differences, stale visual hashes or missing/changed evidence artifacts. No evidence is shipped as accepted by this cleanup. A green report is necessary but does not itself authorize deleting files or deploying. Retain all contracts through independent review and the rollback window; perform final retirement as a separate change.

## Preserved blockers and shared data

- `src/services/python-worker.ts`, `src/routes/health.ts`, their tests and Python-worker environment settings: generic invocation/readiness capability, not exclusively the retired blog routes. Capability names may still include TTS/RAG. Ownership must be resolved separately.
- `prisma/schema.prisma`: `User`, `ArticleComment`, `UserRole`, `CommentKind`, `CommentStatus` and the Article comments relation retain stored data. The community API/service removal does not authorize destructive user/comment migrations.
- Only the known rewritten Career migration is restored to its proven applied bytes. All other existing migrations, including the retirement migration, remain byte-identical; both compatibility migrations are Career-only.
- `.local/readme-lab-build/` and `.local/readme-laya/*-build*/` contain historical compiled Career files within protected README build artifacts. They are untouched under the README boundary; removal requires separate scope. The cleanup report lists the exact remaining files.
- `docs/proposals/` is pre-existing, untracked and protected; all four supplied hashes must remain unchanged. No review or cleanup command should format or rewrite that directory.

The frontend runbook lists the presentation/TTS and analytics blockers. Existing historical documents describing retired services are retained as historical evidence; they are not current route registrations.
