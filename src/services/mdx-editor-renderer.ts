import { basename, relative } from "node:path";

import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type {
  ArticleAssetDraft,
  ArticleBlockDraft,
} from "../repositories/articles.js";
import { normalizeSlug } from "./articles.js";
import {
  parseFrontmatter,
  type MdxIngestOptions,
  type MdxTocItem,
  type UnsupportedMdxComponent,
} from "./mdx-ingest.js";

type Node = {
  type: string;
  name?: string | null;
  value?: string;
  url?: string;
  alt?: string;
  title?: string | null;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  align?: Array<"left" | "center" | "right" | null>;
  lang?: string | null;
  meta?: string | null;
  children?: Node[];
  attributes?: Array<{
    type: string;
    name?: string;
    value?:
      | string
      | { value?: string; data?: { estree?: ExpressionProgram } }
      | null;
  }>;
  data?: { estree?: ExpressionProgram };
  position?: { start?: { line?: number }; end?: { line?: number } };
};

type ExpressionProgram = { body?: Array<{ expression?: LiteralExpression }> };
type LiteralExpression = {
  type: string;
  value?: unknown;
  quasis?: Array<{ value?: { cooked?: string | null } }>;
  expressions?: LiteralExpression[];
  elements?: Array<LiteralExpression | null>;
  properties?: Array<{
    type: string;
    computed?: boolean;
    key?: { name?: string; value?: unknown };
    value?: LiteralExpression;
  }>;
};

export interface MdxEditorRenderResult {
  slug: string;
  title: string;
  description?: string;
  sourceText: string;
  renderedHtml: string;
  blocks: ArticleBlockDraft[];
  assets: ArticleAssetDraft[];
  toc: MdxTocItem[];
  unsupportedComponents: UnsupportedMdxComponent[];
}

type RenderState = Pick<
  MdxEditorRenderResult,
  "blocks" | "assets" | "toc" | "unsupportedComponents"
> & { html: string[] };

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

/** Parse MDX as data. Expressions are never executed; unknown constructs block publication. */
export function renderMdxForEditor(
  sourceText: string,
  options: MdxIngestOptions = {},
): MdxEditorRenderResult {
  const { frontmatter, body } = parseFrontmatter(sourceText);
  let root: Node;
  try {
    root = processor.parse(body) as unknown as Node;
  } catch {
    root = { type: "root", children: [{ type: "parse-error" }] };
  }
  const state: RenderState = {
    blocks: [],
    assets: [],
    toc: [],
    unsupportedComponents: [],
    html: [],
  };
  for (const node of root.children ?? []) renderBlock(node, state);

  const frontmatterTitle =
    typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
  const title =
    frontmatterTitle ||
    state.toc.find((item) => item.depth === 1)?.text ||
    (options.sourcePath
      ? basename(options.sourcePath).replace(/\.mdx?$/, "")
      : "Untitled Article");
  const frontmatterSlug =
    typeof frontmatter.slug === "string" ? frontmatter.slug : "";
  const pathSlug = options.sourcePath
    ? relative(options.contentRoot ?? "", options.sourcePath)
        .replace(/\\/g, "/")
        .replace(/\.mdx?$/, "")
        .replace(/\/index$/, "")
    : "";
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description
      : typeof frontmatter.summary === "string"
        ? frontmatter.summary
        : undefined;

  return {
    slug: normalizeSlug(
      frontmatterSlug || pathSlug || options.fallbackSlug || title,
    ),
    title,
    description,
    sourceText,
    renderedHtml: state.html.join("\n"),
    blocks: state.blocks,
    assets: state.assets,
    toc: state.toc,
    unsupportedComponents: state.unsupportedComponents,
  };
}

