import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseFrontmatter } from "../src/services/mdx-ingest.js";

const root = process.argv[2] ? resolve(process.argv[2]) : "";
if (!root)
  throw new Error(
    "Usage: tsx scripts/audit-mdx-document-nodes.ts <content-root>",
  );
const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
const counts = new Map<string, number>();
const filesByKind = new Map<string, string[]>();
const valuesByKind = new Map<string, string[]>();
const attrsByKind = new Map<string, Set<string>>();
const walk = (
  node: {
    type: string;
    name?: string | null;
    value?: string;
    attributes?: Array<{ name?: string }>;
    children?: unknown[];
  },
  file: string,
) => {
  const kind = node.type.startsWith("mdxJsx")
    ? `${node.type}:${node.name ?? "fragment"}`
    : node.type;
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const files = filesByKind.get(kind) ?? [];
  if (files.length < 5 && !files.includes(file)) files.push(file);
  filesByKind.set(kind, files);
  for (const attr of node.attributes ?? []) {
    const names = attrsByKind.get(kind) ?? new Set<string>();
    names.add(attr.name ?? "spread");
    attrsByKind.set(kind, names);
  }
  if (kind === "mdxFlowExpression" || kind === "mdxTextExpression") {
    const values = valuesByKind.get(kind) ?? [];
    if (values.length < 30 && !values.includes(node.value ?? ""))
      values.push((node.value ?? "").slice(0, 120));
    valuesByKind.set(kind, values);
  }
  for (const child of node.children ?? []) walk(child as typeof node, file);
};
const files: string[] = [];
async function collect(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collect(child);
    else if (/\.mdx?$/.test(entry.name) && entry.name !== "resume.mdx")
      files.push(child);
  }
}
await collect(root);
for (const file of files) {
  const { body } = parseFrontmatter(await readFile(file, "utf8"));
  const ast = parser.parse(body);
  walk(ast, relative(root, file));
}
console.log(
  JSON.stringify(
    {
      files: files.length,
      kinds: [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => ({
          kind,
          count,
          examples: filesByKind.get(kind),
          values: valuesByKind.get(kind),
          attrs: [...(attrsByKind.get(kind) ?? [])],
        })),
    },
    null,
    2,
  ),
);
