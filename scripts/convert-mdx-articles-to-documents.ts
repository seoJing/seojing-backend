import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { ArticleRepository } from "../src/repositories/articles.js";
import {
  ArticleService,
  type DocumentEditorInput,
  validateDocumentDraftInput,
} from "../src/services/articles.js";
import { convertMdxToArticleDocument } from "../src/services/mdx-to-document.js";

type Entry = {
  sourcePath: string;
  slug: string;
  sourceSha256: string;
  documentSha256: string;
  blockCount: number;
};
type Manifest = { version: 1; contentRoot: string; entries: Entry[] };

const [action, ...args] = process.argv.slice(2);
if (action !== "--plan" && action !== "--apply" && action !== "--publish")
  throw new Error(
    "Usage: --plan|--apply|--publish --content-root PATH --manifest PATH [--backup-file PATH]",
  );
const flags = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (
    !key ||
    !value ||
    !["--content-root", "--manifest", "--backup-file"].includes(key)
  )
    throw new Error(`Invalid argument: ${key ?? "missing"}`);
  flags.set(key, value);
}
const required = (key: string) => {
  const value = flags.get(key);
  if (!value) throw new Error(`${key} is required`);
  return resolve(value);
};
const contentRoot = required("--content-root");
const manifestPath = required("--manifest");
const current = await buildManifest(contentRoot);

