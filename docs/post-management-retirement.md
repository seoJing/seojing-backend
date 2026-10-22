# Post-management retirement runbook

This change prepares a database migration and an offline MDX retirement gate. It does not apply migrations, publish articles, synchronize D1, deploy, restart services, or delete MDX. Independent review and a separately authorized operations window are still required.

## Career database retirement

Migration: `20261021000000_retire_career_radar` in the existing Prisma migration directory. The Prisma schema already excludes Career. Historical migrations remain unchanged so a fresh installation creates and then drops the same retired objects as an upgrade.

**Export and backup are mandatory prerequisites before anyone applies this migration.**

1. Identify the exact target PostgreSQL database and stop Career writers through a separately approved operational procedure. Check that no external consumer or foreign key depends on a `career_*` object.
2. Export **all 12 Career tables**, including source/junction tables, using a custom-format `pg_dump --data-only --table='public.career_*'`. Also take a full custom-format database backup, including schema, article revisions, assets, users and comments. Use the existing `scripts/backup-postgres.ts` procedure in `docs/postgres-backup-restore.md`. Keep credentials out of shell history and reports.
3. Record target identity, capture time, table row counts, archive locations and SHA-256 checksums. Inspect the archives with `pg_restore --list` and rehearse a full restore into an isolated disposable database. Verify Career row counts and article/revision/asset records there. An existing filename or an untested export is insufficient.
4. Review the new SQL and run the static checks below. It drops the 12 historical Career tables in foreign-key order and the four `career_*` enum types, inside one transaction. It uses `IF EXISTS` for already-retired objects. It deliberately omits `CASCADE`: an unexpected external dependency must abort the transaction rather than delete a retained object.
5. Only in a later, explicitly authorized operations window, use the normal Prisma deployment workflow against the verified target. Do not edit, mark applied, or remove historical migrations. Afterward verify no `career_*` tables/types remain and compare retained article/revision/asset/user/comment counts with the backup.

There is no automatic down migration. Recovery requires the verified backup/export and a separately approved restore plan; do not recreate empty Career tables and call that recovery.

Local verification, requiring no database connection:

```sh
pnpm test:retirement
DATABASE_URL=postgresql://static:static@127.0.0.1:1/static pnpm exec prisma validate
DATABASE_URL=postgresql://static:static@127.0.0.1:1/static pnpm exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

The regression test compares the exact DROP set against historical CREATE statements, checks foreign-key drop order and transaction boundaries, and compares surviving tables/types with the current Prisma schema. This is static verification, not a PostgreSQL execution rehearsal. Neither `migrate deploy` nor `migrate dev` belongs in this cleanup's validation commands.

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
- All historical Prisma migrations remain byte-identical. The new migration is Career-only.
- `.local/readme-lab-build/` and `.local/readme-laya/*-build*/` contain historical compiled Career files within protected README build artifacts. They are untouched under the README boundary; removal requires separate scope. The cleanup report lists the exact remaining files.
- `docs/proposals/` is pre-existing, untracked and protected; all four supplied hashes must remain unchanged. No review or cleanup command should format or rewrite that directory.

The frontend runbook lists the presentation/TTS and analytics blockers. Existing historical documents describing retired services are retained as historical evidence; they are not current route registrations.
