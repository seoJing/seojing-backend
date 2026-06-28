import { describe, expect, it, vi } from "vitest";

import { importMdxArticleDraft } from "../src/services/article-ingest.js";
import type { ArticleService } from "../src/services/articles.js";
import {
  ingestMdxArticle,
  parseFrontmatter,
} from "../src/services/mdx-ingest.js";

const mdxSource = `---
title: "JS Quizbook Day 1"
description: "Execution context reminder"
tags: [javascript, quiz]
---

import { ArticleQuiz } from "~/components/ArticleQuiz";

# JS Quizbook Day 1

## 실행 컨텍스트

본문 첫 문단과 **강조** 그리고 [링크](/blog/test)가 있다.

![흐름도](/images/content/study/js/day1/flow.svg "Execution flow")

\`\`\`ts
const answer = 42;
\`\`\`

<ArticleQuiz id="q1" />

<UnknownWidget value="x" />
`;

describe("MDX ingest pipeline", () => {
  it("parses frontmatter, slug, TOC, sanitized HTML, blocks, assets, and component placeholders", () => {
    const article = ingestMdxArticle(mdxSource, {
      sourcePath: "/repo/apps/web/content/study/javascript-quizbook/day1.mdx",
      contentRoot: "/repo/apps/web/content",
    });

    expect(article.slug).toBe("study/javascript-quizbook/day1");
    expect(article.title).toBe("JS Quizbook Day 1");
    expect(article.description).toBe("Execution context reminder");
    expect(article.frontmatter.tags).toEqual(["javascript", "quiz"]);
    expect(article.toc).toEqual([
      { id: "js-quizbook-day-1", depth: 1, text: "JS Quizbook Day 1" },
      { id: "실행-컨텍스트", depth: 2, text: "실행 컨텍스트" },
    ]);
    expect(article.renderedHtml).toContain(
      '<h2 id="실행-컨텍스트">실행 컨텍스트</h2>',
    );
    expect(article.renderedHtml).toContain('<a href="/blog/test">링크</a>');
    expect(article.renderedHtml).toContain('data-mdx-component="ArticleQuiz"');
    expect(article.renderedHtml).not.toContain("import { ArticleQuiz }");
    expect(article.blocks.map((block) => block.type)).toEqual([
      "HEADING",
      "HEADING",
      "PARAGRAPH",
      "IMAGE",
      "CODE",
      "QUIZ",
      "RAW_MDX",
    ]);
    expect(article.assets).toEqual([
      expect.objectContaining({
        kind: "INLINE_IMAGE",
        url: "/images/content/study/js/day1/flow.svg",
        altText: "흐름도",
      }),
    ]);
    expect(article.unsupportedComponents).toEqual([
      {
        name: "ArticleQuiz",
        line: 16,
        strategy: "structured-block-candidate",
      },
      { name: "UnknownWidget", line: 18, strategy: "placeholder" },
    ]);
  });

  it("uses frontmatter slug when present and escapes raw HTML instead of trusting it", () => {
    const article = ingestMdxArticle(
      `---\nslug: custom/Slug!!\n---\n\n# <script>alert(1)</script>`,
    );

    expect(article.slug).toBe("custom/slug");
    expect(article.renderedHtml).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(article.renderedHtml).not.toContain("<script>");
  });

  it("keeps sources without frontmatter intact", () => {
    const parsed = parseFrontmatter("# Plain MDX\n\nBody");

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("# Plain MDX\n\nBody");
  });
});

describe("importMdxArticleDraft", () => {
  it("passes rendered MDX output into ArticleService", async () => {
    const createInitialDraft = vi.fn().mockResolvedValue({
      id: "article-1",
      slug: "study/javascript-quizbook/day1",
    });
    const service = { createInitialDraft } as unknown as ArticleService;

    const result = await importMdxArticleDraft(service, mdxSource, {
      sourcePath: "/repo/apps/web/content/study/javascript-quizbook/day1.mdx",
      contentRoot: "/repo/apps/web/content",
    });

    expect(result.article.id).toBe("article-1");
    expect(createInitialDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "study/javascript-quizbook/day1",
        title: "JS Quizbook Day 1",
        description: "Execution context reminder",
        sourceFormat: "MDX",
        renderedHtml: expect.stringContaining(
          'data-mdx-component="ArticleQuiz"',
        ) as string,
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "QUIZ" }),
        ]) as unknown,
        assets: expect.arrayContaining([
          expect.objectContaining({ kind: "INLINE_IMAGE" }),
        ]) as unknown,
      }),
    );
  });
});
