import type {
  ArticleAssetDraft,
  ArticleBlockDraft,
} from "../repositories/articles.js";

export interface ArticleDocumentNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ArticleDocumentNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface ArticleDocument {
  type: "doc";
  content: ArticleDocumentNode[];
}

export interface RenderedArticleDocument {
  document: ArticleDocument;
  renderedHtml: string;
  plainText: string;
  blocks: ArticleBlockDraft[];
  assets: ArticleAssetDraft[];
}

const blockTypes = new Set([
  "paragraph",
  "heading",
  "codeBlock",
  "image",
  "bulletList",
  "orderedList",
  "blockquote",
  "horizontalRule",
  "table",
  "quiz",
  "callout",
]);
const inlineTypes = new Set(["text", "hardBreak"]);
const markTypes = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "textStyle",
]);
const imageSizes = new Set(["sm", "md", "lg", "full"]);

interface ValidatedQuizItem {
  question: string;
  mode: "multiple" | "description" | "essay";
  answer: string | number;
  choices?: string[];
  explanation?: string;
  code?: string;
  language?: string;
}

/** The revision document is the source of truth. HTML and blocks are disposable projections. */
export function renderArticleDocument(value: unknown): RenderedArticleDocument {
  try {
    return renderValidatedArticleDocument(value);
  } catch (error) {
    throw new ArticleDocumentValidationError(
      error instanceof Error ? error.message : "Invalid article document.",
    );
  }
}

export class ArticleDocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleDocumentValidationError";
  }
}

function renderValidatedArticleDocument(
  value: unknown,
): RenderedArticleDocument {
  if (!isRecord(value) || value.type !== "doc" || !Array.isArray(value.content))
    throw new Error("Article document must be a doc with content.");
  if (
    Object.keys(value).some((key) => !["type", "content"].includes(key)) ||
    JSON.stringify(value).length > 512 * 1024
  )
    throw new Error("Unsupported or oversized article document.");
  if (value.content.length > 10_000)
    throw new Error("Article document is too large.");
  const document = value as unknown as ArticleDocument;
  for (const node of document.content) validateNode(node, "block", 0);
  const assets: ArticleAssetDraft[] = [];
  const collectImages = (node: ArticleDocumentNode): void => {
    if (node.type === "image")
      assets.push({
        kind: "INLINE_IMAGE",
        url: stringAttr(node.attrs, "src"),
        altText: stringAttr(node.attrs, "alt"),
      });
    for (const child of node.content ?? []) collectImages(child);
  };
  const blocks = document.content.map((node, index): ArticleBlockDraft => {
    const type = toBlockType(node.type);
    const text = nodeText(node);
    collectImages(node);
    return {
      type,
      sortOrder: index,
      content: {
        node: structuredClone(node) as unknown as ArticleBlockDraft["content"],
        ...(node.type === "heading"
          ? {
              id: headingId(node, index),
              text,
              level: Number(node.attrs?.level),
            }
          : {}),
      },
      plainText: text,
    };
  });
  return {
    document: structuredClone(document),
    renderedHtml: document.content
      .map((node, index) =>
        renderBlock(
          node,
          node.type === "heading" ? headingId(node, index) : undefined,
        ),
      )
      .join("\n"),
    plainText: document.content.map(nodeText).filter(Boolean).join("\n\n"),
    blocks,
    assets,
  };
}

