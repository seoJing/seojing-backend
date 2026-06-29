import { basename, relative } from "node:path";

import type {
  ArticleAssetDraft,
  ArticleBlockDraft,
} from "../repositories/articles.js";
import { normalizeSlug } from "./articles.js";

export type FrontmatterValue = string | number | boolean | string[] | null;

export interface MdxTocItem {
  id: string;
  depth: number;
  text: string;
}

export interface UnsupportedMdxComponent {
  name: string;
  line: number;
  strategy: "placeholder" | "structured-block-candidate";
}

export interface MdxIngestOptions {
  sourcePath?: string;
  contentRoot?: string;
  fallbackSlug?: string;
}

export interface MdxIngestResult {
  slug: string;
  title: string;
  description?: string;
  sourceText: string;
  frontmatter: Record<string, FrontmatterValue>;
  toc: MdxTocItem[];
  renderedHtml: string;
  blocks: ArticleBlockDraft[];
  assets: ArticleAssetDraft[];
  unsupportedComponents: UnsupportedMdxComponent[];
  componentPolicy: Record<string, string>;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
}

interface RenderState {
  html: string[];
  blocks: ArticleBlockDraft[];
  assets: ArticleAssetDraft[];
  toc: MdxTocItem[];
  unsupportedComponents: UnsupportedMdxComponent[];
  paragraph: string[];
  codeFence?: {
    language?: string;
    meta?: string;
    lines: string[];
    startLine: number;
  };
}

interface MdxComponentBlock {
  name: string;
  line: number;
  rawMdx: string;
  props: Record<string, string | boolean>;
  bodyText?: string;
  children: Array<{
    name: string;
    props: Record<string, string | boolean>;
    rawMdx: string;
  }>;
  endIndex: number;
}

const supportedComponentPolicy: Record<string, string> = {
  ArticleQuiz: "omitted from rendered HTML; structured QUIZ block later",
  ArticleQuizItem: "omitted inside ArticleQuiz; structured quiz item later",
  Callout: "placeholder now; structured CALLOUT block candidate",
  Image:
    "prefer markdown image ingestion; JSX Image is placeholder-only in MVP",
};

const importExportPattern = /^\s*(import|export)\s+/;

export function ingestMdxArticle(
  sourceText: string,
  options: MdxIngestOptions = {},
): MdxIngestResult {
  const { frontmatter, body } = parseFrontmatter(sourceText);
  const render = renderMdxBody(body);
  const title = resolveTitle(frontmatter, render.toc, options.sourcePath);
  const slug = resolveSlug(frontmatter, title, options);
  const description =
    readString(frontmatter.description) ?? readString(frontmatter.summary);

  return {
    slug,
    title,
    description,
    sourceText,
    frontmatter,
    toc: render.toc,
    renderedHtml: render.html.join("\n"),
    blocks: render.blocks,
    assets: render.assets,
    unsupportedComponents: render.unsupportedComponents,
    componentPolicy: supportedComponentPolicy,
  };
}

export function parseFrontmatter(sourceText: string): ParsedFrontmatter {
  const normalized = sourceText.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const rawFrontmatter = normalized.slice(4, end);
  const bodyStart = normalized.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : normalized.slice(bodyStart + 1);

  return {
    frontmatter: parseSimpleYaml(rawFrontmatter),
    body,
  };
}