function renderBlock(node: Node, state: RenderState): void {
  const children = node.children ?? [];
  switch (node.type) {
    case "mdxjsEsm":
      if (!/^\s*import\s/.test(node.value ?? "")) unsupported(node, state);
      return;
    case "heading": {
      const inline = renderInline(children, state);
      const level = Math.min(Math.max(node.depth ?? 2, 1), 6);
      const id = uniqueId(
        normalizeSlug(inline.text).toLowerCase() || "section",
        state.toc,
      );
      state.toc.push({ id, depth: level, text: inline.text });
      add(
        state,
        "HEADING",
        { level, id, text: inline.text, html: inline.html },
        inline.text,
        `<h${level} id="${escape(id)}">${inline.html}</h${level}>`,
      );
      return;
    }
    case "paragraph": {
      if (children.length === 1 && children[0]?.type === "image") {
        renderBlock(children[0], state);
        return;
      }
      if (
        children.length === 1 &&
        children[0]?.type === "mdxJsxTextElement" &&
        children[0].name === "Subtitle"
      ) {
        renderComponent(children[0], state);
        return;
      }
      const inline = renderInline(children, state);
      add(
        state,
        "PARAGRAPH",
        { text: inline.text, html: inline.html },
        inline.text,
        `<p>${inline.html}</p>`,
      );
      return;
    }
    case "code": {
      const code = node.value ?? "";
      const language = node.lang ?? "text";
      add(
        state,
        "CODE",
        { code, language, meta: node.meta ?? undefined },
        code,
        `<pre><code class="language-${escape(language)}">${escape(code)}</code></pre>`,
      );
      return;
    }
    case "image":
      addImage(
        state,
        node.url ?? "",
        node.alt ?? "",
        node.title ?? undefined,
        node,
      );
      return;
    case "blockquote": {
      if (
        !children.length ||
        children.some(
          (child) => child.type !== "paragraph" && child.type !== "code",
        )
      ) {
        unsupported(node, state);
        return;
      }
      const parts = children.map((child) =>
        child.type === "paragraph"
          ? renderInline(child.children ?? [], state)
          : {
              text: child.value ?? "",
              html: `<pre><code>${escape(child.value ?? "")}</code></pre>`,
            },
      );
      const html = parts
        .map((part, index) =>
          children[index]?.type === "paragraph"
            ? `<p>${part.html}</p>`
            : part.html,
        )
        .join("");
      const text = parts.map((part) => part.text).join("\n");
      add(
        state,
        "QUOTE",
        { text, html },
        text,
        `<blockquote>${html}</blockquote>`,
      );
      return;
    }
    case "list": {
      const ordered = Boolean(node.ordered);
      const start =
        ordered && Number.isInteger(node.start) && (node.start ?? 0) > 0
          ? node.start
          : 1;
      const items = children.map((child) => renderListItem(child, state));
      const tag = ordered ? "ol" : "ul";
      add(
        state,
        "PARAGRAPH",
        {
          listType: ordered ? "ordered" : "unordered",
          start,
          items: items.map((item) => item.text),
          itemsHtml: items.map((item) => item.html),
        },
        items.map((item) => item.text).join("\n"),
        `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${items.map((item) => `<li>${item.html}</li>`).join("")}</${tag}>`,
      );
      return;
    }
    case "table": {
      const rows = children.map((row) =>
        (row.children ?? []).map((cell) =>
          renderInline(cell.children ?? [], state),
        ),
      );
      const headers = rows.shift() ?? [];
      const tagRow = (cells: typeof headers, tag: string) =>
        `<tr>${cells.map((cell, index) => `<${tag}${node.align?.[index] ? ` style="text-align:${node.align[index]}"` : ""}>${cell.html}</${tag}>`).join("")}</tr>`;
      add(
        state,
        "PARAGRAPH",
        {
          table: {
            headers: headers.map((cell) => cell.text),
            headersHtml: headers.map((cell) => cell.html),
            rows: rows.map((row) => row.map((cell) => cell.text)),
            rowsHtml: rows.map((row) => row.map((cell) => cell.html)),
            align: node.align ?? [],
          },
        },
        [headers, ...rows]
          .map((row) => row.map((cell) => cell.text).join(" | "))
          .join("\n"),
        `<table><thead>${tagRow(headers, "th")}</thead><tbody>${rows.map((row) => tagRow(row, "td")).join("")}</tbody></table>`,
      );
      return;
    }
    case "thematicBreak":
      add(state, "PARAGRAPH", { text: "---" }, "---", "<hr />");
      return;
    case "mdxFlowExpression": {
      const value = node.data?.estree?.body?.[0]?.expression;
      const text = value ? literal(value) : undefined;
      if (typeof text === "string") {
        add(
          state,
          "PARAGRAPH",
          { text, html: escape(text) },
          text,
          `<p>${escape(text)}</p>`,
        );
        return;
      }
      unsupported(node, state);
      return;
    }
    case "mdxJsxFlowElement":
      renderComponent(node, state);
      return;
    default:
      unsupported(node, state);
  }
}

