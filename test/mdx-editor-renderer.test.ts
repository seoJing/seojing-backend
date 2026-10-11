import { describe, expect, it } from "vitest";

import { renderMdxForEditor } from "../src/services/mdx-editor-renderer.js";

describe("CMS MDX editor renderer", () => {
  it("keeps rich text, tables, quiz answers, and images in blocks and sanitized preview", () => {
    const source = `---\ntitle: Preserved\n---\n\n<Subtitle level={2}>Section</Subtitle>\n\n<Paragraph>Important <strong>bold</strong> and <span style={{ color: "#ff0000" }}>red</span>.</Paragraph>\n\n| Key | Value |\n| --- | --- |\n| one | **two** |\n\n<ArticleImage\n src="/images/diagram.svg"\n alt="diagram"\n caption="A diagram"\n/>\n\n<ArticleQuiz>\n  <ArticleQuizItem mode="multiple" question="Which?" choices={["first", "second",]} answer={1} explanation="Because." />\n</ArticleQuiz>`;
    const result = renderMdxForEditor(source);

    expect(result.sourceText).toBe(source);
    expect(result.unsupportedComponents).toEqual([]);
    expect(result.blocks.map((block) => block.type)).toEqual([
      "HEADING",
      "PARAGRAPH",
      "PARAGRAPH",
      "IMAGE",
      "QUIZ",
    ]);
    expect(result.blocks[1]?.content).toMatchObject({
      html: 'Important <strong>bold</strong> and <span style="color:#ff0000">red</span>.',
    });
    expect(result.blocks[2]?.content).toMatchObject({
      table: { headers: ["Key", "Value"], rows: [["one", "two"]] },
    });
    expect(result.blocks[3]?.content).toMatchObject({
      url: "/images/diagram.svg",
      alt: "diagram",
      caption: "A diagram",
    });
    expect(result.blocks[4]?.content).toMatchObject({
      items: [{ props: { answer: 1, choices: ["first", "second"] } }],
    });
    expect(result.renderedHtml).toContain(
      '<span style="color:#ff0000">red</span>',
    );
    expect(result.renderedHtml).toContain("<table>");
    expect(result.renderedHtml).toContain("Because.");
    expect(result.assets).toEqual([
      expect.objectContaining({ url: "/images/diagram.svg" }),
    ]);
  });

  it("never executes expressions or makes unsupported content publishable", () => {
    const result = renderMdxForEditor(
      'Before {process.exit(1)} <UnknownWidget /> <span style={{ color: "red", backgroundImage: "url(javascript:bad)" }}>unsafe</span>',
    );
    expect(result.unsupportedComponents.map((issue) => issue.name)).toContain(
      "mdxTextExpression",
    );
    expect(result.unsupportedComponents.map((issue) => issue.name)).toContain(
      "UnknownWidget",
    );
    expect(result.renderedHtml).not.toContain("javascript:bad");
    expect(result.sourceText).toContain("process.exit(1)");
  });

  it("renders the current Fs article without an omitted component", () => {
    const source = `<Subtitle level={2}>문제 상황</Subtitle>\n\n<Paragraph>\n  요청은 \`/blog\`에서 <strong>404 Not Found</strong>였다.\n</Paragraph>\n\n<Subtitle level={3}>해결</Subtitle>\n\n<Paragraph>서버에서 본문을 읽는다.</Paragraph>`;
    const result = renderMdxForEditor(source);
    expect(result.unsupportedComponents).toEqual([]);
    expect(result.renderedHtml).toContain("404 Not Found");
    expect(result.blocks.map((block) => block.type)).toEqual([
      "HEADING",
      "PARAGRAPH",
      "HEADING",
      "PARAGRAPH",
    ]);
  });
});