function renderMdxBody(body: string): Omit<RenderState, "paragraph"> {
  const state: RenderState = {
    html: [],
    blocks: [],
    assets: [],
    toc: [],
    unsupportedComponents: [],
    paragraph: [],
  };

  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;

    if (state.codeFence) {
      if (line.trim().startsWith("```")) {
        flushCodeFence(state);
      } else {
        state.codeFence.lines.push(line);
      }
      continue;
    }

    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph(state);
      const fenceInfo = parseCodeFenceInfo(trimmed);
      state.codeFence = {
        language: fenceInfo.language,
        meta: fenceInfo.meta,
        lines: [],
        startLine: lineNumber,
      };
      continue;
    }

    if (!trimmed) {
      flushParagraph(state);
      continue;
    }

    if (importExportPattern.test(trimmed)) {
      flushParagraph(state);
      continue;
    }

    const componentBlock = readMdxComponentBlock(lines, index);
    if (componentBlock) {
      flushParagraph(state);
      addComponentPlaceholder(state, componentBlock);
      index = componentBlock.endIndex;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph(state);
      addHeading(
        state,
        headingMatch[1]?.length ?? 1,
        stripInlineMdx(headingMatch[2] ?? ""),
      );
      continue;
    }

    const table = tryReadTable(lines, index);
    if (table) {
      flushParagraph(state);
      addTable(state, table.headers, table.rows);
      index = table.endIndex;
      continue;
    }

    const list = tryReadList(lines, index);
    if (list) {
      flushParagraph(state);
      addList(state, list.items, list.ordered);
      index = list.endIndex;
      continue;
    }

    const imageMatch = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)$/.exec(
      trimmed,
    );
    if (imageMatch) {
      flushParagraph(state);
      addImage(state, imageMatch[1] ?? "", imageMatch[2] ?? "", imageMatch[3]);
      continue;
    }

    const quoteMatch = /^>\s?(.+)$/.exec(trimmed);
    if (quoteMatch) {
      flushParagraph(state);
      addQuote(state, stripInlineMdx(quoteMatch[1] ?? ""));
      continue;
    }

    state.paragraph.push(trimmed);
  }

  if (state.codeFence) {
    flushCodeFence(state);
  }
  flushParagraph(state);

  return {
    html: state.html,
    blocks: state.blocks,
    assets: state.assets,
    toc: state.toc,
    unsupportedComponents: state.unsupportedComponents,
    codeFence: undefined,
  };
}

function addHeading(state: RenderState, depth: number, text: string): void {
  const id = uniqueSlug(
    text,
    state.toc.map((item) => item.id),
  );
  const safeDepth = Math.min(Math.max(depth, 1), 6);
  state.toc.push({ id, depth: safeDepth, text });
  state.html.push(
    `<h${safeDepth} id="${escapeAttribute(id)}">${escapeHtml(text)}</h${safeDepth}>`,
  );
  state.blocks.push({
    type: "HEADING",
    sortOrder: state.blocks.length,
    content: { level: safeDepth, text, id },
    plainText: text,
  });
}

function addImage(
  state: RenderState,
  altText: string,
  url: string,
  title?: string,
): void {
  const asset: ArticleAssetDraft = {
    kind: "INLINE_IMAGE",
    url,
    altText: altText || undefined,
    metadata: title ? { title } : undefined,
  };
  state.assets.push(asset);
  state.html.push(
    `<figure><img src="${escapeAttribute(url)}" alt="${escapeAttribute(altText)}" />${title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ""}</figure>`,
  );
  state.blocks.push({
    type: "IMAGE",
    sortOrder: state.blocks.length,
    content: { url, altText, title },
    plainText: altText || title,
  });
}

function addQuote(state: RenderState, text: string): void {
  state.html.push(`<blockquote>${renderInlineMarkdown(text)}</blockquote>`);
  state.blocks.push({
    type: "QUOTE",
    sortOrder: state.blocks.length,
    content: { text },
    plainText: text,
  });
}

function addList(state: RenderState, items: string[], ordered: boolean): void {
  const tag = ordered ? "ol" : "ul";
  state.html.push(
    `<${tag}>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`,
  );
  state.blocks.push({
    type: "PARAGRAPH",
    sortOrder: state.blocks.length,
    content: { listType: ordered ? "ordered" : "unordered", items },
    plainText: items.join("\n"),
  });
}