function renderListItem(
  node: Node,
  state: RenderState,
): { html: string; text: string } {
  if (node.type !== "listItem") {
    unsupported(node, state);
    return { html: "", text: "" };
  }
  const parts = (node.children ?? []).map((child) => {
    if (child.type === "paragraph")
      return renderInline(child.children ?? [], state);
    if (
      child.type === "mdxJsxFlowElement" &&
      ["Anchor", "strong", "em", "code", "span", "br"].includes(
        child.name ?? "",
      )
    ) {
      return renderInline(flattenInlineChildren([child]), state);
    }
    if (child.type === "list") {
      const items = (child.children ?? []).map((item) =>
        renderListItem(item, state),
      );
      const tag = child.ordered ? "ol" : "ul";
      const start =
        child.ordered && Number.isInteger(child.start) && (child.start ?? 0) > 0
          ? child.start
          : 1;
      return {
        html: `<${tag}${child.ordered && start !== 1 ? ` start="${start}"` : ""}>${items.map((item) => `<li>${item.html}</li>`).join("")}</${tag}>`,
        text: items.map((item) => item.text).join("\n"),
      };
    }
    if (child.type === "code") {
      const code = child.value ?? "";
      return { html: `<pre><code>${escape(code)}</code></pre>`, text: code };
    }
    unsupported(child, state);
    return { html: "", text: "" };
  });
  return {
    html:
      parts.length === 1
        ? (parts[0]?.html ?? "")
        : parts
            .map((part) =>
              part.html.startsWith("<ul>") ||
              part.html.startsWith("<ol>") ||
              part.html.startsWith("<pre>")
                ? part.html
                : `<p>${part.html}</p>`,
            )
            .join(""),
    text: parts.map((part) => part.text).join("\n"),
  };
}

