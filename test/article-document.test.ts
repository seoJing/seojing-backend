import { describe, expect, it } from "vitest";

import {
  ArticleDocumentValidationError,
  renderArticleDocument,
} from "../src/services/article-document.js";

describe("canonical article document", () => {
  it("keeps formatting, lists, tables, images and every quiz item in its projection", () => {
    const rendered = renderArticleDocument({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "제목" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "굵게", marks: [{ type: "bold" }] }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "항목" }],
                },
              ],
            },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "표" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "image",
          attrs: { src: "/images/a.png", alt: "설명", caption: "캡션" },
        },
        {
          type: "quiz",
          attrs: {
            title: "확인",
            items: [
              { question: "하나?", mode: "description", answer: "일" },
              {
                question: "둘?",
                mode: "multiple",
                choices: ["A", "B"],
                answer: "B",
              },
            ],
          },
        },
      ],
    });

    expect(rendered.renderedHtml).toContain("<strong>굵게</strong>");
    expect(rendered.renderedHtml).toContain("<ul><li><p>항목</p></li></ul>");
    expect(rendered.renderedHtml).toContain(
      "<table><tr><th><p>표</p></th></tr></table>",
    );
    expect(rendered.renderedHtml).toContain("하나?");
    expect(rendered.renderedHtml).toContain("둘?");
    expect(rendered.assets).toEqual([
      { kind: "INLINE_IMAGE", url: "/images/a.png", altText: "설명" },
    ]);
    expect(rendered.blocks).toHaveLength(6);
    expect(rendered.document.content[5]?.type).toBe("quiz");
  });

  it("rejects unsafe or silently lossy content", () => {
    expect(() =>
      renderArticleDocument({
        type: "doc",
        content: [
          { type: "image", attrs: { src: "javascript:alert(1)", alt: "x" } },
        ],
      }),
    ).toThrow();
    expect(
      renderArticleDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "x", marks: [{ type: "underline" }] },
            ],
          },
        ],
      }).renderedHtml,
    ).toContain("<u>x</u>");
    expect(() =>
      renderArticleDocument({
        type: "doc",
        content: [{ type: "paragraph", attrs: { hidden: true } }],
      }),
    ).toThrow(ArticleDocumentValidationError);
    expect(
      renderArticleDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "email",
                marks: [
                  { type: "link", attrs: { href: "mailto:owner@example.com" } },
                ],
              },
            ],
          },
        ],
      }).renderedHtml,
    ).toContain('href="mailto:owner@example.com"');
    expect(() =>
      renderArticleDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [
                  {
                    type: "link",
                    attrs: { href: "mailto:bad%0Ajavascript:alert(1)" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});
