import { createHash } from "node:crypto";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import {
  checkDocxExpandedSize,
  detectExtension,
  extractResumeText,
  validateEncodedFile,
  type ReadmeUploadInput,
} from "../readme-upload.js";
import type { Block, ResumeDocument, Unit } from "./contracts.js";
import { LabError } from "./errors.js";

type RawBlock = Pick<Block, "type" | "text" | "level">;

// Keep decimal measurements, dates and dotted product/domain names together.
// Breaking `12.5%` after `12.` changes the evidence available to a prefix reader.
function* sentenceParts(
  text: string,
): Generator<{ index: number; text: string }> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!/[.!?。\n]/u.test(char)) continue;
    if (char === "\n") {
      if (i > start) yield { index: start, text: text.slice(start, i) };
      start = i + 1;
      continue;
    }
    if (
      char === "." &&
      ((/[A-Za-z0-9]/u.test(text[i - 1] ?? "") &&
        /[A-Za-z0-9]/u.test(text[i + 1] ?? "")) ||
        (/^\s*\d+$/u.test(text.slice(0, i)) && /\s/u.test(text[i + 1] ?? "")))
    )
      continue;
    let end = i + 1;
    while (end < text.length && /[.!?。]/u.test(text[end]!)) end++;
    yield { index: start, text: text.slice(start, end) };
    start = end;
    i = end - 1;
  }
  if (start < text.length) yield { index: start, text: text.slice(start) };
}
export function textBlocks(text: string): RawBlock[] {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split(/\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const heading = /^(#{1,6})\s+/u.exec(line);
      return {
        type: heading
          ? "heading"
          : /^\s*(?:[-*•]|\d+[.)])\s/u.test(line)
            ? "list_item"
            : "paragraph",
        text: line,
        ...(heading ? { level: heading[1]!.length } : {}),
      };
    });
}

export function buildDocument(
  raw: RawBlock[],
  kind: ResumeDocument["source_kind"],
  warnings: string[] = [],
): ResumeDocument {
  const blocks: Block[] = [];
  const units: Unit[] = [];
  let scope = "";
  for (const input of raw) {
    const text = input.text.normalize("NFC").replace(/\r\n?/g, "\n");
    if (!text.trim()) continue;
    const block: Block = {
      ...input,
      text,
      id: `b${blocks.length + 1}`,
      unit_ids: [],
    };
    if (block.type === "heading") scope = block.id;
    // Without a heading, only the same paragraph is a known scope. Matching
    // words in separate paragraphs must not imply the same project.
    const scopeId = scope || block.id;
    const parts = sentenceParts(text);
    for (const match of parts) {
      const base = match.index;
      let start = base;
      const end = base + match.text.length;
      while (start < end) {
        let stop = Math.min(start + 400, end);
        if (stop < end && /[\uD800-\uDBFF]/u.test(text[stop - 1]!)) stop--;
        if (text.slice(start, stop).trim()) {
          const unit: Unit = {
            id: `u${units.length + 1}`,
            block_id: block.id,
            order: units.length,
            start,
            end: stop,
            text: text.slice(start, stop),
            scope_id: scopeId,
          };
          units.push(unit);
          block.unit_ids.push(unit.id);
        }
        start = stop;
      }
    }
    blocks.push(block);
  }
  const chars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  if (chars < 20 || !units.length) throw new LabError("document_too_short");
  if (chars > 24000 || units.length > 120)
    throw new LabError("document_too_long", 413);
  return {
    doc_id: createHash("sha256")
      .update(JSON.stringify(blocks))
      .digest("hex")
      .slice(0, 24),
    source_kind: kind,
    blocks,
    units,
    warnings,
    truncated: false,
  };
}

type HtmlNode = DefaultTreeAdapterMap["node"];
function htmlText(node: HtmlNode): string {
  if ("value" in node) return node.value;
  if ("tagName" in node && node.tagName === "br") return "\n";
  return "childNodes" in node ? node.childNodes.map(htmlText).join("") : "";
}
function htmlBlocks(node: HtmlNode, result: RawBlock[]): void {
  if ("tagName" in node) {
    const tag = node.tagName;
    if (/^h[1-6]$/u.test(tag) || tag === "p" || tag === "tr") {
      const text =
        tag === "tr" && "childNodes" in node
          ? node.childNodes
              .filter((n) => "tagName" in n && ["td", "th"].includes(n.tagName))
              .map(htmlText)
              .join(" | ")
          : htmlText(node);
      result.push({
        text,
        type:
          tag === "tr" ? "table_row" : tag === "p" ? "paragraph" : "heading",
        ...(/^h/u.test(tag) ? { level: Number(tag[1]) } : {}),
      });
      return;
    }
    if (tag === "li" && "childNodes" in node) {
      const direct = node.childNodes.filter(
        (n) => !("tagName" in n && ["ul", "ol"].includes(n.tagName)),
      );
      result.push({ text: direct.map(htmlText).join(""), type: "list_item" });
      for (const child of node.childNodes.filter((n) => !direct.includes(n)))
        htmlBlocks(child, result);
      return;
    }
  }
  if ("childNodes" in node)
    for (const child of node.childNodes) htmlBlocks(child, result);
}

export async function extractDocument(
  input: ReadmeUploadInput,
): Promise<ResumeDocument> {
  const kind = detectExtension(input.resume_filename);
  const bytes = validateEncodedFile(input);
  if (kind === "pdf") {
    if (
      input.resume_media_type &&
      input.resume_media_type !== "application/pdf"
    )
      throw new LabError("invalid_media_type", 415);
    if (bytes.subarray(0, 5).toString() !== "%PDF-")
      throw new LabError("text_extraction_failed");
    const parser = new PDFParse({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      stopAtErrors: true,
      maxImageSize: 1000000,
    });
    try {
      const result = await parser.getText({ first: 11, pageJoiner: "" });
      if (result.total > 10) throw new LabError("document_too_long", 413);
      return buildDocument(textBlocks(result.text), kind, [
        "PDF의 단·표·문단 순서는 달라질 수 있습니다. 누락과 읽기 순서를 확인하세요. 이미지 문자는 OCR하지 않습니다.",
      ]);
    } finally {
      await parser.destroy();
    }
  }
  if (kind === "docx") {
    if (
      input.resume_media_type &&
      ![
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/octet-stream",
      ].includes(input.resume_media_type)
    )
      throw new LabError("invalid_media_type", 415);
    checkDocxExpandedSize(bytes);
    const result = await mammoth.convertToHtml(
      { buffer: bytes },
      { externalFileAccess: false },
    );
    const blocks: RawBlock[] = [];
    htmlBlocks(parseFragment(result.value), blocks);
    return buildDocument(blocks, kind, [
      "DOCX의 텍스트와 제목·목록·표 행을 추출했습니다. 이미지·텍스트 상자·쪽 배치는 보존하지 않으므로 누락을 확인하세요.",
    ]);
  }
  return buildDocument(textBlocks(await extractResumeText(input)), kind);
}
