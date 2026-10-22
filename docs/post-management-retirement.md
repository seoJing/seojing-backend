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

## MDX: retired active surfaces, preserved history and archive audit

Stage 2 is governed by the owner-authorized contract v2 dated 2026-10-22. The former requirement for 201 individual desktop/mobile visual-acceptance records was **waived and risk-accepted, not completed**. Do not claim that those records exist.

The active frontend corpus, generated bundles/loaders, migration review UI, authoring/import/conversion tools and MDX write/publish endpoints are retired. PostgreSQL Article/ArticleRevision MDX enum values, sourceText fields and historical revision rows remain byte-preserved and inert. No destructive history migration is authorized. A historical MDX revision may be read as history, but cannot be newly authored or published.

The immutable source of retirement audit truth is:

- Archive: /Users/seojing/Projects/seojing-retirement-archives/seojing-mdx-pre-retirement-5d9c3133-ed7cc2b1-20261022.tar.gz
- SHA-256: 7c7405b719a647b9aa61a28800bd5e84734fc342e659eab05242e13cb8987fc4
- Contents used by the gate: archived apps/web/content, including resume.mdx, and the archived 201-entry migration manifest.

Run the post-removal corpus gate without restoring active content files:

    corepack pnpm mdx:retirement-audit --archive /Users/seojing/Projects/seojing-retirement-archives/seojing-mdx-pre-retirement-5d9c3133-ed7cc2b1-20261022.tar.gz --corpus-only

It verifies the exact archive checksum, clean extraction, exact 201 blog paths/slugs/source hashes and deterministic conversion hashes. A corpus-only pass reports the visual policy as WAIVED_NOT_COMPLETED and does not claim live parity.

A final private evidence bundle (schema version 2) must still prove exactly 201 unique published Articles across read-only PostgreSQL, raw API details and raw D1 rows, including metadata, DOCUMENT hashes, payload parity and D1 indexed-column parity. The 201 database records contain complete per-article `legacyRevisions` arrays (204 MDX revisions in the captured production inventory), and `residualMdxRevisions` separately inventories every non-corpus MDX revision with article identity, slug, non-published status, actual revision number, exact source bytes and SHA-256 (one draft revision in the captured inventory). `historicalMdxRevisionTotal` must equal the published and residual arrays combined (205), with globally unique revision IDs, per-article unique revision numbers, and hashes recomputed from every supplied sourceText. Each published article names an existing `archivedSourceRevisionId` whose hash matches the archive manifest; byte-identical historical revisions are legitimate, so evidence capture chooses the lowest actual revision number and then ID deterministically rather than requiring one unique hash match. Database records must include the current published DOCUMENT revision. Current Article and DOCUMENT revision sourceText remain exactly empty; historical MDX sourceText remains hash-exact, and residual history never enters the exact 201 public slug parity sets.

Archive conversion remains a corpus-validity gate, not an expected-current-byte gate. Native DOCUMENT articles may contain legitimate post-migration edits. The final audit hashes the actual current PostgreSQL DOCUMENT, requires the API DOCUMENT to match it, requires the D1 payload to match the API payload, and binds representative `documentSha256` to that actual current PostgreSQL/API document.

Contract v2 replaces exhaustive visual records with representative, hash-bound desktop/mobile checks. Across the representative set the evidence must cover text, code, tables, images/media, quizzes, dates and responsive layout. The evidence schema records exhaustive201 as WAIVED_NOT_COMPLETED and ownerAcceptedAt as 2026-10-22; it never synthesizes 201 acceptances.

Run the final offline gate with a real evidence bundle:

    corepack pnpm mdx:retirement-audit --archive /Users/seojing/Projects/seojing-retirement-archives/seojing-mdx-pre-retirement-5d9c3133-ed7cc2b1-20261022.tar.gz --evidence /private/path/retirement-evidence.json

The gate is read-only. It must not publish, synchronize D1 or rewrite evidence. Release still requires deterministic no-active-MDX source/bundle proof, representative live route checks, rollback health, and independent exact-diff review ACCEPT. After merge/deploy, verify the exact deployed frontend/backend identities and public/private surfaces separately.

## Preserved blockers and shared data

- `src/services/python-worker.ts`, `src/routes/health.ts`, their tests and Python-worker environment settings: generic invocation/readiness capability, not exclusively the retired blog routes. Capability names may still include TTS/RAG. Ownership must be resolved separately.
- `prisma/schema.prisma`: `User`, `ArticleComment`, `UserRole`, `CommentKind`, `CommentStatus` and the Article comments relation retain stored data. The community API/service removal does not authorize destructive user/comment migrations.
- Only the known rewritten Career migration is restored to its proven applied bytes. All other existing migrations, including the retirement migration, remain byte-identical; both compatibility migrations are Career-only.
- `.local/readme-lab-build/` and `.local/readme-laya/*-build*/` contain historical compiled Career files within protected README build artifacts. They are untouched under the README boundary; removal requires separate scope. The cleanup report lists the exact remaining files.
- `docs/proposals/` is pre-existing, untracked and protected; all four supplied hashes must remain unchanged. No review or cleanup command should format or rewrite that directory.

The frontend runbook lists the presentation/TTS and analytics blockers. Existing historical documents describing retired services are retained as historical evidence; they are not current route registrations.
