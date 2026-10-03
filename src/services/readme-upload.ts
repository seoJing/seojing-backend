import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { inflateRawSync } from "node:zlib";

const MAX_FILE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 24_000;
const MAX_JOB_CHARS = 6_000;
const MAX_UNITS = 120;
const STOPWORDS = new Set([
  "경험",
  "우대",
  "담당",
  "업무",
  "관련",
  "지원",
  "필수",
  "및",
  "있는",
  "합니다",
  "위한",
  "해당",
  "모집",
  "채용",
  "경력",
  "능력",
  "역량",
  "the",
  "and",
  "with",
  "for",
]);

export class ReadmeInputError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ReadmeUploadInput {
  job_text: string;
  resume_filename: string;
  resume_media_type: string;
  resume_base64: string;
}

interface Unit {
  id: string;
  index: number;
  text: string;
}

interface Criterion {
  id: string;
  label: string;
  source_quote: string;
}

interface Event {
  seq: number;
  unit_id: string;
  type: "question" | "resolve" | "evidence" | "note";
  message: string;
  criterion_id?: string;
  question_id?: string;
  evidence_unit_ids?: string[];
}

function tokenize(text: string): string[] {
  const normalized = (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .map((word) =>
      word.replace(
        /(?:으로|에서|에게|까지|부터|처럼|하고|하여|했다|합니다|했습니다|이다|입니다|들을|들이|은|는|이|가|을|를|의|에|로|과|와)$/u,
        "",
      ),
    )
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
  return Array.from(new Set(normalized));
}

function normalizeText(text: string, maxChars: number): string {
  const normalized = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length < 20) {
    throw new ReadmeInputError(
      "text_too_short",
      "읽을 수 있는 문장이 부족합니다.",
      422,
    );
  }
  if (normalized.length > maxChars) {
    throw new ReadmeInputError(
      "text_too_long",
      "문서가 허용 길이를 초과합니다.",
      413,
    );
  }
  return normalized;
}

function validateEncodedFile(input: ReadmeUploadInput): Buffer {
  const encoded = input.resume_base64;
  if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) {
    throw new ReadmeInputError(
      "invalid_file",
      "파일 크기가 허용 범위를 넘었습니다.",
      413,
    );
  }
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ReadmeInputError("invalid_file", "파일 인코딩을 확인하세요.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new ReadmeInputError(
      "invalid_file",
      "파일 크기가 허용 범위를 넘었습니다.",
      413,
    );
  }
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
    throw new ReadmeInputError("invalid_file", "파일 인코딩을 확인하세요.");
  }
  return bytes;
}

function detectExtension(filename: string): "txt" | "md" | "pdf" | "docx" {
  if (
    filename.length > 120 ||
    /[/\\]/.test(filename) ||
    Array.from(filename).some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new ReadmeInputError("invalid_filename", "파일 이름을 확인하세요.");
  }
  const extension = filename.toLowerCase().split(".").at(-1);
  if (
    extension !== "txt" &&
    extension !== "md" &&
    extension !== "pdf" &&
    extension !== "docx"
  ) {
    throw new ReadmeInputError(
      "unsupported_file",
      "PDF, DOCX, TXT, MD 파일만 지원합니다.",
      415,
    );
  }
  return extension;
}

