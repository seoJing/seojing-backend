# PostgreSQL backup and restore

The production database is a single local PostgreSQL instance. Run a custom-format dump before schema migrations, content bulk operations, and destructive maintenance.

## Create a backup

`DATABASE_URL` is a runtime secret. For the launchd-backed service, load it only into the command environment; do not copy it into this repository or shell history.

```bash
pnpm db:backup
```

Defaults:

- directory: `.seojing-backups/postgres/` (gitignored)
- format: PostgreSQL custom dump (`.dump`)
- retention: 14 latest dumps

Optional environment variables:

- `SEOJING_BACKUP_DIR`: absolute or repo-relative destination
- `SEOJING_BACKUP_RETENTION`: positive retained-dump count
- `PG_DUMP_BIN`: absolute `pg_dump` path when it is not on `PATH`

The script writes `*.partial` first and renames it only after `pg_dump` succeeds. A failed dump never replaces a valid backup.

## Restore rehearsal

Do not restore directly into the running production database. First create an empty local rehearsal database, then restore the selected dump:

```bash
createdb seojing_backend_restore_check
pg_restore --clean --if-exists --no-owner --dbname seojing_backend_restore_check .seojing-backups/postgres/<backup>.dump
psql seojing_backend_restore_check -c 'SELECT count(*) FROM articles;'
dropdb seojing_backend_restore_check
```

Record the dump filename and the aggregate query result in the operational ticket/report. The first real backup change is not complete until this restore rehearsal has passed.
