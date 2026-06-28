import type { ArticleWithContent } from "../repositories/articles.js";
import type { ArticleService } from "./articles.js";
import {
  ingestMdxArticle,
  type MdxIngestOptions,
  type MdxIngestResult,
} from "./mdx-ingest.js";

export interface ImportMdxArticleResult {
  ingest: MdxIngestResult;
  article: ArticleWithContent;
}

export async function importMdxArticleDraft(
  articleService: ArticleService,
  sourceText: string,
  options: MdxIngestOptions = {},
): Promise<ImportMdxArticleResult> {
  const ingest = ingestMdxArticle(sourceText, options);
  const article = await articleService.createInitialDraft({
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

  return { ingest, article };
}
