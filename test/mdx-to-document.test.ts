import { describe, expect, it } from "vitest";

import { convertMdxToArticleDocument } from "../src/services/mdx-to-document.js";

describe("one-time MDX document conversion", () => {
  it("preserves frontmatter, inline marks, table alignment and all quiz answers", () => {
    const converted = convertMdxToArticleDocument(`---
title: 이전 글
date: 2026-03-23
tags: [스터디, HTML]
cover:
  src: /images/cover.png
  alt: 대표 이미지
---

<Subtitle level={2}>학습 내용</Subtitle>

<Paragraph>중요한 {" "}<strong>문장</strong>입니다.</Paragraph>

| 이름 | 값 |
| :--- | ---: |
| 항목 | **확인** |

<ArticleQuiz title="확인 문제">
  <ArticleQuizItem mode="multiple" question="정답은?" choices={["아니오", "예",]} answer={1} explanation="두 번째" />
  <ArticleQuizItem mode="description" question="이름은?" answer="값" />
</ArticleQuiz>`);

    expect(converted.frontmatter.cover).toEqual({
      src: "/images/cover.png",
      alt: "대표 이미지",
    });
    expect(converted.document.content.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "table",
      "quiz",
    ]);
    expect(
      converted.document.content[1]?.content?.some((node) =>
        node.marks?.some((mark) => mark.type === "bold"),
      ),
    ).toBe(true);
    expect(
      converted.document.content[2]?.content?.[0]?.content?.[0]?.attrs?.align,
    ).toBe("left");
    const quiz = converted.document.content[3];
    expect((quiz?.attrs?.items as unknown[]).length).toBe(2);
    expect((quiz?.attrs?.items as Array<{ answer: unknown }>)[0]?.answer).toBe(
      1,
    );
  });

  it("rejects executable MDX expressions instead of evaluating them", () => {
    expect(() =>
      convertMdxToArticleDocument("<Paragraph>{getSecret()}</Paragraph>"),
    ).toThrow("Non-literal");
  });
});