function validateNode(
  value: unknown,
  context: "block" | "inline" | "list" | "row" | "cell",
  depth: number,
): void {
  if (depth > 40) throw new Error("Article document nesting is too deep.");
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error("Invalid article document node.");
  const node = value as unknown as ArticleDocumentNode;
  if (
    Object.keys(value).some(
      (key) => !["type", "attrs", "content", "text", "marks"].includes(key),
    )
  )
    throw new Error("Unsupported article node property.");
  if (context === "block" && !blockTypes.has(node.type))
    throw new Error(`Unsupported article node: ${node.type}`);
  if (context === "inline" && !inlineTypes.has(node.type))
    throw new Error(`Unsupported inline node: ${node.type}`);
  if (context === "list" && node.type !== "listItem")
    throw new Error("Lists require list items.");
  if (context === "row" && node.type !== "tableRow")
    throw new Error("Tables require rows.");
  if (context === "cell" && !["tableCell", "tableHeader"].includes(node.type))
    throw new Error("Rows require cells.");
  const attrs = node.attrs ?? {};
  if (
    !isRecord(attrs) ||
    (node.content !== undefined && !Array.isArray(node.content))
  )
    throw new Error("Invalid article node attributes or content.");
  const allowedAttrs: Record<string, string[]> = {
    text: [],
    hardBreak: [],
    paragraph: [],
    heading: ["level"],
    codeBlock: ["language", "meta"],
    image: ["src", "alt", "caption", "size"],
    bulletList: [],
    orderedList: ["start"],
    listItem: [],
    blockquote: [],
    horizontalRule: [],
    table: [],
    tableRow: [],
    tableCell: ["colspan", "rowspan", "align"],
    tableHeader: ["colspan", "rowspan", "align"],
    quiz: ["title", "items"],
    callout: ["tone", "title"],
  };
  if (Object.keys(attrs).some((key) => !allowedAttrs[node.type]?.includes(key)))
    throw new Error(`Unsupported ${node.type} attribute.`);
  if (node.content && node.content.length > 10_000)
    throw new Error("Article node is too large.");
  if (node.type === "text") {
    if (typeof node.text !== "string" || node.text.length > 1_000_000)
      throw new Error("Invalid article text.");
    if (node.content) throw new Error("Text cannot contain child nodes.");
    if (node.marks && !Array.isArray(node.marks))
      throw new Error("Invalid article marks.");
    for (const mark of node.marks ?? []) validateMark(mark);
    return;
  }
  if (
    node.type === "codeBlock" &&
    (node.content ?? []).some(
      (child) => child.type !== "text" || child.marks?.length,
    )
  )
    throw new Error("Code blocks can only contain unmarked text.");
  if (
    node.type === "hardBreak" &&
    (node.attrs || node.content || node.text || node.marks)
  )
    throw new Error("Invalid line break.");
  if (node.text !== undefined || node.marks !== undefined)
    throw new Error("Only text nodes can have text or marks.");
  if (
    node.type === "heading" &&
    (!Number.isInteger(attrs.level) ||
      Number(attrs.level) < 1 ||
      Number(attrs.level) > 6)
  )
    throw new Error("Invalid heading level.");
  if (
    node.type === "orderedList" &&
    attrs.start !== undefined &&
    (!Number.isInteger(attrs.start) || Number(attrs.start) < 1)
  )
    throw new Error("Invalid ordered-list start.");
  if (node.type === "image") {
    if (
      typeof attrs.src !== "string" ||
      !safeUrl(attrs.src) ||
      typeof attrs.alt !== "string" ||
      (attrs.caption !== undefined && typeof attrs.caption !== "string") ||
      (attrs.size !== undefined &&
        (typeof attrs.size !== "string" || !imageSizes.has(attrs.size)))
    )
      throw new Error("Invalid article image.");
  }
  if (node.type === "quiz") validateQuiz(attrs);
  if (
    (node.type === "tableCell" || node.type === "tableHeader") &&
    [attrs.colspan, attrs.rowspan].some(
      (count) =>
        count !== undefined &&
        (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 20),
    )
  )
    throw new Error("Invalid table span.");
  if (
    node.type === "callout" &&
    ((attrs.tone !== undefined && typeof attrs.tone !== "string") ||
      (attrs.title !== undefined && typeof attrs.title !== "string"))
  )
    throw new Error("Invalid callout.");
  if (
    node.type === "codeBlock" &&
    attrs.language !== undefined &&
    typeof attrs.language !== "string"
  )
    throw new Error("Invalid code language.");
  if (
    node.type === "codeBlock" &&
    attrs.meta !== undefined &&
    typeof attrs.meta !== "string"
  )
    throw new Error("Invalid code metadata.");
  if (
    (node.type === "tableCell" || node.type === "tableHeader") &&
    attrs.align !== undefined &&
    (typeof attrs.align !== "string" ||
      !["left", "right", "center"].includes(attrs.align))
  )
    throw new Error("Invalid table alignment.");
  const next: typeof context =
    node.type === "bulletList" || node.type === "orderedList"
      ? "list"
      : node.type === "table"
        ? "row"
        : node.type === "tableRow"
          ? "cell"
          : node.type === "paragraph" ||
              node.type === "heading" ||
              node.type === "codeBlock"
            ? "inline"
            : "block";
  if (
    ["image", "quiz", "horizontalRule", "hardBreak"].includes(node.type) &&
    node.content?.length
  )
    throw new Error(`${node.type} cannot contain children.`);
  for (const child of node.content ?? []) validateNode(child, next, depth + 1);
}

