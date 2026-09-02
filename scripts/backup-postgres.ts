import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const backupDirectory = path.resolve(
  process.env.SEOJING_BACKUP_DIR ?? ".seojing-backups/postgres",
);
const retentionCount = Number.parseInt(
  process.env.SEOJING_BACKUP_RETENTION ?? "14",
  10,
);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Load it from launchd or a local secret file; never commit it.",
  );
}
if (!Number.isInteger(retentionCount) || retentionCount < 1) {
  throw new Error("SEOJING_BACKUP_RETENTION must be a positive integer.");
}

mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `seojing-backend-${timestamp}.dump`;
const destination = path.join(backupDirectory, filename);
const temporaryDestination = `${destination}.partial`;
const pgDump = process.env.PG_DUMP_BIN ?? "pg_dump";
const databaseConfig = new URL(databaseUrl);
// Prisma's `schema` query parameter is not understood by PostgreSQL CLI tools.
databaseConfig.searchParams.delete("schema");
const pgDumpEnv = {
  ...process.env,
  PGHOST: databaseConfig.hostname,
  PGPORT: databaseConfig.port || undefined,
  PGUSER: decodeURIComponent(databaseConfig.username),
  PGPASSWORD: decodeURIComponent(databaseConfig.password),
  PGDATABASE: databaseConfig.pathname.replace(/^\//, ""),
};

const result = spawnSync(
  pgDump,
  [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--file=${temporaryDestination}`,
  ],
  { env: pgDumpEnv, stdio: "inherit" },
);
if (result.error || result.status !== 0) {
  rmSync(temporaryDestination, { force: true });
  throw result.error ?? new Error(`${pgDump} exited with ${result.status}`);
}
renameSync(temporaryDestination, destination);

const backups = readdirSync(backupDirectory)
  .filter((entry) => entry.endsWith(".dump"))
  .sort()
  .reverse();
for (const stale of backups.slice(retentionCount)) {
  rmSync(path.join(backupDirectory, stale), { force: true });
}

if (!existsSync(destination)) {
  throw new Error("Backup file was not created.");
}
console.log(`PostgreSQL backup created: ${destination}`);
console.log(`Retained backups: ${Math.min(backups.length, retentionCount)}`);
