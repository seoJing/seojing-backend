import type { ArticleBlockType, Prisma } from "@prisma/client";

import type { ArticleBlockDraft } from "../repositories/articles.js";

export interface BlockEditorBlockInput {
  id?: string;
  type: ArticleBlockType;
  content: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const supportedBlockTypes = new Set<ArticleBlockType>([
  "PARAGRAPH",
  "HEADING",
  "CODE",
  "IMAGE",
  "CALLOUT",
  "QUIZ",
]);

export function normalizeBlockEditorInputs(
  blocks: BlockEditorBlockInput[],
): ArticleBlockDraft[] {
  if (!Array.isArray(blocks)) {
    throw new Error("Article blocks must be an array.");
  }
  return blocks.map((block, index) => normalizeBlockEditorInput(block, index));
}

export function normalizeBlockEditorInput(
  block: BlockEditorBlockInput,
  sortOrder: number,
): ArticleBlockDraft {
  const type = block.type;
  if (!supportedBlockTypes.has(type)) {
    throw new Error(`Unsupported article block type: ${type}`);
  }

  const content = normalizeBlockContent(type, block.content);
  return {
    type,
    sortOrder,
    content: content as Prisma.InputJsonValue,
    plainText: blockPlainText(type, content),
    metadata: block.metadata as Prisma.InputJsonValue | undefined,
  };
}

export function renderArticleBlocks(blocks: ArticleBlockDraft[]): string {
  return blocks.map(renderArticleBlock).filter(Boolean).join("\n");
}

export function blocksToSourceText(blocks: ArticleBlockDraft[]): string {
  return blocks.map(blockToSourceText).filter(Boolean).join("\n\n");
}

function normalizeBlockContent(
  type: ArticleBlockType,
  content: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(content)) {
    throw new Error("Article block content must be an object.");
  }

  switch (type) {
    case "PARAGRAPH":
      return { text: requiredText(content.text, "paragraph text") };
    case "HEADING": {
      const text = requiredText(content.text, "heading text");
      const level = clampHeadingLevel(content.level);
      return {
        level,
        text,
        id: optionalText(content.id) ?? slugifyForId(text),
      };
    }
    case "CODE":
      return {
        code: requiredText(content.code, "code block code"),
        language: optionalText(content.language) ?? "text",
      };
    case "IMAGE":
      return {
        url: requiredText(content.url, "image url"),
        alt: optionalText(content.alt) ?? "",
        caption: optionalText(content.caption),
      };
    case "CALLOUT":
      return {
        tone: optionalText(content.tone) ?? "note",
        title: optionalText(content.title),
        text: requiredText(content.text, "callout text"),
      };
    case "QUIZ":
      return {
        question: requiredText(content.question, "quiz question"),
        choices: normalizeChoices(content.choices),
        answer: optionalText(content.answer),
        explanation: optionalText(content.explanation),
      };
    default:
      return content;
  }
}

function renderArticleBlock(block: ArticleBlockDraft): string {
  const content: Record<string, unknown> = isRecord(block.content)
    ? block.content
    : {};
  switch (block.type) {
    case "PARAGRAPH":
      return `<p>${escapeHtml(readString(content.text) ?? "")}</p>`;
    case "HEADING": {
      const level = clampHeadingLevel(content.level);
      const text = readString(content.text) ?? "";
      const id = readString(content.id) ?? slugifyForId(text);
      return `<h${level} id="${escapeAttribute(id)}">${escapeHtml(text)}</h${level}>`;
    }
    case "CODE": {
      const language = readString(content.language) ?? "text";
      const code = readString(content.code) ?? "";
      return `<pre><code class="language-${escapeAttribute(language)}">${escapeHtml(code)}</code></pre>`;
    }
    case "IMAGE": {
      const url = readString(content.url) ?? "";
      const alt = readString(content.alt) ?? "";
      const caption = readString(content.caption);
      const image = `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}" />`;
      if (!caption) {
        return image;
      }
      return `<figure>${image}<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
    }
    case "CALLOUT": {
      const tone = readString(content.tone) ?? "note";
      const title = readString(content.title);
      const text = readString(content.text) ?? "";
      const titleHtml = title ? `<strong>${escapeHtml(title)}</strong>` : "";
      return `<aside data-callout-tone="${escapeAttribute(tone)}">${titleHtml}<p>${escapeHtml(text)}</p></aside>`;
    }
    case "QUIZ": {
      const question = readString(content.question) ?? "";
      const choices = Array.isArray(content.choices) ? content.choices : [];
      const choiceHtml = choices
        .map((choice) => `<li>${escapeHtml(String(choice))}</li>`)
        .join("");
      const answer = readString(content.answer);
      const explanation = readString(content.explanation);
      return `<section data-block-type="quiz"><p>${escapeHtml(question)}</p>${
        choiceHtml ? `<ol>${choiceHtml}</ol>` : ""
      }${
        answer
          ? `<details><summary>정답</summary><p>${escapeHtml(answer)}</p>${
              explanation ? `<p>${escapeHtml(explanation)}</p>` : ""
            }</details>`
          : ""
      }</section>`;
    }
    default:
      return "";
  }
}

function blockToSourceText(block: ArticleBlockDraft): string {
  const content: Record<string, unknown> = isRecord(block.content)
    ? block.content
    : {};
  switch (block.type) {
    case "PARAGRAPH":
      return readString(content.text) ?? "";
    case "HEADING":
      return `${"#".repeat(clampHeadingLevel(content.level))} ${readString(content.text) ?? ""}`;
    case "CODE":
      return `\`\`\`${readString(content.language) ?? "text"}\n${readString(content.code) ?? ""}\n\`\`\``;
    case "IMAGE":
      return `![${readString(content.alt) ?? ""}](${readString(content.url) ?? ""})`;
    case "CALLOUT":
      return `> ${readString(content.title) ? `${readString(content.title)}: ` : ""}${readString(content.text) ?? ""}`;
    case "QUIZ":
      return `Quiz: ${readString(content.question) ?? ""}`;
    default:
      return block.plainText ?? "";
  }
}

function blockPlainText(
  type: ArticleBlockType,
  content: Record<string, unknown>,
): string | undefined {
  switch (type) {
    case "PARAGRAPH":
    case "HEADING":
      return readString(content.text);
    case "CODE":
      return readString(content.code);
    case "IMAGE":
      return readString(content.alt) ?? readString(content.caption);
    case "CALLOUT":
      return [readString(content.title), readString(content.text)]
        .filter(Boolean)
        .join(" — ");
    case "QUIZ":
      return readString(content.question);
    default:
      return undefined;
  }
}

function normalizeChoices(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Quiz choices must be an array when provided.");
  }
  return value.map((choice) => requiredText(choice, "quiz choice"));
}

function requiredText(value: unknown, field: string): string {
  const text = optionalText(value);
  if (!text) {
    throw new Error(`Article block ${field} is required.`);
  }
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function clampHeadingLevel(value: unknown): number {
  const level = typeof value === "number" ? value : Number(value ?? 2);
  if (!Number.isFinite(level)) {
    return 2;
  }
  return Math.min(Math.max(Math.trunc(level), 1), 6);
}

function slugifyForId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9가-힣_-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