function validateMark(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !markTypes.has(value.type)
  )
    throw new Error("Unsupported article mark.");
  if (Object.keys(value).some((key) => !["type", "attrs"].includes(key)))
    throw new Error("Unsupported article mark property.");
  const attrs = value.attrs ?? {};
  if (!isRecord(attrs)) throw new Error("Invalid article mark attributes.");
  if (value.type === "link" && Object.keys(attrs).some((key) => key !== "href"))
    throw new Error("Unsupported link attribute.");
  if (
    value.type !== "link" &&
    value.type !== "textStyle" &&
    Object.keys(attrs).length
  )
    throw new Error("Unsupported article mark attribute.");
  if (
    value.type === "link" &&
    (typeof attrs.href !== "string" || !safeUrl(attrs.href))
  )
    throw new Error("Unsafe article link.");
  if (value.type === "textStyle") {
    const allowed: Record<string, RegExp> = {
      color: /^#[\da-f]{3,8}$|^rgb\([\d,\s]+\)$/i,
      fontSize: /^\d{1,2}px$/,
      fontFamily: /^(sans-serif|serif|monospace)$/,
    };
    if (
      Object.entries(attrs).some(
        ([key, entry]) =>
          !allowed[key] ||
          typeof entry !== "string" ||
          !allowed[key].test(entry),
      )
    )
      throw new Error("Unsafe article text style.");
  }
}

function validateQuiz(attrs: Record<string, unknown>): void {
  if (attrs.title !== undefined && typeof attrs.title !== "string")
    throw new Error("Invalid quiz title.");
  if (
    !Array.isArray(attrs.items) ||
    attrs.items.length === 0 ||
    attrs.items.length > 100
  )
    throw new Error("Quiz requires items.");
  for (const item of attrs.items as unknown[]) {
    if (
      isRecord(item) &&
      Object.keys(item).some(
        (key) =>
          ![
            "question",
            "mode",
            "answer",
            "choices",
            "explanation",
            "code",
            "language",
          ].includes(key),
      )
    )
      throw new Error("Unsupported quiz item attribute.");
    if (
      !isRecord(item) ||
      typeof item.question !== "string" ||
      !item.question.trim() ||
      !["multiple", "description", "essay"].includes(String(item.mode)) ||
      !["string", "number"].includes(typeof item.answer) ||
      (item.choices !== undefined &&
        (!Array.isArray(item.choices) ||
          !item.choices.every((choice) => typeof choice === "string"))) ||
      (item.mode === "multiple" &&
        (!Array.isArray(item.choices) || item.choices.length < 2)) ||
      (typeof item.answer === "number" &&
        (!Number.isInteger(item.answer) ||
          !Array.isArray(item.choices) ||
          item.answer < 0 ||
          item.answer >= item.choices.length)) ||
      (item.explanation !== undefined &&
        typeof item.explanation !== "string") ||
      (item.code !== undefined && typeof item.code !== "string") ||
      (item.language !== undefined && typeof item.language !== "string")
    )
      throw new Error("Invalid quiz item.");
  }
}

function renderBlock(node: ArticleDocumentNode, id?: string): string {
  const children = (node.content ?? [])
    .map(node.type === "codeBlock" ? renderCodeText : renderNode)
    .join("");
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "paragraph":
      return `<p>${children}</p>`;
    case "heading": {
      const level = numberAttr(attrs, "level", 2);
      return `<h${level}${id ? ` id="${escape(id)}"` : ""}>${children}</h${level}>`;
    }
    case "codeBlock": {
      const language = stringAttr(attrs, "language", "text");
      const meta = stringAttr(attrs, "meta");
      return `<pre><code class="language-${escape(language)}"${meta ? ` data-code-meta="${escape(meta)}"` : ""}>${children}</code></pre>`;
    }
    case "bulletList":
      return `<ul>${children}</ul>`;
    case "orderedList": {
      const start = numberAttr(attrs, "start", 1);
      return `<ol${start !== 1 ? ` start="${start}"` : ""}>${children}</ol>`;
    }
    case "listItem":
      return `<li>${children}</li>`;
    case "blockquote":
      return `<blockquote>${children}</blockquote>`;
    case "horizontalRule":
      return "<hr />";
    case "table":
      return `<table>${children}</table>`;
    case "tableRow":
      return `<tr>${children}</tr>`;
    case "tableCell":
      return `<td${tableSpan(attrs)}${tableAlign(attrs)}>${children}</td>`;
    case "tableHeader":
      return `<th${tableSpan(attrs)}${tableAlign(attrs)}>${children}</th>`;
    case "image": {
      const caption = stringAttr(attrs, "caption");
      return `<figure><img src="${escape(stringAttr(attrs, "src"))}" alt="${escape(stringAttr(attrs, "alt"))}" />${caption ? `<figcaption>${escape(caption)}</figcaption>` : ""}</figure>`;
    }
    case "callout": {
      const title = stringAttr(attrs, "title");
      return `<aside data-callout-tone="${escape(stringAttr(attrs, "tone", "note"))}">${title ? `<strong>${escape(title)}</strong>` : ""}${children}</aside>`;
    }
    case "quiz": {
      const title = stringAttr(attrs, "title");
      return `<section data-block-type="quiz">${title ? `<h3>${escape(title)}</h3>` : ""}${(
        attrs.items as ValidatedQuizItem[]
      )
        .map((item) => {
          const answer =
            typeof item.answer === "number" && item.choices
              ? (item.choices[item.answer] ?? String(item.answer))
              : String(item.answer);
          return `<div data-quiz-item><p>${escape(item.question)}</p>${item.code ? `<pre><code>${escape(item.code)}</code></pre>` : ""}${item.choices ? `<ol>${item.choices.map((choice) => `<li>${escape(choice)}</li>`).join("")}</ol>` : ""}<details><summary>정답</summary><p>${escape(answer)}</p>${item.explanation ? `<p>${escape(item.explanation)}</p>` : ""}</details></div>`;
        })
        .join("")}</section>`;
    }
    default:
      throw new Error(`Unsupported render node: ${node.type}`);
  }
}

