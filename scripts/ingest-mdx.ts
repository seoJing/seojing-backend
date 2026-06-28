import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { ArticleRepository } from "../src/repositories/articles.js";
import { ArticleService } from "../src/services/articles.js";
import {
  ingestMdxArticle,
  type MdxIngestResult,
} from "../src/services/mdx-ingest.js";

interface CliOptions {
  contentRoot?: string;
  writeDb: boolean;
  publish: boolean;
  files: string[];
}

const options = parseArgs(process.argv.slice(2));

if (!options.files.length) {
  console.error(
    "Usage: pnpm mdx:ingest [--content-root <path>] [--write-db] [--publish] <file.mdx> [...file.mdx]",
  );
  process.exit(1);
}

if (options.publish && !options.writeDb) {
  console.error(
    "--publish requires --write-db because publish state is stored in the database.",
  );
  process.exit(1);
}

const prisma = options.writeDb ? new PrismaClient() : undefined;
const service = prisma
  ? new ArticleService(new ArticleRepository(prisma))
  : undefined;

try {
  for (const file of options.files) {
    const sourcePath = resolve(file);
    const sourceText = await readFile(sourcePath, "utf8");
    const ingestOptions = {
      sourcePath,
      contentRoot: options.contentRoot
        ? resolve(options.contentRoot)
        : undefined,
    };

    const ingest = ingestMdxArticle(sourceText, ingestOptions);

    if (service) {
      const article = await upsertMdxArticle(service, ingest);
      const publishedArticle = options.publish
        ? await service.publishCurrentRevision(ingest.slug)
        : article;
      printSummary(
        sourcePath,
        ingest,
        (publishedArticle ?? article).id,
        (publishedArticle ?? article).status,
      );
    } else {
      printSummary(sourcePath, ingest);
    }
  }
} finally {
  await prisma?.$disconnect();
}

function parseArgs(args: string[]): CliOptions {
  const parsed: CliOptions = { writeDb: false, publish: false, files: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write-db") {
      parsed.writeDb = true;
      continue;
    }
    if (arg === "--publish") {
      parsed.publish = true;
      continue;
    }
    if (arg === "--content-root") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--content-root requires a path.");
      }
      parsed.contentRoot = value;
      index += 1;
      continue;
    }
    if (arg) {
      parsed.files.push(arg);
    }
  }

  return parsed;
}

function printSummary(
  sourcePath: string,
  ingest: MdxIngestResult,
  articleId?: string,
  status?: string,
): void {
  console.log(
    JSON.stringify(
      {
        sourcePath: relative(process.cwd(), sourcePath),
        articleId,
        status,
        slug: ingest.slug,
        title: ingest.title,
        description: ingest.description,
        tocCount: ingest.toc.length,
        blockCount: ingest.blocks.length,
        assetCount: ingest.assets.length,
        unsupportedComponents: ingest.unsupportedComponents,
        renderedHtmlPreview: ingest.renderedHtml.slice(0, 240),
      },
      null,
      2,
    ),
  );
}

async function upsertMdxArticle(
  service: ArticleService,
  ingest: MdxIngestResult,
) {
  const existing = await service.getArticleBySlug(ingest.slug);
  if (!existing) {
    return service.createInitialDraft({
      slug: ingest.slug,
      title: ingest.title,
      description: ingest.description,
      sourceFormat: "MDX",
      sourceText: ingest.sourceText,
      renderedHtml: ingest.renderedHtml,
      blocks: ingest.blocks,
      assets: ingest.assets,
      changeSummary: "Imported from SEOJing MDX source",
      authorName: "SEOJing MDX ingest",
    });
  }

  const updated = await service.createEditorRevision(ingest.slug, {
    title: ingest.title,
    description: ingest.description,
    sourceText: ingest.sourceText,
    renderedHtml: ingest.renderedHtml,
    blocks: ingest.blocks,
    assets: ingest.assets,
    changeSummary: "Updated from SEOJing MDX source",
    authorName: "SEOJing MDX ingest",
  });

  if (!updated) {
    throw new Error(`Failed to update article: ${ingest.slug}`);
  }

  return updated;
}