function addTable(
  state: RenderState,
  headers: string[],
  rows: string[][],
): void {
  const headerHtml = headers
    .map((header) => `<th>${renderInlineMarkdown(header)}</th>`)
    .join("");
  const bodyHtml = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  state.html.push(
    `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
  );
  state.blocks.push({
    type: "PARAGRAPH",
    sortOrder: state.blocks.length,
    content: { table: { headers, rows } },
    plainText: [
      headers.join(" | "),
      ...rows.map((row) => row.join(" | ")),
    ].join("\n"),
  });
}

function tryReadList(
  lines: string[],
  startIndex: number,
): { items: string[]; ordered: boolean; endIndex: number } | null {
  const first = parseListItem(lines[startIndex] ?? "");
  if (!first) {
    return null;
  }

  const items = [first.text];
  let endIndex = startIndex;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const item = parseListItem(lines[index] ?? "");
    if (!item || item.ordered !== first.ordered) {
      break;
    }
    items.push(item.text);
    endIndex = index;
  }

  return { items, ordered: first.ordered, endIndex };
}

function parseListItem(
  line: string,
): { text: string; ordered: boolean } | null {
  const trimmed = line.trim();
  const unordered = /^[-*+]\s+(.+)$/.exec(trimmed);
  if (unordered?.[1]) {
    return { text: stripInlineMdx(unordered[1]), ordered: false };
  }

  const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
  if (ordered?.[1]) {
    return { text: stripInlineMdx(ordered[1]), ordered: true };
  }

  return null;
}

function tryReadTable(
  lines: string[],
  startIndex: number,
): { headers: string[]; rows: string[][]; endIndex: number } | null {
  const header = parseTableRow(lines[startIndex] ?? "");
  const separator = lines[startIndex + 1]?.trim() ?? "";
  if (!header || !isTableSeparator(separator)) {
    return null;
  }

  const rows: string[][] = [];
  let endIndex = startIndex + 1;
  for (let index = startIndex + 2; index < lines.length; index += 1) {
    const row = parseTableRow(lines[index] ?? "");
    if (!row) {
      break;
    }
    rows.push(row);
    endIndex = index;
  }

  return rows.length ? { headers: header, rows, endIndex } : null;
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => stripInlineMdx(cell.trim()));
  return cells.length >= 2 ? cells : null;
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return Boolean(
    cells?.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, ""))),
  );
}

function addComponentPlaceholder(
  state: RenderState,
  component: MdxComponentBlock,
): void {
  const componentName = component.name;
  const isQuizComponent =
    componentName === "ArticleQuiz" || componentName === "ArticleQuizItem";
  const isStructuredCandidate = isQuizComponent || componentName === "Callout";
  const strategy = isStructuredCandidate
    ? "structured-block-candidate"
    : "placeholder";
  const content = buildComponentContent(component, strategy);

  state.unsupportedComponents.push({
    name: componentName,
    line: component.line,
    strategy,
  });

  if (componentName === "Callout") {
    const title = readComponentString(component.props.title);
    const tone = readComponentString(component.props.tone) ?? "note";
    const bodyText = component.bodyText ?? "";
    state.html.push(
      `<aside data-mdx-component="Callout" data-mdx-strategy="${strategy}" data-callout-tone="${escapeAttribute(tone)}">${title ? `<strong>${escapeHtml(title)}</strong>` : ""}${bodyText ? `<p>${renderInlineMarkdown(bodyText)}</p>` : ""}</aside>`,
    );
  } else if (!isQuizComponent) {
    state.html.push(
      `<aside data-mdx-component="${escapeAttribute(componentName)}" data-mdx-strategy="${strategy}">${escapeHtml(componentName)} component omitted by backend MDX ingest MVP</aside>`,
    );
  }

  state.blocks.push({
    type: isQuizComponent
      ? "QUIZ"
      : componentName === "Callout"
        ? "CALLOUT"
        : "RAW_MDX",
    sortOrder: state.blocks.length,
    content: content as ArticleBlockDraft["content"],
    plainText:
      componentName === "Callout"
        ? component.bodyText
        : isStructuredCandidate
          ? undefined
          : `${componentName} component omitted`,
    metadata: { line: component.line },
  });
}

function buildComponentContent(
  component: MdxComponentBlock,
  strategy: "placeholder" | "structured-block-candidate",
): Record<string, unknown> {
  const base = {
    componentName: component.name,
    props: component.props,
    rawMdx: component.rawMdx,
    strategy,
  };

  if (component.name === "ArticleQuiz") {
    return {
      ...base,
      renderHint: "ArticleQuiz",
      items: component.children
        .filter((child) => child.name === "ArticleQuizItem")
        .map((child) => ({ props: child.props, rawMdx: child.rawMdx })),
    };
  }

  if (component.name === "Callout") {
    return {
      ...base,
      renderHint: "Callout",
      bodyText: component.bodyText ?? "",
    };
  }

  return base;
}

function readMdxComponentBlock(
  lines: string[],
  startIndex: number,
): MdxComponentBlock | null {
  const firstLine = lines[startIndex]?.trim() ?? "";
  const open = /^<([A-Z][A-Za-z0-9_.]*)\b([^>]*)>?/.exec(firstLine);
  if (!open?.[1]) {
    return null;
  }

  const name = open[1];
  const rawLines = [lines[startIndex] ?? ""];
  const firstProps = open[2] ?? "";
  const selfClosing = /\/\s*>$/.test(firstLine);
  const sameLineClosed = firstLine.includes(`</${name}>`);
  let endIndex = startIndex;

  if (!selfClosing && !sameLineClosed) {
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      rawLines.push(line);
      endIndex = index;
      if (line.includes(`</${name}>`)) {
        break;
      }
    }
  }

  const rawMdx = rawLines.join("\n");
  const children = extractChildComponents(rawMdx, name);

  return {
    name,
    line: startIndex + 1,
    rawMdx,
    props: parseComponentProps(firstProps),
    bodyText: extractComponentBodyText(rawMdx, name),
    children,
    endIndex,
  };
}

function extractChildComponents(
  rawMdx: string,
  parentName: string,
): MdxComponentBlock["children"] {
  const children: MdxComponentBlock["children"] = [];
  const withoutParentOpen = rawMdx.replace(
    new RegExp(`^\\s*<${parentName}\\b[^>]*>`),
    "",
  );
  const innerMdx = withoutParentOpen.replace(
    new RegExp(`</${parentName}>\\s*$`),
    "",
  );
  const childPattern =
    /<([A-Z][A-Za-z0-9_.]*)\b([\s\S]*?)(?:\/>|>[\s\S]*?<\/\1>)/g;
  let match: RegExpExecArray | null;
  while ((match = childPattern.exec(innerMdx))) {
    const name = match[1];
    if (!name || name === parentName) {
      continue;
    }
    children.push({
      name,
      props: parseComponentProps(match[2] ?? ""),
      rawMdx: match[0].trim(),
    });
  }
  return children;
}

function parseComponentProps(
  rawProps: string,
): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = {};
  const withoutClose = rawProps.replace(/\/\s*$/, "");
  const propPattern =
    /([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;
  let match: RegExpExecArray | null;
  while ((match = propPattern.exec(withoutClose))) {
    const key = match[1];
    if (!key) {
      continue;
    }
    const value = match[3] ?? match[4] ?? match[5];
    props[key] = value === undefined ? true : value.trim();
  }
  return props;
}

function extractComponentBodyText(
  rawMdx: string,
  name: string,
): string | undefined {
  const withoutOpen = rawMdx.replace(new RegExp(`^\\s*<${name}\\b[^>]*>`), "");
  const withoutClose = withoutOpen.replace(new RegExp(`</${name}>\\s*$`), "");
  const text = stripInlineMdx(
    withoutClose
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^<[A-Z][A-Za-z0-9_.]*\b/.test(line))
      .join(" "),
  );
  return text || undefined;
}

function readComponentString(
  value: string | boolean | undefined,
): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function flushParagraph(state: RenderState): void {
  if (!state.paragraph.length) {
    return;
  }

  const text = stripInlineMdx(state.paragraph.join(" "));
  state.html.push(`<p>${renderInlineMarkdown(text)}</p>`);
  state.blocks.push({
    type: "PARAGRAPH",
    sortOrder: state.blocks.length,
    content: { text },
    plainText: text,
  });
  state.paragraph = [];
}

function flushCodeFence(state: RenderState): void {
  if (!state.codeFence) {
    return;
  }

  const code = state.codeFence.lines.join("\n");
  const language = state.codeFence.language;
  const meta = state.codeFence.meta;
  state.html.push(
    `<pre><code${language ? ` class="language-${escapeAttribute(language)}"` : ""}${meta ? ` data-meta="${escapeAttribute(meta)}"` : ""}>${escapeHtml(code)}</code></pre>`,
  );
  state.blocks.push({
    type: "CODE",
    sortOrder: state.blocks.length,
    content: { language, meta, code },
    plainText: code,
    metadata: {
      startLine: state.codeFence.startLine,
    },
  });
  state.codeFence = undefined;
}

function parseCodeFenceInfo(rawFence: string): {
  language?: string;
  meta?: string;
} {
  const info = rawFence.replace(/^```/, "").trim();
  if (!info) {
    return {};
  }
  const [language, ...metaParts] = info.split(/\s+/);
  return {
    language: language || undefined,
    meta: metaParts.join(" ") || undefined,
  };
}