function checkDocxExpandedSize(bytes: Buffer): void {
  // Verify real expansion, not just attacker-controlled central-directory sizes.
  let eocd = -1;
  for (
    let index = bytes.length - 22;
    index >= Math.max(0, bytes.length - 65_557);
    index -= 1
  ) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0)
    throw new ReadmeInputError("invalid_docx", "유효한 DOCX가 아닙니다.");
  const diskNumber = bytes.readUInt16LE(eocd + 4);
  const diskWithCentralDirectory = bytes.readUInt16LE(eocd + 6);
  const recordsOnThisDisk = bytes.readUInt16LE(eocd + 8);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  let offset = centralOffset;
  let expanded = 0;
  if (
    entries === 0 ||
    entries > 100 ||
    diskNumber !== 0 ||
    diskWithCentralDirectory !== 0 ||
    recordsOnThisDisk !== entries ||
    centralOffset >= eocd ||
    centralSize === 0xffffffff ||
    centralOffset + centralSize !== eocd ||
    eocd + 22 + commentLength !== bytes.length
  ) {
    throw new ReadmeInputError(
      "docx_too_complex",
      "DOCX 구조가 허용 범위를 벗어납니다.",
      413,
    );
  }
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new ReadmeInputError("invalid_docx", "유효한 DOCX가 아닙니다.");
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const nextOffset =
      offset + 46 + nameLength + extraLength + entryCommentLength;
    if (nextOffset > eocd || nameLength === 0) {
      throw new ReadmeInputError("invalid_docx", "유효한 DOCX가 아닙니다.");
    }
    const centralName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const nameKey = centralName.toString("hex");
    if (names.has(nameKey)) {
      throw new ReadmeInputError(
        "invalid_docx",
        "DOCX에 중복된 파일 이름이 있습니다.",
        422,
      );
    }
    names.add(nameKey);
    if (
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      localOffset === 0xffffffff ||
      (flags & 1) !== 0 ||
      (method !== 0 && method !== 8)
    ) {
      throw new ReadmeInputError(
        "docx_too_complex",
        "지원하지 않는 DOCX 압축 형식입니다.",
        413,
      );
    }
    const remaining = 8 * 1024 * 1024 - expanded;
    if (uncompressed > remaining || localOffset + 30 > bytes.length) {
      throw new ReadmeInputError(
        "docx_too_large",
        "DOCX 압축 해제 크기가 너무 큽니다.",
        413,
      );
    }
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ReadmeInputError("invalid_docx", "유효한 DOCX가 아닙니다.");
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (
      bytes.readUInt16LE(localOffset + 8) !== method ||
      localNameLength !== nameLength ||
      !bytes
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .equals(centralName) ||
      dataOffset + compressed > centralOffset
    ) {
      throw new ReadmeInputError("invalid_docx", "유효한 DOCX가 아닙니다.");
    }
    let actualSize: number;
    try {
      actualSize =
        method === 0
          ? compressed
          : inflateRawSync(
              bytes.subarray(dataOffset, dataOffset + compressed),
              {
                maxOutputLength: remaining + 1,
              },
            ).length;
    } catch {
      throw new ReadmeInputError(
        "invalid_docx",
        "DOCX 압축을 읽지 못했습니다.",
        422,
      );
    }
    if (actualSize > remaining) {
      throw new ReadmeInputError(
        "docx_too_large",
        "DOCX 압축 해제 크기가 너무 큽니다.",
        413,
      );
    }
    if (actualSize !== uncompressed) {
      throw new ReadmeInputError(
        "invalid_docx",
        "DOCX 압축 크기 정보가 일치하지 않습니다.",
        422,
      );
    }
    expanded += actualSize;
    offset = nextOffset;
  }
  if (offset !== eocd) {
    throw new ReadmeInputError(
      "invalid_docx",
      "DOCX 항목 수가 일치하지 않습니다.",
      422,
    );
  }
}