function headingId(node: ArticleDocumentNode, index: number): string {
  const slug =
    nodeText(node)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9가-힣_-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "") || "section";
  return `${slug}-${index}`;
}

function tableSpan(attrs: Record<string, unknown>): string {
  const colspan = numberAttr(attrs, "colspan", 1);
  const rowspan = numberAttr(attrs, "rowspan", 1);
  return `${colspan !== 1 ? ` colspan="${colspan}"` : ""}${rowspan !== 1 ? ` rowspan="${rowspan}"` : ""}`;
}

function tableAlign(attrs: Record<string, unknown>): string {
  const align = stringAttr(attrs, "align");
  return align ? ` style="text-align:${align}"` : "";
}

function renderNode(node: ArticleDocumentNode): string {
  if (node.type === "text") {
    let html = escape(node.text ?? "");
    for (const mark of node.marks ?? []) {
      const attrs = mark.attrs ?? {};
      switch (mark.type) {
        case "bold":
          html = `<strong>${html}</strong>`;
          break;
        case "italic":
          html = `<em>${html}</em>`;
          break;
        case "underline":
          html = `<u>${html}</u>`;
          break;
        case "strike":
          html = `<del>${html}</del>`;
          break;
        case "code":
          html = `<code>${html}</code>`;
          break;
        case "link":
          html = `<a href="${escape(stringAttr(attrs, "href"))}">${html}</a>`;
          break;
        case "textStyle": {
          const style = Object.entries(attrs)
            .filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            )
            .map(
              ([key, val]) =>
                `${key === "fontSize" ? "font-size" : key === "fontFamily" ? "font-family" : key}:${val}`,
            )
            .join(";");
          html = `<span style="${escape(style)}">${html}</span>`;
          break;
        }
      }
    }
    return html;
  }
  if (node.type === "hardBreak") return "<br />";
  return renderBlock(node);
}

function renderCodeText(node: ArticleDocumentNode): string {
  if (node.type !== "text")
    throw new Error("Code blocks can only contain text.");
  return escape(node.text ?? "");
}

function nodeText(node: ArticleDocumentNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "quiz")
    return ((node.attrs?.items ?? []) as Array<{ question: string }>)
      .map((item) => item.question)
      .join("\n");
  if (node.type === "image") return stringAttr(node.attrs, "alt");
  return (node.content ?? [])
    .map(nodeText)
    .join(node.type === "paragraph" || node.type === "heading" ? "" : "\n");
}

function toBlockType(type: string): ArticleBlockDraft["type"] {
  switch (type) {
    case "heading":
      return "HEADING";
    case "codeBlock":
      return "CODE";
    case "image":
      return "IMAGE";
    case "blockquote":
      return "QUOTE";
    case "callout":
      return "CALLOUT";
    case "quiz":
      return "QUIZ";
    default:
      return "PARAGRAPH";
  }
}

function safeUrl(value: string): boolean {
  return /^(https?:\/\/[^\s]+|\/(?!\/)[^\s]*|#[^\s]+|mailto:[^\s@]+@[^\s@]+\.[^\s@]+)$/i.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAttr(
  attrs: Record<string, unknown> | undefined,
  key: string,
  fallback = "",
): string {
  const value = attrs?.[key];
  return typeof value === "string" ? value : fallback;
}

function numberAttr(
  attrs: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = attrs?.[key];
  return typeof value === "number" ? value : fallback;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