function renderComponent(node: Node, state: RenderState): void {
  const name = node.name ?? "unknown";
  const children = node.children ?? [];
  if (name === "Paragraph" && !node.attributes?.length) {
    if (
      children.some((child) =>
        ["list", "code", "blockquote"].includes(child.type),
      )
    ) {
      for (const child of children) {
        if (
          ["paragraph", "list", "code", "blockquote", "thematicBreak"].includes(
            child.type,
          )
        )
          renderBlock(child, state);
        else if (child.type === "mdxJsxFlowElement")
          renderComponent(child, state);
        else unsupported(child, state);
      }
      return;
    }
    const inline = renderInline(flattenInlineChildren(children), state);
    add(
      state,
      "PARAGRAPH",
      { text: inline.text, html: inline.html },
      inline.text,
      `<p>${inline.html}</p>`,
    );
    return;
  }
  if (["strong", "em"].includes(name) && !node.attributes?.length) {
    const inline = renderInline(flattenInlineChildren(children), state);
    const tag = name === "strong" ? "strong" : "em";
    add(
      state,
      "PARAGRAPH",
      { text: inline.text, html: `<${tag}>${inline.html}</${tag}>` },
      inline.text,
      `<p><${tag}>${inline.html}</${tag}></p>`,
    );
    return;
  }
  if (name === "Anchor" && hasOnlyAttributes(node, ["href", "external"])) {
    const href = attribute(node, "href") ?? attribute(node, "external");
    if (typeof href === "string" && safeUrl(href)) {
      const inline = renderInline(flattenInlineChildren(children), state);
      const html = `<a href="${escape(href)}">${inline.html}</a>`;
      add(
        state,
        "PARAGRAPH",
        { text: inline.text, html },
        inline.text,
        `<p>${html}</p>`,
      );
      return;
    }
  }
  if (name === "Subtitle") {
    const level = attribute(node, "level");
    if (
      hasOnlyAttributes(node, ["level"]) &&
      (level === undefined || isHeadingLevel(level))
    ) {
      renderBlock(
        {
          type: "heading",
          depth: Number(level ?? 2),
          children: flattenInlineChildren(children),
        },
        state,
      );
      return;
    }
  }
  if (name === "ArticleImage") {
    const url = attribute(node, "src");
    const alt = attribute(node, "alt");
    const caption = attribute(node, "caption");
    const size = attribute(node, "size");
    if (
      hasOnlyAttributes(node, ["src", "alt", "caption", "size"]) &&
      typeof url === "string" &&
      typeof alt === "string" &&
      (size === undefined ||
        (typeof size === "string" && ["sm", "md", "lg", "full"].includes(size)))
    ) {
      addImage(
        state,
        url,
        alt,
        typeof caption === "string" ? caption : undefined,
        node,
        typeof size === "string" ? size : undefined,
      );
      return;
    }
  }
  if (name === "ArticleQuiz") {
    const items = children.filter(
      (child) =>
        child.type === "mdxJsxFlowElement" && child.name === "ArticleQuizItem",
    );
    const parsed = items.map((item) => {
      const props = Object.fromEntries(
        (item.attributes ?? []).map((attr) => [
          attr.name ?? "",
          attribute(item, attr.name ?? ""),
        ]),
      ) as Record<string, unknown>;
      const mode =
        props.mode ??
        (Array.isArray(props.choices) ? "multiple" : "description");
      if (
        !hasOnlyAttributes(item, [
          "mode",
          "question",
          "choices",
          "answer",
          "explanation",
          "code",
          "language",
          "index",
        ]) ||
        typeof props.question !== "string" ||
        typeof mode !== "string" ||
        !["multiple", "description", "essay"].includes(mode) ||
        !(
          typeof props.answer === "string" || typeof props.answer === "number"
        ) ||
        (mode === "multiple" &&
          (!Array.isArray(props.choices) ||
            !props.choices.every((choice) => typeof choice === "string"))) ||
        (props.explanation !== undefined &&
          typeof props.explanation !== "string")
      )
        return null;
      return { props: { ...props, mode } };
    });
    if (
      hasOnlyAttributes(node, ["title", "id"]) &&
      items.length > 0 &&
      items.length === children.length &&
      parsed.every(Boolean)
    ) {
      const quizItems = parsed as Array<{ props: Record<string, unknown> }>;
      const html = quizItems
        .map(({ props }) => {
          const choices = Array.isArray(props.choices)
            ? (props.choices as string[])
            : [];
          const explanation =
            typeof props.explanation === "string" ? props.explanation : "";
          const code = typeof props.code === "string" ? props.code : "";
          const language =
            typeof props.language === "string" ? props.language : "text";
          return `<div data-quiz-item><p>${escape(props.question as string)}</p>${code ? `<pre><code class="language-${escape(language)}">${escape(code)}</code></pre>` : ""}${choices.length ? `<ol>${choices.map((choice) => `<li>${escape(choice)}</li>`).join("")}</ol>` : ""}<details><summary>정답</summary><p>${escape(String(props.answer))}</p>${explanation ? `<p>${escape(explanation)}</p>` : ""}</details></div>`;
        })
        .join("");
      add(
        state,
        "QUIZ",
        { items: quizItems },
        quizItems.map((item) => String(item.props.question)).join("\n"),
        `<section data-mdx-component="ArticleQuiz">${html}</section>`,
      );
      return;
    }
  }
  if (name === "Callout") {
    const tone = attribute(node, "tone") ?? "note";
    const title = attribute(node, "title");
    if (
      hasOnlyAttributes(node, ["tone", "title"]) &&
      typeof tone === "string" &&
      (title === undefined || typeof title === "string")
    ) {
      const content = children.map((child) =>
        child.type === "paragraph"
          ? renderInline(child.children ?? [], state)
          : null,
      );
      if (content.every(Boolean)) {
        const text = content.map((item) => item?.text ?? "").join("\n");
        add(
          state,
          "CALLOUT",
          { tone, title, text },
          text,
          `<aside data-callout-tone="${escape(tone)}">${title ? `<strong>${escape(title)}</strong>` : ""}${content.map((item) => `<p>${item?.html ?? ""}</p>`).join("")}</aside>`,
        );
        return;
      }
    }
  }
  unsupported(node, state);
}

