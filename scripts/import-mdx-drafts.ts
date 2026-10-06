import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { PrismaClient } from "@prisma/client";

import { ArticleRepository } from "../src/repositories/articles.js";
import { ArticleService } from "../src/services/articles.js";
import { ingestMdxArticle } from "../src/services/mdx-ingest.js";

type Entry = {
  sourcePath: string;
  slug: string;
  sourceSha256: string;
  sourceBytes: number;
  unsupportedComponents: string[];
};
type Manifest = { version: 1; contentRoot: string; entries: Entry[] };

const args = process.argv.slice(2);
const action = args[0];
if (action !== "--plan" && action !== "--apply") {
  throw new Error(
    "Usage: pnpm mdx:import-drafts --plan|--apply --content-root PATH --manifest PATH [--backup-file PATH]",
  );
}
const values = new Map<string, string>();
for (let index = 1; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (
    !key ||
    !value ||
    !["--content-root", "--manifest", "--backup-file"].includes(key)
  ) {
    throw new Error(`Invalid argument: ${key ?? "missing"}`);
  }
  values.set(key, value);
}
const contentRoot = resolve(required("--content-root"));
const manifestPath = resolve(required("--manifest"));
const prisma = new PrismaClient();
const service = new ArticleService(new ArticleRepository(prisma));

try {
  const manifest =
    action === "--plan"
      ? await buildManifest(contentRoot)
      : (JSON.parse(await readFile(manifestPath, "utf8")) as Manifest);
  if (action === "--apply") {
    if (
      manifest.version !== 1 ||
      resolve(manifest.contentRoot) !== contentRoot
    ) {
      throw new Error("Manifest version or content root mismatch");
    }
    await verifyBackup(required("--backup-file"));
    const current = await buildManifest(contentRoot);
    if (JSON.stringify(current.entries) !== JSON.stringify(manifest.entries)) {
      throw new Error(
        "Source files differ from the approved manifest; run --plan again",
      );
    }
  }

  let existing = 0;
  let editedExisting = 0;
  let created = 0;
  const conflicts: string[] = [];
  for (const entry of manifest.entries) {
    const article = await service.getArticleBySlug(entry.slug);
    if (article) {
      if (article.slug !== entry.slug) conflicts.push(entry.slug);
      else if (hash(article.sourceText) === entry.sourceSha256) existing += 1;
      else if (
        article.revisions.some((revision) =>
          revision.changeSummary?.startsWith("Private MDX import:"),
        )
      )
        editedExisting += 1;
      else conflicts.push(entry.slug);
    }
  }
  if (conflicts.length) {
    throw new Error(
      `Existing articles differ from source: ${conflicts.join(", ")}`,
    );
  }
  if (action === "--apply")
    for (const entry of manifest.entries) {
      if (await service.getArticleBySlug(entry.slug)) continue;
      const sourcePath = resolve(contentRoot, entry.sourcePath);
      const sourceText = await readFile(sourcePath, "utf8");
      const ingest = ingestMdxArticle(sourceText, { sourcePath, contentRoot });
      const draft = await service.createInitialDraft({
        slug: entry.slug,
        title: ingest.title,
        description: ingest.description,
        category: entry.slug.startsWith("study/") ? "Study" : undefined,
        sourceFormat: "MDX",
        sourceText,
        renderedHtml: ingest.renderedHtml,
        blocks: ingest.blocks,
        assets: ingest.assets,
        status: "DRAFT",
        changeSummary: `Private MDX import: ${entry.sourceSha256}`,
        authorName: "SEOJing MDX migration",
      });
      const readback = await service.getArticleBySlug(entry.slug);
      if (
        !readback ||
        draft.status !== "DRAFT" ||
        readback.status !== "DRAFT" ||
        readback.slug !== entry.slug ||
        hash(readback.sourceText) !== entry.sourceSha256 ||
        readback.revisions.length !== 1
      ) {
        throw new Error(`Readback mismatch after creating ${entry.slug}`);
      }
      created += 1;
      console.log(
        JSON.stringify({
          result: "created",
          slug: entry.slug,
          sourceSha256: entry.sourceSha256,
        }),
      );
    }
  if (action === "--plan") {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "w",
    });
  }
  console.log(
    JSON.stringify({
      action,
      total: manifest.entries.length,
      existing,
      editedExisting,
      created,
      pending: manifest.entries.length - existing - editedExisting - created,
      manifestPath,
    }),
  );
} finally {
  await prisma.$disconnect();
}

function required(key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function buildManifest(root: string): Promise<Manifest> {
  const paths = await listMdx(root);
  const entries: Entry[] = [];
  for (const sourcePath of paths) {
    const sourceText = await readFile(sourcePath, "utf8");
    const sourceRelative = relative(root, sourcePath).replaceAll("\\", "/");
    // resume.mdx is a resume page, not a /blog post.
    if (sourceRelative === "resume.mdx") continue;
    const expectedSlug = sourceRelative
      .replace(/\.mdx$/, "")
      .replace(/\/index$/, "");
    const ingest = ingestMdxArticle(sourceText, {
      sourcePath,
      contentRoot: root,
    });
    if (ingest.slug !== expectedSlug || ingest.sourceText !== sourceText) {
      throw new Error(
        `Source path/slug or source round-trip mismatch: ${sourceRelative} => ${ingest.slug}`,
      );
    }
    entries.push({
      sourcePath: sourceRelative,
      slug: expectedSlug,
      sourceSha256: hash(sourceText),
      sourceBytes: Buffer.byteLength(sourceText),
      unsupportedComponents: [
        ...new Set(ingest.unsupportedComponents.map((item) => item.name)),
      ],
    });
  }
  if (new Set(entries.map((entry) => entry.slug)).size !== entries.length) {
    throw new Error("Duplicate source slugs");
  }
  return { version: 1, contentRoot: root, entries };
}

async function listMdx(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, item.name);
    if (item.isDirectory()) result.push(...(await listMdx(path)));
    else if (item.isFile() && item.name.endsWith(".mdx")) result.push(path);
  }
  return result.sort();
}

async function verifyBackup(path: string): Promise<void> {
  const file = await stat(resolve(path));
  if (!file.isFile() || file.size < 1024)
    throw new Error("Backup file missing or too small");
  if (Date.now() - file.mtimeMs > 24 * 60 * 60 * 1000) {
    throw new Error("Backup is older than 24 hours");
  }
  const result = spawnSync(
    process.env.PG_RESTORE_BIN ?? "pg_restore",
    ["--list", resolve(path)],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Backup pg_restore inspection failed: ${result.stderr ?? result.error ?? "unknown"}`,
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.slice(1),
  );
  if (!result.stdout.includes(`dbname: ${databaseName}\n`)) {
    throw new Error("Backup database name does not match DATABASE_URL");
  }
}