if (action === "--plan") {
  await writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`, {
    flag: "w",
  });
  console.log(
    JSON.stringify({ action, files: current.entries.length, manifestPath }),
  );
} else {
  const approved = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (
    approved.version !== 1 ||
    approved.contentRoot !== contentRoot ||
    JSON.stringify(approved.entries) !== JSON.stringify(current.entries)
  )
    throw new Error("Manifest or source files changed since plan.");
  await verifyBackup(required("--backup-file"));
  const prisma = new PrismaClient();
  const service = new ArticleService(new ArticleRepository(prisma));
  try {
    const pending: Array<{
      entry: Entry;
      revisionId: string;
      category: string;
    }> = [];
    const readyToPublish: Array<{ entry: Entry; revisionId: string }> = [];
    const skipped: string[] = [];
    const conflicts: string[] = [];
    for (const entry of approved.entries) {
      const article = await service.getArticleBySlug(entry.slug);
      if (!article || article.slug !== entry.slug) {
        conflicts.push(`${entry.slug}: article missing or slug mismatch`);
        continue;
      }
      const latest = article.revisions[0];
      if (!latest) {
        conflicts.push(`${entry.slug}: no revision`);
        continue;
      }
      if (latest.sourceFormat === "DOCUMENT") {
        if (
          latest.changeSummary ===
            `Convert MDX to document: ${entry.sourceSha256}` &&
          sha(stableJson(latest.document)) === entry.documentSha256
        ) {
          if (
            action === "--publish" &&
            !(
              article.status === "PUBLISHED" &&
              article.currentRevisionId === latest.id
            )
          )
            readyToPublish.push({ entry, revisionId: latest.id });
          else skipped.push(entry.slug);
        } else
          conflicts.push(
            `${entry.slug}: existing document differs from manifest`,
          );
        continue;
      }
      if (action === "--publish") {
        conflicts.push(
          `${entry.slug}: latest revision is not a converted document`,
        );
        continue;
      }
      if (latest.sourceFormat !== "MDX") {
        skipped.push(entry.slug);
        continue;
      }
      if (
        sha(latest.sourceText) !== entry.sourceSha256 &&
        sha(`${latest.sourceText}\n`) !== entry.sourceSha256
      ) {
        conflicts.push(`${entry.slug}: source hash differs`);
        continue;
      }
      pending.push({
        entry,
        revisionId: latest.id,
        category: article.category,
      });
    }
    if (conflicts.length)
      throw new Error(
        `Preflight conflicts; no articles changed:\n${conflicts.join("\n")}`,
      );

    if (action === "--publish") {
      for (const { entry, revisionId } of readyToPublish) {
        const updated = await service.publishCurrentRevision(entry.slug);
        if (
          !updated ||
          updated.status !== "PUBLISHED" ||
          updated.currentRevisionId !== revisionId ||
          updated.currentRevision?.sourceFormat !== "DOCUMENT"
        )
          throw new Error(`Publication readback mismatch: ${entry.slug}`);
        console.log(
          JSON.stringify({
            published: entry.slug,
            revision: updated.currentRevision.revisionNumber,
          }),
        );
      }
      console.log(
        JSON.stringify({
          action,
          published: readyToPublish.length,
          skipped: skipped.length,
          total: approved.entries.length,
        }),
      );
    } else {
      for (const { entry, revisionId, category } of pending) {
        const source = await readFile(
          resolve(contentRoot, entry.sourcePath),
          "utf8",
        );
        const { document, frontmatter } = convertMdxToArticleDocument(source);
        const input = frontmatterInput(frontmatter, document, revisionId);
        input.category = category;
        const updated = await service.convertMdxArticleToDocument(
          entry.slug,
          input,
          entry.sourceSha256,
        );
        if (
          !updated ||
          updated.revisions[0]?.sourceFormat !== "DOCUMENT" ||
          sha(stableJson(updated.revisions[0].document)) !==
            entry.documentSha256 ||
          updated.revisions[0].changeSummary !==
            `Convert MDX to document: ${entry.sourceSha256}`
        )
          throw new Error(`Conversion readback mismatch: ${entry.slug}`);
        console.log(
          JSON.stringify({
            converted: entry.slug,
            status: updated.status,
            revision: updated.revisions[0].revisionNumber,
          }),
        );
      }
      console.log(
        JSON.stringify({
          action,
          converted: pending.length,
          skipped: skipped.length,
          total: approved.entries.length,
          publicVisibilityChanged: false,
        }),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function buildManifest(root: string): Promise<Manifest> {
  const paths: string[] = [];
  async function collect(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, item.name);
      if (item.isDirectory()) await collect(child);
      else if (
        item.isFile() &&
        item.name.endsWith(".mdx") &&
        resolve(root, item.name) !== resolve(root, "resume.mdx")
      )
        paths.push(child);
    }
  }
  await collect(root);
  const entries: Entry[] = [];
  for (const path of paths.sort()) {
    const source = await readFile(path, "utf8");
    const { document, frontmatter } = convertMdxToArticleDocument(source);
    validateDocumentDraftInput(
      frontmatterInput(frontmatter, document, "preflight"),
    );
    const sourcePath = relative(root, path).replaceAll("\\", "/");
    const slug = sourcePath.replace(/\.mdx$/, "").replace(/\/index$/, "");
    entries.push({
      sourcePath,
      slug,
      sourceSha256: sha(source),
      documentSha256: sha(stableJson(document)),
      blockCount: document.content.length,
    });
  }
  if (new Set(entries.map((entry) => entry.slug)).size !== entries.length)
    throw new Error("Duplicate slugs.");
  return { version: 1, contentRoot: root, entries };
}

function frontmatterInput(
  frontmatter: Record<string, unknown>,
  document: DocumentEditorInput["document"],
  expectedRevisionId: string,
): DocumentEditorInput {
  const title = frontmatter.title;
  const description = frontmatter.description;
  const tags = frontmatter.tags;
  const cover = frontmatter.cover;
  const video = frontmatter.summaryVideo;
  if (
    typeof title !== "string" ||
    typeof description !== "string" ||
    !Array.isArray(tags) ||
    tags.some((tag) => typeof tag !== "string")
  )
    throw new Error("Invalid article frontmatter title, description or tags.");
  if (
    cover !== undefined &&
    (!isRecord(cover) ||
      typeof cover.src !== "string" ||
      typeof cover.alt !== "string")
  )
    throw new Error("Invalid cover frontmatter.");
  if (
    video !== undefined &&
    (!isRecord(video) || typeof video.src !== "string")
  )
    throw new Error("Invalid summary video frontmatter.");
  const date = frontmatter.date;
  const updated = frontmatter.updated;
  if (
    (date !== undefined && typeof date !== "string") ||
    (updated !== undefined && typeof updated !== "string")
  )
    throw new Error("Invalid article dates.");
  return {
    title,
    description,
    tags: tags as string[],
    cover: cover as DocumentEditorInput["cover"],
    summaryVideo: video as DocumentEditorInput["summaryVideo"],
    displayDate: date,
    displayUpdatedAt: updated,
    expectedRevisionId,
    document,
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function verifyBackup(path: string): Promise<void> {
  const file = await stat(path);
  if (
    !file.isFile() ||
    file.size < 1024 ||
    Date.now() - file.mtimeMs > 24 * 60 * 60 * 1000
  )
    throw new Error("A valid backup from the last 24 hours is required.");
  const result = spawnSync(
    process.env.PG_RESTORE_BIN ?? "pg_restore",
    ["--list", path],
    { encoding: "utf8" },
  );
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || result.status !== 0 || result.error)
    throw new Error("Backup inspection or DATABASE_URL failed.");
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.slice(1),
  );
  if (!result.stdout.includes(`dbname: ${databaseName}\n`))
    throw new Error("Backup database name does not match DATABASE_URL.");
}
