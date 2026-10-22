import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prerequisite = "20261020000000_retire_career_radar_legacy_tables";
const retirement = "20261021000000_retire_career_radar";
const cleanup = "20261022000000_retire_career_radar_legacy_enums";
const migrationRoot = resolve("prisma/migrations");
const migrations = readdirSync(migrationRoot)
  .filter((name) => existsSync(join(migrationRoot, name, "migration.sql")))
  .sort();
const retainedTables = [
  "article_assets",
  "article_blocks",
  "article_comments",
  "article_revisions",
  "articles",
  "users",
];
// Existing non-Career history differs from schema.prisma. Pin the entire diff
// and prove it independently without any Career migration; never apply it here.
const existingSchemaDrift = `-- DropIndex
DROP INDEX "articles_category_status_published_at_idx";

-- AlterTable
ALTER TABLE "article_comments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;`;
const describePostgres =
  process.env.RUN_CAREER_MIGRATION_TESTS === "true" ? describe : describe.skip;

// Never accept a caller-provided database URL. Every command targets a new,
// socket-only cluster under our own temporary directory, including Prisma.
describePostgres("Career retirement in disposable PostgreSQL", () => {
  let work: string;
  let data: string;
  let socket: string;
  let started = false;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("PG") &&
        !["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL"].includes(key),
    ),
  );
  const command = (bin: string, args: string[], input?: string) => {
    const result = spawnSync(bin, args, {
      cwd: work,
      env: { ...env, LC_ALL: "C", LANG: "C", PGCONNECT_TIMEOUT: "5" },
      encoding: "utf8",
      input,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const success = (bin: string, args: string[], input?: string) => {
    const result = command(bin, args, input);
    expect(result.status, `${bin}: ${result.output}`).toBe(0);
    return result.output.trim();
  };
  const connection = (db: string) => [
    "--host",
    socket,
    "--port",
    "55432",
    "--username",
    "career_test",
    "--dbname",
    db,
  ];
  const query = (db: string, sql: string) =>
    success("psql", [
      ...connection(db),
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ]);
  const url = (db: string) =>
    `postgresql://career_test@localhost:55432/${db}?host=${encodeURIComponent(socket)}`;
  const schema = (stage: string) => join(work, stage, "schema.prisma");
  const prisma = (db: string, stage: string, args: string[]) => {
    // cwd contains no .env/package config; the schema's URL is fixture-specific.
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/prisma/build/index.js"),
        ...args,
        "--schema",
        schema(stage),
      ],
      {
        cwd: work,
        env: { ...env, DATABASE_URL: url(db), CHECKPOINT_DISABLE: "1" },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    if (result.error) throw result.error;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const createDatabase = (db: string) => {
    expect(db).toMatch(/^[a-z_]+$/);
    query("postgres", `CREATE DATABASE "${db}"`);
    expect(query(db, "SHOW data_directory")).toBe(data);
    expect(query(db, "SHOW listen_addresses")).toBe("");
  };
  const careerInventory = (db: string) => ({
    tables: query(
      db,
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'career_%' ORDER BY tablename`,
    ),
    enums: query(
      db,
      `SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e' AND typname LIKE 'career_%' ORDER BY typname`,
    ),
  });
  const retainedSnapshot = (db: string) => ({
    dump: success("pg_dump", [
      ...connection(db),
      ...retainedTables.map((name) => `--table=public.${name}`),
      "--table=retirement_sentinel.*",
    ]).replace(/^\\(?:un)?restrict .*$/gm, ""),
    enums: query(
      db,
      `SELECT n.nspname, t.typname, e.enumsortorder, e.enumlabel FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid WHERE n.nspname IN ('public', 'retirement_sentinel') AND t.typname NOT LIKE 'career_%' ORDER BY 1, 2, 3`,
    ),
    objects: query(
      db,
      `SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'retirement_sentinel') AND c.relname NOT LIKE 'career_%' AND c.relname NOT LIKE '_prisma_migrations%' ORDER BY 1, 2`,
    ),
    rows: retainedTables.map((name) => [
      name,
      query(db, `SELECT count(*) FROM "${name}"`),
    ]),
  });
  const assertRetired = (db: string) => {
    expect(careerInventory(db)).toEqual({ tables: "", enums: "" });
    // Includes indexes, sequences, table row types, enum array types, constraints,
    // routines and views, not just the tables Prisma happens to introspect.
    expect(
      query(
        db,
        `
      SELECT 'relation', relname FROM pg_class WHERE relname LIKE 'career_%'
      UNION ALL SELECT 'type', typname FROM pg_type WHERE typname ~ '^_?career_'
      UNION ALL SELECT 'constraint', conname FROM pg_constraint WHERE conname LIKE 'career_%'
      UNION ALL SELECT 'routine', proname FROM pg_proc WHERE proname LIKE 'career_%'
    `,
      ),
    ).toBe("");
  };
  const schemaDiff = (db: string) =>
    command(process.execPath, [
      resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "diff",
      "--from-url",
      url(db),
      "--to-schema-datamodel",
      schema("all"),
      "--exit-code",
      "--script",
    ]);
  const assertDeployedSchema = (db: string) => {
    expect(prisma(db, "all", ["migrate", "status"])).toContain(
      "Database schema is up to date",
    );
    const diff = schemaDiff(db);
    expect(diff.status, diff.output).toBe(2);
    expect(diff.output.trim()).toBe(existingSchemaDrift);
    expect(diff).toEqual(schemaDiff("retained_baseline"));
    const introducedDiff = success(process.execPath, [
      resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "diff",
      "--from-url",
      url("retained_baseline"),
      "--to-url",
      url(db),
      "--exit-code",
      "--script",
    ]);
    expect(introducedDiff).toContain("This is an empty migration");
    expect(
      query(
        db,
        `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      ),
    ).toBe(String(migrations.length));
    expect(
      query(
        db,
        `SELECT migration_name || '|' || checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
      ),
    ).toBe(
      migrations
        .map(
          (name) =>
            `${name}|${createHash("sha256")
              .update(readFileSync(join(migrationRoot, name, "migration.sql")))
              .digest("hex")}`,
        )
        .join("\n"),
    );
  };
  const assertRollback = (db: string, name: string, dependency: string) => {
    query(db, dependency);
    const before = success("pg_dump", [...connection(db)]).replace(
      /^\\(?:un)?restrict .*$/gm,
      "",
    );
    const result = command(
      "psql",
      [...connection(db), "-X", "-v", "ON_ERROR_STOP=1"],
      readFileSync(join(migrationRoot, name, "migration.sql"), "utf8"),
    );
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("because other objects depend on it");
    const after = success("pg_dump", [...connection(db)]).replace(
      /^\\(?:un)?restrict .*$/gm,
      "",
    );
    expect(
      after,
      `${name} must roll back all earlier drops and preserve rows`,
    ).toBe(before);
    query(db, "DROP TABLE retirement_sentinel.external_dependency");
  };

  beforeAll(() => {
    work = realpathSync(mkdtempSync("/tmp/career-pg-"));
    data = join(work, "data");
    socket = join(work, "socket");
    mkdirSync(socket, { mode: 0o700 });
    success("initdb", [
      "-D",
      data,
      "--username=career_test",
      "--auth=trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    success("pg_ctl", [
      "-D",
      data,
      "-l",
      join(work, "postgres.log"),
      "-o",
      `-h '' -k ${socket} -p 55432 -c unix_socket_permissions=0700`,
      "-w",
      "start",
    ]);
    started = true;
    for (const [stage, end] of [
      ["retained", prerequisite],
      ["history", prerequisite],
      ["prerequisite", retirement],
      ["retirement", cleanup],
      ["all", "9999"],
    ]) {
      const target = join(work, stage!, "migrations");
      mkdirSync(target, { recursive: true });
      cpSync(resolve("prisma/schema.prisma"), schema(stage!));
      cpSync(
        join(migrationRoot, "migration_lock.toml"),
        join(target, "migration_lock.toml"),
      );
      for (const name of migrations.filter(
        (name) =>
          name < end! && (stage !== "retained" || !name.includes("career")),
      )) {
        cpSync(join(migrationRoot, name), join(target, name), {
          recursive: true,
        });
      }
    }
    console.info(
      `Disposable PostgreSQL: ${work}; Unix socket only, no TCP listener`,
    );
    createDatabase("retained_baseline");
    prisma("retained_baseline", "retained", ["migrate", "deploy"]);
    const baselineDiff = schemaDiff("retained_baseline");
    expect(baselineDiff.status, baselineDiff.output).toBe(2);
    expect(baselineDiff.output.trim()).toBe(existingSchemaDrift);
    console.info(
      `Pre-existing non-Career schema diff (exit 2, unchanged by retirement):\n${baselineDiff.output}`,
    );
  }, 60_000);

  afterAll(() => {
    if (!work) return;
    // Do not remove a cluster unless shutdown succeeded. This path is always
    // created by mkdtemp above, never supplied by the caller or a repo setting.
    if (started || existsSync(join(data, "postmaster.pid"))) {
      success("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
    }
    rmSync(work, { recursive: true });
    expect(existsSync(work)).toBe(false);
    console.info(
      `Disposed cluster, sockets, databases and fixture archive: ${work}`,
    );
  }, 60_000);

  it("deploys the full chain from empty and is idempotent", () => {
    createDatabase("fresh");
    prisma("fresh", "all", ["migrate", "deploy"]);
    assertRetired("fresh");
    assertDeployedSchema("fresh");
    expect(prisma("fresh", "all", ["migrate", "deploy"])).toContain(
      "No pending migrations",
    );
    for (const name of [prerequisite, retirement, cleanup]) {
      success(
        "psql",
        [...connection("fresh"), "-X", "-v", "ON_ERROR_STOP=1"],
        readFileSync(join(migrationRoot, name, "migration.sql"), "utf8"),
      );
    }
    assertDeployedSchema("fresh");
  }, 120_000);

  it("restores a production-shaped fixture, preserves non-Career data and rolls back dependency failures", () => {
    createDatabase("fixture_source");
    prisma("fixture_source", "history", ["migrate", "deploy"]);
    success(
      "psql",
      [...connection("fixture_source"), "-X", "-v", "ON_ERROR_STOP=1"],
      readFileSync(resolve("test/fixtures/career-retirement.sql"), "utf8"),
    );
    const archive = join(work, "fixture.dump");
    success("pg_dump", [
      ...connection("fixture_source"),
      "--format=custom",
      "--file",
      archive,
    ]);
    expect(success("pg_restore", ["--list", archive])).toContain(
      "career_source_links",
    );
    // Rehearse the normal upgrade: one deploy applies all three pending files.
    createDatabase("upgrade");
    success("pg_restore", [
      ...connection("upgrade"),
      "--exit-on-error",
      archive,
    ]);
    const upgradeBefore = retainedSnapshot("upgrade");
    expect(upgradeBefore).toEqual(retainedSnapshot("fixture_source"));
    prisma("upgrade", "all", ["migrate", "deploy"]);
    assertRetired("upgrade");
    assertDeployedSchema("upgrade");
    expect(retainedSnapshot("upgrade")).toEqual(upgradeBefore);

    // A second restore isolates failure injection at each transaction boundary.
    createDatabase("restored");
    success("pg_restore", [
      ...connection("restored"),
      "--exit-on-error",
      archive,
    ]);
    expect(retainedSnapshot("restored")).toEqual(
      retainedSnapshot("fixture_source"),
    );
    expect(
      query(
        "restored",
        `SELECT checksum FROM _prisma_migrations WHERE migration_name = '20260920020000_career_radar_mvp'`,
      ),
    ).toBe("41cf6c57de4fb7c4cf45a1889bc924b5bf842d9d755ce8f9aad4ec84f64c2f19");
    expect(careerInventory("restored")).toEqual({
      tables: [
        "career_companies",
        "career_forecasts",
        "career_opportunities",
        "career_recruitment_history",
        "career_source_links",
        "career_sources",
      ].join("\n"),
      enums: [
        "career_actual_status",
        "career_employment_type",
        "career_forecast_confidence",
        "career_source_relationship",
        "career_visibility",
      ].join("\n"),
    });
    const before = retainedSnapshot("restored");
    expect(before.rows).toEqual(retainedTables.map((name) => [name, "1"]));
    expect(query("restored", "SELECT count(*) FROM career_source_links")).toBe(
      "2",
    );

    // Each blocker targets a later DROP so the equality check proves that
    // earlier successful DDL was rolled back, rather than just failing early.
    assertRollback(
      "restored",
      prerequisite,
      `CREATE TABLE retirement_sentinel.external_dependency (id uuid REFERENCES career_recruitment_history(id)); INSERT INTO retirement_sentinel.external_dependency VALUES ('20000000-0000-0000-0000-000000000003')`,
    );
    prisma("restored", "prerequisite", ["migrate", "deploy"]);
    expect(careerInventory("restored").tables.split("\n")).toHaveLength(4);
    expect(retainedSnapshot("restored")).toEqual(before);

    assertRollback(
      "restored",
      retirement,
      `CREATE TABLE retirement_sentinel.external_dependency (id uuid REFERENCES career_companies(id)); INSERT INTO retirement_sentinel.external_dependency VALUES ('20000000-0000-0000-0000-000000000001')`,
    );
    prisma("restored", "retirement", ["migrate", "deploy"]);
    expect(careerInventory("restored")).toEqual({
      tables: "",
      enums: "career_actual_status\ncareer_source_relationship",
    });
    expect(retainedSnapshot("restored")).toEqual(before);

    assertRollback(
      "restored",
      cleanup,
      `CREATE TABLE retirement_sentinel.external_dependency (value career_source_relationship); INSERT INTO retirement_sentinel.external_dependency VALUES ('GENERAL')`,
    );
    prisma("restored", "all", ["migrate", "deploy"]);
    assertRetired("restored");
    expect(retainedSnapshot("restored")).toEqual(before);
    assertDeployedSchema("restored");
    console.info(
      "Preserved all six non-Career tables (one row each), sentinel table/row/sequence/view/enum, and retained definitions; all three dependency-failure transactions rolled back",
    );
  }, 120_000);
});
