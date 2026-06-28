import type { ArticleBlock } from "@prisma/client";

import type { ArticleWithContent } from "../repositories/articles.js";
import type { ArticleService } from "./articles.js";
import { PythonWorkerError, type PythonWorkerClient } from "./python-worker.js";

export type ArticleQaErrorCode =
  | "validation_error"
  | "article_not_found"
  | "section_not_found";

export class ArticleQaServiceError extends Error {
  constructor(
    public readonly code: ArticleQaErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ArticleQaServiceError";
  }
}

export interface ArticleQaInput {
  slug: string;
  question: string;
  sectionId?: string;
  sessionId?: string;
  requestId?: string;
  signal?: AbortSignal;
}

export interface ArticleQaSource {
  articleSlug: string;
  blockId: string;
  sectionId: string | null;
  heading: string | null;
  excerpt: string;
  score: number;
}

export interface ArticleQaAnswer {
  ok: true;
  slug: string;
  sectionId: string | null;
  sessionId: string | null;
  answer: string;
  status: "answered" | "insufficient_context";
  mode: "worker" | "fallback";
  sources: ArticleQaSource[];
  related: Array<{ slug: string; title: string }>;
  error?: { code: string; message: string };
}

interface ArticleQaWorkerResult {
  answer?: unknown;
  status?: unknown;
  sources?: unknown;
  related?: unknown;
}

interface ArticleQaContextChunk extends ArticleQaSource {
  text: string;
}

const maxQuestionChars = 600;
const maxSessionIdChars = 120;
const maxChunks = 6;

export class ArticleQaService {
  constructor(
    private readonly articleService: ArticleService,
    private readonly pythonWorkerClient?: Partial<
      Pick<PythonWorkerClient, "invoke">
    >,
  ) {}

  async answer(input: ArticleQaInput): Promise<ArticleQaAnswer> {
    const slug = normalizeSlug(input.slug);
    const question = normalizeQuestion(input.question);
    const sectionId = normalizeOptionalId(input.sectionId, "section_id");
    const sessionId = normalizeSessionId(input.sessionId);

    const article = await this.articleService.getPublicArticleBySlug(slug);
    if (!article) {
      throw new ArticleQaServiceError(
        "article_not_found",
        "Article not found",
        404,
      );
    }

    const context = buildContext(article, sectionId, question);
    if (sectionId && !context.sectionExists) {
      throw new ArticleQaServiceError(
        "section_not_found",
        "Article section not found",
        404,
      );
    }

    const fallback = makeFallbackAnswer({
      article,
      question,
      sectionId,
      sessionId,
      chunks: context.chunks,
    });

    if (!this.pythonWorkerClient?.invoke || context.chunks.length === 0) {
      return fallback;
    }

    try {
      const response =
        await this.pythonWorkerClient.invoke<ArticleQaWorkerResult>(
          "qa",
          {
            article: {
              slug: article.slug,
              title: scrubLocalPaths(article.title),
              sectionId: sectionId ?? null,
            },
            question,
            sessionId: sessionId ?? null,
            context: context.chunks.map((chunk) => ({
              blockId: chunk.blockId,
              sectionId: chunk.sectionId,
              heading: chunk.heading,
              text: chunk.text,
              excerpt: chunk.excerpt,
              score: chunk.score,
            })),
          },
          { requestId: input.requestId, signal: input.signal },
        );
      return normalizeWorkerAnswer(response.result, fallback);
    } catch (error) {
      return {
        ...fallback,
        error: {
          code:
            error instanceof PythonWorkerError ? error.code : "worker_error",
          message:
            "Python QA worker was unavailable; returned source-backed fallback.",
        },
      };
    }
  }
}

function buildContext(
  article: ArticleWithContent,
  sectionId: string | undefined,
  question: string,
): { sectionExists: boolean; chunks: ArticleQaContextChunk[] } {
  const blocks = currentRevisionBlocks(article);
  const scopedBlocks = scopeBlocks(blocks, sectionId);
  const candidateBlocks = sectionId ? scopedBlocks.blocks : blocks;
  const chunks = candidateBlocks
    .map((block) => toContextChunk(article.slug, block, question))
    .filter((chunk): chunk is ArticleQaContextChunk => Boolean(chunk))
    .sort((a, b) => b.score - a.score || a.blockId.localeCompare(b.blockId))
    .slice(0, maxChunks);

  return { sectionExists: scopedBlocks.sectionExists, chunks };
}