export async function extractResumeText(
  input: ReadmeUploadInput,
): Promise<string> {
  const extension = detectExtension(input.resume_filename);
  const bytes = validateEncodedFile(input);
  const mediaType = input.resume_media_type.toLowerCase();
  if (extension === "pdf") {
    if (mediaType && mediaType !== "application/pdf") {
      throw new ReadmeInputError(
        "invalid_media_type",
        "PDF 파일 형식이 일치하지 않습니다.",
        415,
      );
    }
    if (bytes.subarray(0, 5).toString() !== "%PDF-") {
      throw new ReadmeInputError("invalid_pdf", "유효한 PDF가 아닙니다.", 422);
    }
    const parser = new PDFParse({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      stopAtErrors: true,
      maxImageSize: 1_000_000,
    });
    try {
      const result = await parser.getText({ first: 10, pageJoiner: "" });
      return normalizeText(result.text, MAX_TEXT_CHARS);
    } catch (error) {
      if (error instanceof ReadmeInputError) throw error;
      throw new ReadmeInputError(
        "unreadable_pdf",
        "PDF에서 텍스트를 읽지 못했습니다.",
        422,
      );
    } finally {
      await parser.destroy();
    }
  }
  if (extension === "docx") {
    if (
      mediaType &&
      mediaType !==
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      mediaType !== "application/octet-stream"
    ) {
      throw new ReadmeInputError(
        "invalid_media_type",
        "DOCX 파일 형식이 일치하지 않습니다.",
        415,
      );
    }
    if (bytes.subarray(0, 2).toString() !== "PK") {
      throw new ReadmeInputError(
        "invalid_docx",
        "유효한 DOCX가 아닙니다.",
        422,
      );
    }
    checkDocxExpandedSize(bytes);
    try {
      const result = await mammoth.extractRawText({ buffer: bytes });
      return normalizeText(result.value, MAX_TEXT_CHARS);
    } catch (error) {
      if (error instanceof ReadmeInputError) throw error;
      throw new ReadmeInputError(
        "unreadable_docx",
        "DOCX에서 텍스트를 읽지 못했습니다.",
        422,
      );
    }
  }
  if (
    mediaType &&
    !["text/plain", "text/markdown", "application/octet-stream"].includes(
      mediaType,
    )
  ) {
    throw new ReadmeInputError(
      "invalid_media_type",
      "텍스트 파일 형식이 일치하지 않습니다.",
      415,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReadmeInputError(
      "invalid_text_encoding",
      "UTF-8 텍스트 파일을 사용하세요.",
      422,
    );
  }
  return normalizeText(text, MAX_TEXT_CHARS);
}

function toUnits(text: string): { units: Unit[]; truncated: boolean } {
  const pieces = text
    .split(/(?:\n{2,}|(?<=[.!?。])\s+|\n)/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
  const chunks: string[] = [];
  for (const piece of pieces) {
    for (let start = 0; start < piece.length; start += 500) {
      chunks.push(piece.slice(start, start + 500));
    }
  }
  if (chunks.length === 0)
    throw new ReadmeInputError(
      "text_too_short",
      "분석할 문장이 없습니다.",
      422,
    );
  return {
    units: chunks.slice(0, MAX_UNITS).map((part, index) => ({
      id: `R${index + 1}`,
      index,
      text: part,
    })),
    truncated: chunks.length > MAX_UNITS,
  };
}

function toCriteria(jobText: string): Criterion[] {
  const lines = jobText
    .split(/(?:\n+|(?<=[.!?。])\s+)/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const sectionLines: string[] = [];
  let inRequirements = false;
  let sawRequirementHeading = false;
  for (const line of lines) {
    const cleaned = line
      .replace(/^[\s[(【■□●○▶◆#*•·-]+/u, "")
      .replace(/^\d+[.)]\s*/u, "");
    const heading = cleaned.match(
      /^(?:자격\s*요건|우대\s*사항|필수\s*요건|주요\s*업무|담당\s*업무)\s*[:：\])】]?\s*(.*)$/u,
    );
    if (heading) {
      inRequirements = true;
      sawRequirementHeading = true;
      const inlineRequirement = heading[1]?.trim() ?? "";
      if (inlineRequirement.length >= 8) sectionLines.push(inlineRequirement);
      continue;
    }
    if (
      /^(?:복지|혜택|근무\s*조건|회사\s*소개|채용\s*절차|전형|접수|근무지|기타)\s*(?:[:：\])】].*)?$/u.test(
        cleaned,
      )
    ) {
      inRequirements = false;
      continue;
    }
    if (inRequirements && cleaned.length >= 8) sectionLines.push(cleaned);
  }
  const fallbackLines = lines
    .map((line) => line.replace(/^[•*\-\s]+/u, ""))
    .filter(
      (line) =>
        line.length >= 8 &&
        /(?:필수|우대|경험|담당|요구|역량|자격)/u.test(line),
    );
  const fragments = (
    sawRequirementHeading
      ? sectionLines
      : fallbackLines.length
        ? fallbackLines
        : lines
  )
    .filter((line) => line.length >= 8)
    .slice(0, 8);
  return fragments.map((part, index) => ({
    id: `C${index + 1}`,
    label: part.slice(0, 50),
    source_quote: part.slice(0, 180),
  }));
}

export function buildUploadedPreview(jobInput: string, resumeText: string) {
  const jobText = normalizeText(jobInput, MAX_JOB_CHARS);
  const { units, truncated } = toUnits(resumeText);
  const criteria = toCriteria(jobText);
  const events: Event[] = [];
  const strengths: Array<{ text: string; unit_ids: string[] }> = [];
  const openQuestions: Array<{ text: string; unit_ids: string[] }> = [];
  let unresolved: { id: string; unitId: string; index: number } | undefined;

  for (const unit of units) {
    const words = new Set(tokenize(unit.text));
    const related = criteria.find(
      (criterion) =>
        tokenize(criterion.source_quote).filter((word) => words.has(word))
          .length >= 2,
    );
    const add = (event: Omit<Event, "seq">) =>
      events.push({ seq: events.length + 1, ...event });
    const concrete =
      /담당|작성|조정|구현|설계|제작|운영|관리|검토|분석|수행|built|implemented/i.test(
        unit.text,
      );
    const broad = /참여|경험|지원|개선|향상|기여|역량|expert|experience/i.test(
      unit.text,
    );

    if (unresolved && unit.index === unresolved.index + 1 && concrete) {
      add({
        unit_id: unit.id,
        type: "resolve",
        question_id: unresolved.id,
        message:
          "다음 문장에 구체적인 행동이 보입니다. 같은 경험의 설명인지 확인하세요.",
        evidence_unit_ids: [unresolved.unitId, unit.id],
      });
      unresolved = undefined;
    }
    if (related) {
      add({
        unit_id: unit.id,
        type: "evidence",
        criterion_id: related.id,
        message: `공고의 ‘${related.label}’와 겹치는 표현이 있습니다. 실제 관련성은 직접 확인하세요.`,
        evidence_unit_ids: [unit.id],
      });
      if (strengths.length < 3) {
        strengths.push({
          text: `공고의 ‘${related.label}’와 연결해 설명할 후보 문장입니다. 역할·범위를 확인하세요.`,
          unit_ids: [unit.id],
        });
      }
    } else if (broad && !concrete && !unresolved) {
      const questionId = `Q${unit.index}`;
      add({
        unit_id: unit.id,
        type: "question",
        question_id: questionId,
        message: "이 경험에서 직접 맡은 범위나 결과물을 더 설명할 수 있나요?",
        evidence_unit_ids: [unit.id],
      });
      unresolved = { id: questionId, unitId: unit.id, index: unit.index };
    } else {
      add({
        unit_id: unit.id,
        type: "note",
        message:
          "현재 문장을 읽었습니다. 공고 요건과의 직접 연결은 보류합니다.",
      });
    }
    if (unresolved && unit.index > unresolved.index + 1) {
      openQuestions.push({
        text: "직접 맡은 범위와 산출물이 이 부분에서 충분히 설명되는지 확인하세요.",
        unit_ids: [unresolved.unitId],
      });
      unresolved = undefined;
    }
  }
  if (unresolved) {
    openQuestions.push({
      text: "직접 맡은 범위와 산출물이 이 문서에서 확인되는지 살펴보세요.",
      unit_ids: [unresolved.unitId],
    });
  }
  if (!strengths.length) {
    openQuestions.push({
      text: "공고의 명시 요건과 직접 연결되는 표현을 규칙만으로 찾지 못했습니다.",
      unit_ids: [],
    });
  }
  const nextSteps = openQuestions.slice(0, 3).map((finding) => ({
    text: "실제 수행한 행동·범위·근거를 해당 문장에 덧붙일지 검토하세요.",
    unit_ids: finding.unit_ids,
  }));
  if (!nextSteps.length && units[0]) {
    nextSteps.push({
      text: "공고 원문과 연결한 후보 문장의 실제 기여 범위·근거를 최종 확인하세요.",
      unit_ids: strengths[0]?.unit_ids ?? [],
    });
  }
  return {
    mode: "rules_preview" as const,
    case_id: "user-upload" as const,
    job: {
      title: jobText.split("\n")[0]?.slice(0, 80) ?? "입력한 공고",
      text: jobText,
      criteria,
    },
    resume: { units },
    events,
    report: {
      strengths,
      open_questions: openQuestions,
      next_steps: nextSteps,
    },
    limitations: [
      "입력한 문서는 서버 메모리에서만 처리하며 서비스 DB에 저장하거나 모델 학습에 사용하지 않습니다.",
      "키워드/인접 문장 규칙 기반 미리보기입니다. Laya 모델과 고용24 데이터는 연결되지 않았습니다.",
      "질문 해소는 같은 경험인지 자동 인증하지 않습니다. 실제 채용 결과를 예측하지 않습니다.",
      ...(truncated
        ? [`문서가 길어 앞부분 ${MAX_UNITS}개 문장 단위만 분석했습니다.`]
        : []),
    ],
  };
}
