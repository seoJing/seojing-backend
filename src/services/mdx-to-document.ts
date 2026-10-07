import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import ts from "typescript";
import YAML from "yaml";

import {
  renderArticleDocument,
  type ArticleDocument,
  type ArticleDocumentNode,
} from "./article-document.js";
import { parseFrontmatter } from "./mdx-ingest.js";

type MdxNode = {
  type: string;
  name?: string | null;
  value?: string;
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  title?: string | null;
  alt?: string;
  ordered?: boolean;
  start?: number | null;
  align?: Array<string | null>;
  children?: MdxNode[];
  attributes?: Array<{
    type: string;
    name?: string;
    value?: string | { value?: string } | null;
  }>;
  position?: { start?: { line?: number } };
};

const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);

export class MdxDocumentConversionError extends Error {
  constructor(
    readonly nodeType: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${nodeType} at line ${line}: ${detail}`);
    this.name = "MdxDocumentConversionError";
  }
}

export function convertMdxToArticleDocument(sourceText: string): {
  document: ArticleDocument;
  frontmatter: Record<string, unknown>;
} {
  const { body } = parseFrontmatter(sourceText);
  const raw = sourceText.replace(/^\uFEFF/, "");
  const end = raw.startsWith("---\n") ? raw.indexOf("\n---", 4) : -1;
  const frontmatter: unknown = end >= 0 ? YAML.parse(raw.slice(4, end)) : {};
  if (
    !frontmatter ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  )
    throw new Error("Invalid MDX frontmatter.");
  const tree = parser.parse(body) as MdxNode;
  const document: ArticleDocument = {
    type: "doc",
    content: convertBlocks(tree.children ?? []),
  };
  renderArticleDocument(document);
  return { document, frontmatter: frontmatter as Record<string, unknown> };
}

function convertBlocks(nodes: MdxNode[]): ArticleDocumentNode[] {
  return nodes.flatMap(convertBlock);
}

function convertBlock(node: MdxNode): ArticleDocumentNode[] {
  switch (node.type) {
    case "paragraph": {
      const children = node.children ?? [];
      if (children.length === 1 && isJsx(children[0], "Subtitle"))
        return [subtitle(children[0]!)];
      if (children.length === 1 && isJsx(children[0], "Paragraph")) {
        const nested = children[0]!.children ?? [];
        return nested.some(isEmbeddedBlock)
          ? convertBlocks(nested)
          : [{ type: "paragraph", content: convertInline(nested) }];
      }
      if (children.some(isEmbeddedBlock)) {
        const converted: ArticleDocumentNode[] = [];
        let inline: MdxNode[] = [];
        const flush = () => {
          if (inline.length)
            converted.push({
              type: "paragraph",
              content: convertInline(inline),
            });
          inline = [];
        };
        for (const child of children) {
          if (isEmbeddedBlock(child)) {
            flush();
            converted.push(...convertBlock(child));
          } else inline.push(child);
        }
        flush();
        return converted;
      }
      return [{ type: "paragraph", content: convertInline(children) }];
    }
    case "heading":
      return [
        {
          type: "heading",
          attrs: { level: node.depth ?? 2 },
          content: convertInline(node.children ?? []),
        },
      ];
    case "code":
      return [
        {
          type: "codeBlock",
          attrs: {
            ...(node.lang ? { language: node.lang } : {}),
            ...(node.meta ? { meta: node.meta } : {}),
          },
          content: [{ type: "text", text: node.value ?? "" }],
        },
      ];
    case "list":
      return [
        {
          type: node.ordered ? "orderedList" : "bulletList",
          attrs:
            node.ordered && node.start && node.start !== 1
              ? { start: node.start }
              : undefined,
          content: (node.children ?? []).map((child) => {
            if (child.type !== "listItem") fail(child, "Expected a list item");
            return {
              type: "listItem",
              content: convertBlocks(child.children ?? []),
            };
          }),
        },
      ];
    case "blockquote":
      return [
        { type: "blockquote", content: convertBlocks(node.children ?? []) },
      ];
    case "thematicBreak":
      return [{ type: "horizontalRule" }];
    case "table":
      return [
        {
          type: "table",
          content: (node.children ?? []).map((row, rowIndex) => {
            if (row.type !== "tableRow") fail(row, "Expected a table row");
            return {
              type: "tableRow",
              content: (row.children ?? []).map((cell, cellIndex) => {
                if (cell.type !== "tableCell")
                  fail(cell, "Expected a table cell");
                return {
                  type: rowIndex === 0 ? "tableHeader" : "tableCell",
                  attrs: node.align?.[cellIndex]
                    ? { align: node.align[cellIndex] }
                    : undefined,
                  content: [
                    {
                      type: "paragraph",
                      content: convertInline(cell.children ?? []),
                    },
                  ],
                };
              }),
            };
          }),
        },
      ];
    case "image":
      return [imageNode(node.url, node.alt, node.title)];
    case "mdxFlowExpression": {
      const value = literalExpression(node);
      return value
        ? [{ type: "paragraph", content: [{ type: "text", text: value }] }]
        : [];
    }
    case "mdxjsEsm":
      return [];
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return convertJsxBlock(node);
    default:
      fail(node, "Unsupported block");
  }
}

function convertJsxBlock(node: MdxNode): ArticleDocumentNode[] {
  switch (node.name) {
    case "Paragraph":
      return convertBlocks(node.children ?? []).flatMap((child) =>
        child.type === "paragraph" ? [child] : [child],
      );
    case "Subtitle":
      return [subtitle(node)];
    case "Anchor":
      return [
        {
          type: "paragraph",
          content: applyMark(convertInlineChildrenAsText(node.children ?? []), {
            type: "link",
            attrs: { href: anchorHref(node) },
          }),
        },
      ];
    case "strong":
      return convertBlocks(node.children ?? []).map((child) =>
        markTree(child, { type: "bold" }),
      );
    case "em":
      return convertBlocks(node.children ?? []).map((child) =>
        markTree(child, { type: "italic" }),
      );
    case "ArticleImage":
      return [
        imageNode(
          stringAttribute(node, "src"),
          stringAttribute(node, "alt"),
          stringAttribute(node, "caption"),
          stringAttribute(node, "size"),
        ),
      ];
    case "ArticleQuiz":
      return [quizNode(node)];
    default:
      fail(node, `Unsupported JSX component ${node.name ?? "fragment"}`);
  }
}

function convertInline(
  nodes: MdxNode[],
  marks: NonNullable<ArticleDocumentNode["marks"]> = [],
): ArticleDocumentNode[] {
  return nodes.flatMap((node): ArticleDocumentNode[] => {
    switch (node.type) {
      case "text":
        return node.value
          ? [
              {
                type: "text",
                text: node.value,
                ...(marks.length ? { marks } : {}),
              },
            ]
          : [];
      case "inlineCode":
        return [
          {
            type: "text",
            text: node.value ?? "",
            marks: [...marks, { type: "code" }],
          },
        ];
      case "strong":
        return convertInline(node.children ?? [], [...marks, { type: "bold" }]);
      case "emphasis":
        return convertInline(node.children ?? [], [
          ...marks,
          { type: "italic" },
        ]);
      case "delete":
        return convertInline(node.children ?? [], [
          ...marks,
          { type: "strike" },
        ]);
      case "link": {
        if (node.title) fail(node, "Link title is not supported");
        return convertInline(node.children ?? [], [
          ...marks,
          { type: "link", attrs: { href: node.url } },
        ]);
      }
      case "mdxTextExpression": {
        const value = literalExpression(node);
        return value
          ? [{ type: "text", text: value, ...(marks.length ? { marks } : {}) }]
          : [];
      }
      case "mdxJsxTextElement":
      case "mdxJsxFlowElement": {
        if (node.name === "br") return [{ type: "hardBreak" }];
        if (
          node.name === "strong" ||
          node.name === "em" ||
          node.name === "code"
        )
          return convertInline(node.children ?? [], [
            ...marks,
            {
              type:
                node.name === "strong"
                  ? "bold"
                  : node.name === "em"
                    ? "italic"
                    : "code",
            },
          ]);
        if (node.name === "Anchor")
          return convertInline(node.children ?? [], [
            ...marks,
            { type: "link", attrs: { href: anchorHref(node) } },
          ]);
        if (node.name === "Paragraph")
          return convertInline(node.children ?? [], marks);
        return fail(
          node,
          `Unsupported inline JSX component ${node.name ?? "fragment"}`,
        );
      }
      default:
        return fail(node, "Unsupported inline content");
    }
  });
}

function convertInlineChildrenAsText(nodes: MdxNode[]): ArticleDocumentNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "paragraph") return convertInline(node.children ?? []);
    if (node.type === "mdxFlowExpression")
      return [{ type: "text", text: literalExpression(node) }];
    if (node.type === "list")
      return (node.children ?? []).flatMap((item, index) => [
        {
          type: "text",
          text: `${node.ordered ? `${(node.start ?? 1) + index}.` : "•"} `,
        },
        ...convertInlineChildrenAsText(item.children ?? []),
      ]);
    return convertInline([node]);
  });
}

function isEmbeddedBlock(node: MdxNode): boolean {
  return (
    ["image", "list", "mdxFlowExpression"].includes(node.type) ||
    (node.type.startsWith("mdxJsx") &&
      ["Subtitle", "ArticleImage", "ArticleQuiz"].includes(node.name ?? ""))
  );
}

function subtitle(node: MdxNode): ArticleDocumentNode {
  const rawLevel = attribute(node, "level") ?? 2;
  if (typeof rawLevel !== "number" || rawLevel < 1 || rawLevel > 6)
    fail(node, "Invalid Subtitle level");
  return {
    type: "heading",
    attrs: { level: rawLevel },
    content: convertInlineChildrenAsText(node.children ?? []),
  };
}

function imageNode(
  src: string | undefined,
  alt: string | undefined,
  caption?: string | null,
  size?: string,
): ArticleDocumentNode {
  if (!src || alt === undefined)
    throw new Error("Image source and alt are required");
  return {
    type: "image",
    attrs: {
      src,
      alt,
      ...(caption ? { caption } : {}),
      ...(size ? { size } : {}),
    },
  };
}

function quizNode(node: MdxNode): ArticleDocumentNode {
  const items = (node.children ?? [])
    .filter(
      (child) =>
        child.type !== "paragraph" ||
        (child.children ?? []).some(
          (item) => item.type !== "text" || item.value?.trim(),
        ),
    )
    .flatMap((child) =>
      child.type === "mdxJsxFlowElement" && child.name === "ArticleQuizItem"
        ? [child]
        : child.type === "paragraph" && !(child.children ?? []).length
          ? []
          : fail(child, "Unsupported quiz child"),
    );
  if (!items.length) fail(node, "Quiz has no items");
  return {
    type: "quiz",
    attrs: {
      ...(stringAttribute(node, "title")
        ? { title: stringAttribute(node, "title") }
        : {}),
      items: items.map((item) => {
        const mode = attribute(item, "mode") ?? "description";
        const question = attribute(item, "question");
        const answer = attribute(item, "answer");
        const choices = attribute(item, "choices");
        const explanation = attribute(item, "explanation");
        const code = attribute(item, "code");
        if (
          typeof question !== "string" ||
          (typeof answer !== "string" && typeof answer !== "number") ||
          typeof mode !== "string" ||
          (choices !== undefined &&
            (!Array.isArray(choices) ||
              choices.some((choice) => typeof choice !== "string")))
        )
          fail(item, "Invalid quiz item");
        return {
          mode,
          question,
          answer,
          ...(choices !== undefined ? { choices } : {}),
          ...(typeof explanation === "string" ? { explanation } : {}),
          ...(typeof code === "string" ? { code } : {}),
        };
      }),
    },
  };
}

function anchorHref(node: MdxNode): string {
  const href = attribute(node, "href") ?? attribute(node, "external");
  if (typeof href !== "string") fail(node, "Anchor href is required");
  return href;
}

function stringAttribute(node: MdxNode, name: string): string | undefined {
  const value = attribute(node, name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(node, `${name} must be a string`);
  return value;
}

function attribute(node: MdxNode, name: string): unknown {
  const attr = node.attributes?.find((item) => item.name === name);
  if (!attr) return undefined;
  if (attr.type !== "mdxJsxAttribute")
    fail(node, "Spread attributes are not supported");
  if (attr.value === null || attr.value === undefined) return true;
  if (typeof attr.value === "string") return attr.value;
  return parseStaticExpression(attr.value.value ?? "", node, name);
}

function parseStaticExpression(
  expression: string,
  node: MdxNode,
  name: string,
): unknown {
  try {
    return JSON.parse(expression);
  } catch {
    /* JSX arrays may contain trailing commas. */
  }
  const source = ts.createSourceFile(
    "attribute.ts",
    `const value = (${expression});`,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = (source.statements[0] as ts.VariableStatement)
    .declarationList.declarations[0];
  const evaluate = (input: ts.Expression): unknown => {
    if (ts.isParenthesizedExpression(input)) return evaluate(input.expression);
    if (ts.isStringLiteral(input) || ts.isNoSubstitutionTemplateLiteral(input))
      return input.text;
    if (ts.isNumericLiteral(input)) return Number(input.text);
    if (input.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (input.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (input.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(input))
      return input.elements.map((item) => {
        if (!ts.isExpression(item)) fail(node, `Non-literal attribute ${name}`);
        return evaluate(item);
      });
    fail(node, `Non-literal attribute ${name}`);
  };
  if (!declaration?.initializer) fail(node, `Non-literal attribute ${name}`);
  return evaluate(declaration.initializer);
}

function literalExpression(node: MdxNode): string {
  const expression = node.value?.trim();
  if (!expression) return "";
  try {
    const value: unknown = JSON.parse(expression);
    if (typeof value !== "string")
      fail(node, "Only literal string expressions can be converted");
    return value;
  } catch {
    fail(node, "Non-literal MDX expression");
  }
}

function applyMark(
  nodes: ArticleDocumentNode[],
  mark: NonNullable<ArticleDocumentNode["marks"]>[number],
): ArticleDocumentNode[] {
  return nodes.map((node) => markTree(node, mark));
}

function markTree(
  node: ArticleDocumentNode,
  mark: NonNullable<ArticleDocumentNode["marks"]>[number],
): ArticleDocumentNode {
  if (node.type === "text")
    return { ...node, marks: [...(node.marks ?? []), mark] };
  return {
    ...node,
    ...(node.content
      ? { content: node.content.map((child) => markTree(child, mark)) }
      : {}),
  };
}

function isJsx(node: MdxNode | undefined, name: string): boolean {
  return Boolean(node && node.name === name && node.type.startsWith("mdxJsx"));
}

function fail(node: MdxNode, detail: string): never {
  throw new MdxDocumentConversionError(
    node.name ? `${node.type}:${node.name}` : node.type,
    node.position?.start?.line ?? 0,
    detail,
  );
}