function flattenInlineChildren(children: Node[]): Node[] {
  return children.flatMap((child) => {
    if (
      child.type === "list" &&
      child.ordered &&
      child.children?.length === 1 &&
      child.children[0]?.children?.length === 1 &&
      child.children[0].children[0]?.type === "paragraph"
    ) {
      return [
        { type: "text", value: `${child.start ?? 1}. ` },
        ...flattenInlineChildren(child.children[0].children[0].children ?? []),
      ];
    }
    if (child.type === "paragraph")
      return flattenInlineChildren(child.children ?? []);
    if (child.type === "mdxFlowExpression")
      return [{ ...child, type: "mdxTextExpression" }];
    if (
      child.type === "mdxJsxFlowElement" &&
      ["strong", "em", "code", "Anchor", "span", "br"].includes(
        child.name ?? "",
      )
    ) {
      return [
        {
          ...child,
          type: "mdxJsxTextElement",
          children: flattenInlineChildren(child.children ?? []),
        },
      ];
    }
    return [child];
  });
}

function renderInline(
  nodes: Node[],
  state: RenderState,
): { html: string; text: string } {
  const parts = nodes.map((node) => {
    const inner = () => renderInline(node.children ?? [], state);
    switch (node.type) {
      case "text":
        return { html: escape(node.value ?? ""), text: node.value ?? "" };
      case "inlineCode":
        return {
          html: `<code>${escape(node.value ?? "")}</code>`,
          text: node.value ?? "",
        };
      case "strong": {
        const child = inner();
        return { html: `<strong>${child.html}</strong>`, text: child.text };
      }
      case "emphasis": {
        const child = inner();
        return { html: `<em>${child.html}</em>`, text: child.text };
      }
      case "delete": {
        const child = inner();
        return { html: `<del>${child.html}</del>`, text: child.text };
      }
      case "break":
        return { html: "<br />", text: "\n" };
      case "mdxTextExpression": {
        if (node.value === "" && !node.data?.estree?.body?.length)
          return { html: "{}", text: "{}" };
        const expression = node.data?.estree?.body?.[0]?.expression;
        const text = expression ? literal(expression) : undefined;
        if (typeof text === "string") return { html: escape(text), text };
        unsupported(node, state);
        return { html: "", text: "" };
      }
      case "link": {
        const child = inner();
        if (!safeUrl(node.url ?? "")) {
          unsupported(node, state);
          return child;
        }
        return {
          html: `<a href="${escape(node.url ?? "")}">${child.html}</a>`,
          text: child.text,
        };
      }
      case "mdxJsxTextElement": {
        const child = inner();
        if (node.name === "Paragraph" && !node.attributes?.length) return child;
        if (
          node.name === "Anchor" &&
          hasOnlyAttributes(node, ["href", "external"])
        ) {
          const href = attribute(node, "href") ?? attribute(node, "external");
          if (typeof href === "string" && safeUrl(href))
            return {
              html: `<a href="${escape(href)}">${child.html}</a>`,
              text: child.text,
            };
        }
        if (
          ["strong", "em", "code"].includes(node.name ?? "") &&
          !node.attributes?.length
        )
          return {
            html: `<${node.name}>${child.html}</${node.name}>`,
            text: child.text,
          };
        if (node.name === "br" && !node.attributes?.length)
          return { html: "<br />", text: "\n" };
        if (node.name === "span" && hasOnlyAttributes(node, ["style"])) {
          const styles = attribute(node, "style");
          if (styles && typeof styles === "object" && !Array.isArray(styles)) {
            const css = safeStyle(styles as Record<string, unknown>);
            if (css)
              return {
                html: `<span style="${escape(css)}">${child.html}</span>`,
                text: child.text,
              };
          }
        }
        unsupported(node, state);
        return child;
      }
      default:
        unsupported(node, state);
        return { html: "", text: "" };
    }
  });
  return {
    html: parts.map((part) => part.html).join(""),
    text: parts.map((part) => part.text).join(""),
  };
}

function attribute(node: Node, name: string): unknown {
  const attr = node.attributes?.find(
    (item) => item.type === "mdxJsxAttribute" && item.name === name,
  );
  if (!attr) return undefined;
  if (typeof attr.value === "string") return attr.value;
  if (attr.value === null) return true;
  const expression = attr.value?.data?.estree?.body?.[0]?.expression;
  return expression ? literal(expression) : undefined;
}

