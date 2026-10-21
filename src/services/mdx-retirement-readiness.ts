import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";

import { convertMdxToArticleDocument } from "./mdx-to-document.js";

export const RETAINED_MDX_POSTS = 201;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Validate nonblank strings without changing source bytes or public payloads.
const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const document = z
  .object({ type: z.literal("doc"), content: z.array(z.unknown()).min(1) })
  .strict();
const artifact = z.object({ path: text, sha256: hash });
const manifestSchema = z
  .array(z.object({ sourcePath: text, slug: text, sourceSha256: hash }))
  .length(RETAINED_MDX_POSTS);
const metadata = {
  title: text,
  description: z.string().nullable(),
  category: text,
  tags: z.array(z.string()),
  cover: z.json().nullable(),
  summaryVideo: z.json().nullable(),
  displayDate: z.iso.datetime().nullable(),
  displayUpdatedAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};
const publicArticle = z
  .object({
    slug: text,
    ...metadata,
    status: z.literal("PUBLISHED"),
    body: z
      .object({ document, html: z.string(), blocks: z.array(z.unknown()) })
      .passthrough(),
  })
  .passthrough();
const evidenceSchema = z.object({
  version: z.literal(1),
  capturedAt: z.iso.datetime(),
  webCommit: z.string().regex(/^[a-f0-9]{40}$/),
  backendCommit: z.string().regex(/^[a-f0-9]{40}$/),
  database: z.array(
    z.object({
      id: text,
      slug: text,
      ...metadata,
      status: z.literal("PUBLISHED"),
      sourceFormat: z.literal("DOCUMENT"),
      sourceText: z.string(),
      legacyRevision: z.object({
        id: text,
        articleId: text,
        sourceFormat: z.literal("MDX"),
        sourceText: text,
      }),
      currentRevisionId: text,
      latestRevisionId: text,
      currentRevision: z.object({
        id: text,
        articleId: text,
        sourceFormat: z.literal("DOCUMENT"),
        sourceText: z.string(),
        document,
      }),
    }),
  ),
  api: z.array(publicArticle),
  d1: z.array(
    z.object({
      slug: text,
      title: text,
      description: z.string().nullable(),
      category: text,
      tags_json: z.string(),
      cover_json: z.string().nullable(),
      display_date: z.string().nullable(),
      display_updated_at: z.string().nullable(),
      published_at: z.string(),
      updated_at: z.string(),
      payload_json: z.string(),
    }),
  ),
  visualAcceptances: z.array(
    z.object({
      slug: text,
      accepted: z.literal(true),
      reviewer: text,
      reviewedAt: z.iso.datetime(),
      sourceSha256: hash,
      documentSha256: hash,
      publicPayloadSha256: hash,
      desktop: artifact,
      mobile: artifact,
    }),
  ),
});

export type RetirementEvidence = z.infer<typeof evidenceSchema>;
export type ExpectedDocument = {
  sourcePath: string;
  slug: string;
  sourceSha256: string;
  documentSha256: string;
};

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Exactly the D1 projection used by prepare-public-article-snapshots.mjs. */
export function publicPayloadHash(
  value: z.infer<typeof publicArticle>,
): string {
  return sha256(
    stableJson({
      ...value,
      body: { document: value.body.document, html: "", blocks: [] },
    }),
  );
}

