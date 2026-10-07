import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { convertMdxToArticleDocument } from "../src/services/mdx-to-document.js";

const root = process.argv[2] ? resolve(process.argv[2]) : "";
if (!root)
  throw new Error(
    "Usage: tsx scripts/audit-mdx-document-conversion.ts <content-root>",
  );
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
const errors: Array<{ slug: string; error: string }> = [];
let converted = 0;
let codeMeta = 0;
let alignedCells = 0;
let numberedQuizAnswers = 0;
let totalQuizItems = 0;
for (const file of files) {
  try {
    const { document } = convertMdxToArticleDocument(
      await readFile(file, "utf8"),
    );
    const visit = (node: (typeof document.content)[number]): void => {
      if (node.type === "codeBlock" && node.attrs?.meta) codeMeta++;
      if (["tableCell", "tableHeader"].includes(node.type) && node.attrs?.align)
        alignedCells++;
      if (node.type === "quiz" && Array.isArray(node.attrs?.items)) {
        totalQuizItems += node.attrs.items.length;
        numberedQuizAnswers += node.attrs.items.filter(
          (item: { answer?: unknown }) => typeof item.answer === "number",
        ).length;
      }
      for (const child of node.content ?? []) visit(child);
    };
    for (const node of document.content) visit(node);
    converted++;
  } catch (error) {
    errors.push({
      slug: relative(root, file).replace(/\.mdx?$/, ""),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
console.log(
  JSON.stringify(
    {
      files: files.length,
      converted,
      failed: errors.length,
      codeMeta,
      alignedCells,
      totalQuizItems,
      numberedQuizAnswers,
      errors,
    },
    null,
    2,
  ),
);