function literal(expression: LiteralExpression): unknown {
  if (expression.type === "Literal") return expression.value;
  if (
    expression.type === "TemplateLiteral" &&
    expression.expressions?.length === 0
  ) {
    return expression.quasis?.map((part) => part.value?.cooked ?? "").join("");
  }
  if (expression.type === "ArrayExpression") {
    const values = expression.elements?.map((element) =>
      element ? literal(element) : undefined,
    );
    return values?.every((value) => value !== undefined) ? values : undefined;
  }
  if (expression.type === "ObjectExpression") {
    const entries = expression.properties?.map((property) => {
      if (property.type !== "Property" || property.computed || !property.value)
        return null;
      const key = property.key?.name ?? property.key?.value;
      const value = literal(property.value);
      return typeof key === "string" && value !== undefined
        ? ([key, value] as const)
        : null;
    });
    return entries?.every(Boolean)
      ? Object.fromEntries(entries as Array<readonly [string, unknown]>)
      : undefined;
  }
  return undefined;
}

function hasOnlyAttributes(node: Node, allowed: string[]): boolean {
  return (node.attributes ?? []).every(
    (attr) =>
      attr.type === "mdxJsxAttribute" &&
      Boolean(attr.name) &&
      allowed.includes(attr.name!) &&
      attribute(node, attr.name!) !== undefined,
  );
}

function addImage(
  state: RenderState,
  url: string,
  alt: string,
  caption: string | undefined,
  node: Node,
  size?: string,
): void {
  if (!safeUrl(url)) {
    unsupported(node, state);
    return;
  }
  const img = `<img src="${escape(url)}" alt="${escape(alt)}" />`;
  state.assets.push({ kind: "INLINE_IMAGE", url, altText: alt || undefined });
  add(
    state,
    "IMAGE",
    { url, alt, caption, size },
    alt || caption || "",
    `<figure>${img}${caption ? `<figcaption>${escape(caption)}</figcaption>` : ""}</figure>`,
  );
}

function add(
  state: RenderState,
  type: ArticleBlockDraft["type"],
  content: Record<string, unknown>,
  plainText: string,
  html: string,
): void {
  state.blocks.push({
    type,
    sortOrder: state.blocks.length,
    content: content as ArticleBlockDraft["content"],
    plainText,
  });
  state.html.push(html);
}

function unsupported(node: Node, state: RenderState): void {
  state.unsupportedComponents.push({
    name: node.name ?? node.type,
    line: node.position?.start?.line ?? 1,
    strategy: "placeholder",
  });
  state.html.push(
    `<aside data-mdx-unsupported="${escape(node.name ?? node.type)}">Unsupported MDX content at line ${node.position?.start?.line ?? 1}</aside>`,
  );
}

function safeStyle(style: Record<string, unknown>): string | null {
  const allowed: Record<string, RegExp> = {
    color: /^#[0-9a-f]{3,8}$|^rgb\([\d,\s]+\)$/i,
    fontSize: /^\d{1,2}px$/,
    fontFamily: /^(sans-serif|serif|monospace)$/,
  };
  if (
    !Object.keys(style).length ||
    Object.keys(style).some(
      (key) =>
        !allowed[key] ||
        typeof style[key] !== "string" ||
        !allowed[key].test(style[key]),
    )
  )
    return null;
  return Object.entries(style)
    .map(
      ([key, value]) =>
        `${key === "fontSize" ? "font-size" : key === "fontFamily" ? "font-family" : key}:${value as string}`,
    )
    .join(";");
}

function safeUrl(url: string): boolean {
  return (
    /^https?:\/\/[^\s]+$/i.test(url) ||
    /^\/(?!\/)[^\s]*$/.test(url) ||
    /^#[^\s]+$/.test(url)
  );
}

function isHeadingLevel(level: unknown): boolean {
  return (
    typeof level === "number" &&
    Number.isInteger(level) &&
    level >= 1 &&
    level <= 6
  );
}

function uniqueId(base: string, toc: MdxTocItem[]): string {
  let candidate = base;
  let suffix = 2;
  while (toc.some((item) => item.id === candidate))
    candidate = `${base}-${suffix++}`;
  return candidate;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