export function auditRetainedCorpus(
  contentRoot: string,
  manifest: unknown,
): ExpectedDocument[] {
  const entries = manifestSchema.parse(manifest);
  const root = resolve(contentRoot);
  function collect(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
      const path = resolve(directory, item.name);
      return item.isDirectory()
        ? collect(path)
        : item.isFile() && item.name.endsWith(".mdx")
          ? [relative(root, path).replaceAll("\\", "/")]
          : [];
    });
  }
  const paths = collect(root)
    .filter((path) => path !== "resume.mdx")
    .sort();
  if (
    stableJson(paths) !==
      stableJson(entries.map((entry) => entry.sourcePath).sort()) ||
    new Set(paths).size !== RETAINED_MDX_POSTS
  ) {
    throw new Error(
      "Corpus/manifest path set must match all 201 retained posts exactly.",
    );
  }
  if (new Set(entries.map((entry) => entry.slug)).size !== RETAINED_MDX_POSTS)
    throw new Error("Duplicate manifest slug.");
  return entries
    .map((entry) => {
      const path = resolve(root, entry.sourcePath);
      if (!path.startsWith(`${root}${sep}`))
        throw new Error("Source path escapes content root.");
      if (
        entry.slug !==
        entry.sourcePath.replace(/\.mdx$/, "").replace(/\/index$/, "")
      )
        throw new Error(`${entry.slug}: canonical slug mismatch`);
      const source = readFileSync(path, "utf8");
      if (sha256(source) !== entry.sourceSha256)
        throw new Error(`${entry.slug}: source hash mismatch`);
      const { document: converted } = convertMdxToArticleDocument(source);
      return { ...entry, documentSha256: sha256(stableJson(converted)) };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** Read-only, offline gate. An absent or incomplete evidence bundle can never pass. */
export function auditMdxRetirement(
  expected: ExpectedDocument[],
  input: unknown,
  readArtifact: (path: string) => Uint8Array,
): { ready: boolean; expected: number; accepted: number; blockers: string[] } {
  const blockers: string[] = [];
  const parsed = evidenceSchema.safeParse(input);
  if (
    expected.length !== RETAINED_MDX_POSTS ||
    new Set(expected.map((entry) => entry.slug)).size !== RETAINED_MDX_POSTS
  )
    blockers.push("Expected corpus must contain exactly 201 unique slugs.");
  if (!parsed.success) {
    blockers.push(
      ...parsed.error.issues.map(
        (issue) => `evidence.${issue.path.join(".")}: ${issue.message}`,
      ),
    );
    return {
      ready: false,
      expected: expected.length,
      accepted: 0,
      blockers: blockers.sort(),
    };
  }
  const evidence = parsed.data;
  const slugs = expected.map((entry) => entry.slug).sort();
  for (const key of ["database", "api", "d1", "visualAcceptances"] as const) {
    if (
      stableJson(evidence[key].map((row) => row.slug).sort()) !==
      stableJson(slugs)
    )
      blockers.push(
        `${key}: exact 201-slug set required (no missing, extra, duplicate or case-changed slugs).`,
      );
  }
  if (
    new Set(evidence.database.map((row) => row.id)).size !==
    evidence.database.length
  )
    blockers.push("database: duplicate Article identity.");
  const revisionIds = evidence.database.flatMap((row) => [
    row.legacyRevision.id,
    row.currentRevision.id,
  ]);
  if (new Set(revisionIds).size !== revisionIds.length)
    blockers.push(
      "database: legacy/current revision identities must be distinct.",
    );
  const db = new Map(evidence.database.map((row) => [row.slug, row]));
  const api = new Map(evidence.api.map((row) => [row.slug, row]));
  const d1 = new Map(evidence.d1.map((row) => [row.slug, row]));
  const visuals = new Map(
    evidence.visualAcceptances.map((row) => [row.slug, row]),
  );
  let accepted = 0;
  for (const entry of expected) {
    const row = db.get(entry.slug),
      response = api.get(entry.slug),
      snapshot = d1.get(entry.slug),
      visual = visuals.get(entry.slug);
    if (!row || !response || !snapshot || !visual) continue;
    const start = blockers.length;
    const check = (condition: boolean, reason: string) => {
      if (!condition) blockers.push(`${entry.slug}: ${reason}`);
    };
    check(
      row.currentRevisionId === row.currentRevision.id &&
        row.latestRevisionId === row.currentRevisionId,
      "current/latest published revision mismatch",
    );
    check(
      row.currentRevision.articleId === row.id &&
        row.legacyRevision.articleId === row.id,
      "legacy/current revision Article identity mismatch",
    );
    check(
      row.sourceFormat === row.currentRevision.sourceFormat &&
        row.sourceText === row.currentRevision.sourceText,
      "Article/currentRevision source mismatch",
    );
    // DOCUMENT writes and publication retain sourceText as an exact empty string.
    check(
      row.sourceText === "" && row.currentRevision.sourceText === "",
      "current DOCUMENT sourceText must be empty on Article and currentRevision",
    );
    check(
      sha256(row.legacyRevision.sourceText) === entry.sourceSha256,
      "retained DB MDX source hash mismatch",
    );
    check(
      sha256(stableJson(row.currentRevision.document)) === entry.documentSha256,
      "database DOCUMENT hash mismatch",
    );
    check(
      sha256(stableJson(response.body.document)) === entry.documentSha256,
      "API DOCUMENT hash mismatch",
    );
    for (const key of Object.keys(metadata) as Array<keyof typeof metadata>) {
      check(
        stableJson(row[key]) === stableJson(response[key]),
        `database/API ${key} mismatch`,
      );
    }
    check(response.body.html.trim().length > 0, "API rendered HTML missing");
    const payloadHash = publicPayloadHash(response);
    try {
      const payload = publicArticle.parse(JSON.parse(snapshot.payload_json));
      check(payload.slug === entry.slug, "D1 payload slug mismatch");
      check(
        sha256(stableJson(payload)) === payloadHash,
        "D1/API public payload parity mismatch",
      );
      for (const [column, value] of Object.entries({
        title: response.title,
        description: response.description ?? null,
        category: response.category,
        display_date: response.displayDate ?? null,
        display_updated_at: response.displayUpdatedAt ?? null,
        published_at: response.publishedAt,
        updated_at: response.updatedAt,
      }))
        check(
          snapshot[column as keyof typeof snapshot] === value,
          `D1 ${column} index column mismatch`,
        );
      check(
        stableJson(JSON.parse(snapshot.tags_json)) ===
          stableJson(response.tags ?? []),
        "D1 tags column mismatch",
      );
      check(
        stableJson(
          snapshot.cover_json ? JSON.parse(snapshot.cover_json) : null,
        ) === stableJson(response.cover ?? null),
        "D1 cover column mismatch",
      );
    } catch {
      check(false, "invalid D1 payload/column JSON");
    }
    check(
      visual.sourceSha256 === entry.sourceSha256 &&
        visual.documentSha256 === entry.documentSha256 &&
        visual.publicPayloadSha256 === payloadHash,
      "visual acceptance is stale for source/document/public payload",
    );
    for (const viewport of ["desktop", "mobile"] as const) {
      try {
        check(
          sha256(readArtifact(visual[viewport].path)) ===
            visual[viewport].sha256,
          `${viewport} evidence hash mismatch`,
        );
      } catch {
        check(false, `${viewport} evidence file missing or unreadable`);
      }
    }
    if (blockers.length === start) accepted++;
  }
  return {
    ready: blockers.length === 0 && accepted === RETAINED_MDX_POSTS,
    expected: expected.length,
    accepted,
    blockers: blockers.sort(),
  };
}