function scopeBlocks(
  blocks: ArticleBlock[],
  sectionId: string | undefined,
): { sectionExists: boolean; blocks: ArticleBlock[] } {
  if (!sectionId) {
    return { sectionExists: true, blocks };
  }
  const startIndex = blocks.findIndex(
    (block) => block.type === "HEADING" && blockSectionId(block) === sectionId,
  );
  if (startIndex === -1) {
    return { sectionExists: false, blocks: [] };
  }
  const startDepth = headingDepth(blocks[startIndex]!) ?? 2;
  const sectionBlocks = [blocks[startIndex]!];
  for (const block of blocks.slice(startIndex + 1)) {
    if (block.type === "HEADING" && (headingDepth(block) ?? 2) <= startDepth) {
      break;
    }
    sectionBlocks.push(block);
  }
  return { sectionExists: true, blocks: sectionBlocks };
}

function toContextChunk(
  articleSlug: string,
  block: ArticleBlock,
  question: string,
): ArticleQaContextChunk | null {
  const text = blockText(block);
  if (!text) {
    return null;
  }
  const score = scoreText(text, question);
  const sectionId = blockSectionId(block);
  return {
    articleSlug,
    blockId: block.id,
    sectionId,
    heading: block.type === "HEADING" ? text : null,
    text,
    excerpt: excerpt(text),
    score,
  };
}

function makeFallbackAnswer(input: {
  article: ArticleWithContent;
  question: string;
  sectionId?: string;
  sessionId?: string;
  chunks: ArticleQaContextChunk[];
}): ArticleQaAnswer {
  const sources = input.chunks
    .filter((chunk) => chunk.score > 0)
    .map((chunk) => ({
      articleSlug: chunk.articleSlug,
      blockId: chunk.blockId,
      sectionId: chunk.sectionId,
      heading: chunk.heading,
      excerpt: chunk.excerpt,
      score: chunk.score,
    }));
  if (sources.length === 0 || sources[0]!.score < 1) {
    return {
      ok: true,
      slug: input.article.slug,
      sectionId: input.sectionId ?? null,
      sessionId: input.sessionId ?? null,
      answer:
        "이 질문에 답할 만큼 강한 근거를 글 본문에서 찾지 못했어요. 질문을 더 구체적으로 바꾸거나 관련 본문 위치를 열어 확인해 주세요.",
      status: "insufficient_context",
      mode: "fallback",
      sources,
      related: [],
    };
  }

  const sectionPhrase = input.sectionId
    ? `section ${input.sectionId}`
    : "the article";
  return {
    ok: true,
    slug: input.article.slug,
    sectionId: input.sectionId ?? null,
    sessionId: input.sessionId ?? null,
    answer: `Found source-backed context in ${sectionPhrase}. Use the cited excerpts first; generation is intentionally conservative when the Python QA worker is unavailable.`,
    status: "answered",
    mode: "fallback",
    sources,
    related: [
      { slug: input.article.slug, title: scrubLocalPaths(input.article.title) },
    ],
  };
}

function normalizeWorkerAnswer(
  result: ArticleQaWorkerResult,
  fallback: ArticleQaAnswer,
): ArticleQaAnswer {
  const answer = typeof result.answer === "string" ? result.answer.trim() : "";
  const status =
    result.status === "answered" || result.status === "insufficient_context"
      ? result.status
      : fallback.status;
  if (!answer) {
    return fallback;
  }

  return {
    ...fallback,
    answer: scrubLocalPaths(answer),
    status,
    mode: "worker",
    sources: normalizeWorkerSources(result.sources, fallback.sources),
    related: normalizeRelated(result.related, fallback.related),
  };
}

