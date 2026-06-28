import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { ArticleRepository } from "../src/repositories/articles.js";
import { ArticleService } from "../src/services/articles.js";
import { importMdxArticleDraft } from "../src/services/article-ingest.js";
import { ingestMdxArticle } from "../src/services/mdx-ingest.js";

interface CliOptions {
  contentRoot?: string;
  writeDb: boolean;
  files: string[];
}

const options = parseArgs(process.argv.slice(2));

if (!options.files.length) {
  console.error(
    "Usage: pnpm mdx:ingest [--content-root <path>] [--write-db] <file.mdx> [...file.mdx]",
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

    if (service) {
      const { ingest, article } = await importMdxArticleDraft(
        service,
        sourceText,
        ingestOptions,
      );
      printSummary(sourcePath, ingest, article.id);
    } else {
      const ingest = ingestMdxArticle(sourceText, ingestOptions);
      printSummary(sourcePath, ingest);
    }
  }
} finally {
  await prisma?.$disconnect();
}

function parseArgs(args: string[]): CliOptions {
  const parsed: CliOptions = { writeDb: false, files: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write-db") {
      parsed.writeDb = true;
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
  ingest: ReturnType<typeof ingestMdxArticle>,
  articleId?: string,
): void {
  console.log(
    JSON.stringify(
      {
        sourcePath: relative(process.cwd(), sourcePath),
        articleId,
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
