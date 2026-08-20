import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { ingestMdxArticle } from "../src/services/mdx-ingest.js";
import { assessStudyMigration } from "../src/services/study-migration-registry.js";

const defaultSeries = ["javascript-quizbook", "effective-typescript"];

interface CliOptions {
  contentRoot?: string;
  noDb: boolean;
  series: string[];
}

const options = parseArgs(process.argv.slice(2));
const contentRoot = options.contentRoot;
if (!contentRoot) {
  throw new Error(
    "--content-root <path> or SEOJING_CONTENT_ROOT is required; the audit never guesses a sibling checkout.",
  );
}
const sourceFiles = await collectStudyFiles(contentRoot, options.series);
const sources = await Promise.all(
  sourceFiles.map(async (sourcePath) => ({
    sourcePath,
    sourceText: await readFile(sourcePath, "utf8"),
  })),
);
const ingests = sources.map(({ sourcePath, sourceText }) =>
  ingestMdxArticle(sourceText, {
    sourcePath,
    contentRoot: options.contentRoot,
  }),
);
const db = options.noDb ? undefined : new PrismaClient();

try {
  const existing = db
    ? await db.article.findMany({
        where: { slug: { in: ingests.map((ingest) => ingest.slug) } },
        select: {
          slug: true,
          status: true,
          currentRevisionId: true,
        },
      })
    : [];
  const articlesBySlug = new Map(
    existing.map((article) => [article.slug, article]),
  );
  const entries = ingests
    .map((ingest, index) => {
      const article = articlesBySlug.get(ingest.slug);
      const quizzes = ingest.blocks
        .filter((block) => block.type === "QUIZ")
        .map((block) => {
          const content: unknown = block.content;
          const record = isRecord(content) ? content : {};
          const items = Array.isArray(record.items) ? record.items : [];
          return { itemCount: items.length };
        });
      const assessment = assessStudyMigration({
        slug: ingest.slug,
        articleStatus: article?.status,
        hasCurrentRevision: Boolean(article?.currentRevisionId),
        unsupportedComponents: ingest.unsupportedComponents,
        quizzes,
      });
      const assessmentFields = {
        status: assessment.status,
        nextStep: assessment.nextStep,
        reasons: assessment.reasons,
      };

      return {
        slug: ingest.slug,
        sourcePath: relative(contentRoot, sources[index]?.sourcePath ?? ""),
        title: ingest.title,
        blockCount: ingest.blocks.length,
        quizCount: quizzes.length,
        quizItemCount: quizzes.reduce(
          (total, quiz) => total + quiz.itemCount,
          0,
        ),
        unsupportedComponents: ingest.unsupportedComponents,
        database: article
          ? {
              status: article.status,
              hasCurrentRevision: Boolean(article.currentRevisionId),
            }
          : null,
        ...assessmentFields,
      };
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));
  const summary = entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return counts;
  }, {});

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "SEOJing study MDX + article DB read-only audit",
        dbChecked: Boolean(db),
        summary,
        entries,
      },
      null,
      2,
    ),
  );
} finally {
  await db?.$disconnect();
}

function parseArgs(args: string[]): CliOptions {
  const parsed: CliOptions = {
    contentRoot: process.env.SEOJING_CONTENT_ROOT
      ? resolve(process.env.SEOJING_CONTENT_ROOT)
      : undefined,
    noDb: false,
    series: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--content-root") {
      const value = args[index + 1];
      if (!value) throw new Error("--content-root requires a path.");
      parsed.contentRoot = resolve(value);
      index += 1;
    } else if (arg === "--series") {
      const value = args[index + 1];
      if (!value) throw new Error("--series requires a series folder name.");
      if (!/^[a-z0-9-]+$/.test(value)) {
        throw new Error(
          "--series accepts only lowercase letters, digits, and hyphens.",
        );
      }
      parsed.series.push(value);
      index += 1;
    } else if (arg === "--no-db") {
      parsed.noDb = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.series.length) parsed.series = defaultSeries;
  return parsed;
}

async function collectStudyFiles(
  contentRoot: string,
  series: string[],
): Promise<string[]> {
  const files = await Promise.all(
    series.map(async (seriesName) => {
      const directory = join(contentRoot, "study", seriesName);
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^day\d+\.mdx$/.test(entry.name))
        .map((entry) => join(directory, entry.name));
    }),
  );
  return files.flat();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