function resolveTitle(
  frontmatter: Record<string, FrontmatterValue>,
  toc: MdxTocItem[],
  sourcePath?: string,
): string {
  const frontmatterTitle = readString(frontmatter.title);
  if (frontmatterTitle) {
    return frontmatterTitle;
  }

  const firstH1 = toc.find((item) => item.depth === 1);
  if (firstH1) {
    return firstH1.text;
  }

  if (sourcePath) {
    return basename(sourcePath).replace(/\.mdx?$/, "");
  }

  return "Untitled Article";
}

function resolveSlug(
  frontmatter: Record<string, FrontmatterValue>,
  title: string,
  options: MdxIngestOptions,
): string {
  const frontmatterSlug = readString(frontmatter.slug);
  if (frontmatterSlug) {
    return normalizeSlug(frontmatterSlug);
  }

  if (options.sourcePath) {
    const relativePath = options.contentRoot
      ? relative(options.contentRoot, options.sourcePath)
      : options.sourcePath;
    const withoutExtension = relativePath
      .replace(/\.mdx?$/, "")
      .replace(/\\/g, "/");
    const withoutIndex = withoutExtension.replace(/\/index$/, "");
    const fromPath = normalizeSlug(withoutIndex);
    if (fromPath) {
      return fromPath;
    }
  }

  return normalizeSlug(options.fallbackSlug ?? title);
}

function readString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseSimpleYaml(raw: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!match?.[1]) {
      continue;
    }

    result[match[1]] = parseYamlScalar(match[2] ?? "");
  }

  return result;
}

function parseYamlScalar(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return unquote(value);
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function stripInlineMdx(text: string): string {
  return text
    .replace(/<([A-Z][A-Za-z0-9_.]*)\b[^>]*\/>/g, "")
    .replace(/<\/?([A-Z][A-Za-z0-9_.]*)\b[^>]*>/g, "")
    .replace(/\{[^}]+\}/g, "")
    .trim();
}

function renderInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/&lt;br\s*\/&gt;/g, "<br />")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]+)\)/g,
      (_match, label: string, url: string) => {
        return `<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`;
      },
    );
}

function uniqueSlug(text: string, existing: string[]): string {
  const base = normalizeSlug(text) || "section";
  let candidate = base;
  let suffix = 2;
  while (existing.includes(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
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