function normalizeWorkerSources(
  value: unknown,
  fallback: ArticleQaSource[],
): ArticleQaSource[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const sources = value
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      const blockId = readString(item.blockId) ?? readString(item.block_id);
      const articleSlug =
        readString(item.articleSlug) ?? readString(item.article_slug);
      const excerptValue = readString(item.excerpt);
      if (!blockId || !articleSlug || !excerptValue) {
        return null;
      }
      return {
        articleSlug: scrubLocalPaths(articleSlug),
        blockId: scrubLocalPaths(blockId),
        sectionId:
          readString(item.sectionId) ?? readString(item.section_id) ?? null,
        heading: readString(item.heading) ?? null,
        excerpt: excerpt(scrubLocalPaths(excerptValue)),
        score: readNumber(item.score) ?? 1,
      } satisfies ArticleQaSource;
    })
    .filter((source): source is ArticleQaSource => Boolean(source));
  return sources.length ? sources.slice(0, maxChunks) : fallback;
}

function normalizeRelated(
  value: unknown,
  fallback: Array<{ slug: string; title: string }>,
): Array<{ slug: string; title: string }> {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const related = value
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      const slug = readString(item.slug);
      const title = readString(item.title);
      return slug && title
        ? { slug: scrubLocalPaths(slug), title: scrubLocalPaths(title) }
        : null;
    })
    .filter((item): item is { slug: string; title: string } => Boolean(item));
  return related.slice(0, 5);
}

function currentRevisionBlocks(article: ArticleWithContent): ArticleBlock[] {
  return article.blocks.filter(
    (block) => block.revisionId === article.currentRevisionId,
  );
}

function blockText(block: ArticleBlock): string {
  const content = isRecord(block.content) ? block.content : {};
  return scrubLocalPaths(
    block.plainText ??
      readString(content.text) ??
      readString(content.body) ??
      readString(content.code) ??
      "",
  ).trim();
}

function blockSectionId(block: ArticleBlock): string | null {
  const content = isRecord(block.content) ? block.content : {};
  const metadata = isRecord(block.metadata) ? block.metadata : {};
  return (
    readString(content.id) ??
    readString(metadata.sectionId) ??
    readString(metadata.section_id) ??
    null
  );
}

function headingDepth(block: ArticleBlock): number | null {
  const content = isRecord(block.content) ? block.content : {};
  const level = readNumber(content.level) ?? readNumber(content.depth);
  return level ? Math.min(Math.max(level, 1), 6) : null;
}

function scoreText(text: string, question: string): number {
  const terms = tokenize(question);
  if (terms.length === 0) {
    return 0;
  }
  const textTerms = new Set(tokenize(text));
  return terms.reduce(
    (score, term) => score + (textTerms.has(term) ? 1 : 0),
    0,
  );
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function excerpt(value: string): string {
  const singleLine = scrubLocalPaths(value).replace(/\s+/g, " ").trim();
  return singleLine.length > 240
    ? `${singleLine.slice(0, 237)}...`
    : singleLine;
}

function normalizeSlug(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    throw new ArticleQaServiceError(
      "validation_error",
      "article slug is required",
      400,
    );
  }
  return normalized;
}

function normalizeQuestion(value: string): string {
  if (typeof value !== "string") {
    throw new ArticleQaServiceError(
      "validation_error",
      "question is required",
      400,
    );
  }
  const question = value.trim();
  if (question.length < 2) {
    throw new ArticleQaServiceError(
      "validation_error",
      "question is required",
      400,
    );
  }
  if (question.length > maxQuestionChars) {
    throw new ArticleQaServiceError(
      "validation_error",
      `question must be <= ${maxQuestionChars} characters`,
      400,
    );
  }
  return question;
}

function normalizeOptionalId(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) {
    throw new ArticleQaServiceError(
      "validation_error",
      `${field} must be a short section identifier`,
      400,
    );
  }
  return value;
}

function normalizeSessionId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(value) || value.length > maxSessionIdChars) {
    throw new ArticleQaServiceError(
      "validation_error",
      "session_id must be an opaque short identifier",
      400,
    );
  }
  return value;
}

function scrubLocalPaths(value: string): string {
  return value
    .replace(/\/Users\/[^\s)"']+/g, "[local-path]")
    .replace(/\/tmp\/[^\s)"']+/g, "[local-path]")
    .replace(/\/private\/tmp\/[^\s)"']+/g, "[local-path]");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
