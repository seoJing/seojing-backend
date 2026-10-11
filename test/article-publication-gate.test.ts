import { describe, expect, it, vi } from "vitest";

import type {
  ArticleRepository,
  ArticleWithContent,
} from "../src/repositories/articles.js";
import {
  ArticlePublicationBlocked,
  ArticleService,
} from "../src/services/articles.js";
import { renderMdxForEditor } from "../src/services/mdx-editor-renderer.js";

function article(sourceText: string, renderedHtml: string): ArticleWithContent {
  const blocks = renderMdxForEditor(sourceText).blocks.map((block, index) => ({
    ...block,
    revisionId: "latest",
    sortOrder: index,
  }));
  return {
    slug: "test/post",
    revisions: [
      { id: "latest", sourceFormat: "MDX", sourceText, renderedHtml },
    ],
    currentRevisionId: "latest",
    blocks,
  } as unknown as ArticleWithContent;
}

describe("MDX revision publication gate", () => {
  it("saves server-rendered HTML and blocks instead of trusting supplied HTML", async () => {
    const createEditorRevision = vi.fn().mockResolvedValue(null);
    const service = new ArticleService({
      createEditorRevision,
    } as unknown as ArticleRepository);
    await service.createEditorRevision("test/post", {
      sourceText: "# Safe\n\n**strong**",
      renderedHtml: "<script>alert(1)</script>",
    });
    expect(createEditorRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        renderedHtml: expect.stringContaining(
          "<strong>strong</strong>",
        ) as string,
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "PARAGRAPH" }),
        ]) as unknown,
      }),
    );
    const saved = createEditorRevision.mock.calls[0]?.[0] as {
      renderedHtml: string;
    };
    expect(saved.renderedHtml).not.toContain("<script>");
  });

  it("rejects unsupported MDX and stale rendered revisions without publishing", async () => {
    const publishLatestRevision = vi.fn();
    const findBySlug = vi
      .fn()
      .mockResolvedValue(article("# Title\n\n<Unknown />", "old"));
    const service = new ArticleService({
      findBySlug,
      publishLatestRevision,
    } as unknown as ArticleRepository);
    await expect(
      service.publishCurrentRevision("test/post"),
    ).rejects.toBeInstanceOf(ArticlePublicationBlocked);
    expect(publishLatestRevision).not.toHaveBeenCalled();

    findBySlug.mockResolvedValue(article("# Title\n\nBody", "old"));
    await expect(service.publishCurrentRevision("test/post")).rejects.toThrow(
      "Save a fresh revision",
    );
    expect(publishLatestRevision).not.toHaveBeenCalled();
  });

  it("publishes a freshly rendered supported revision", async () => {
    const source = "# Title\n\nBody";
    const current = article(source, renderMdxForEditor(source).renderedHtml);
    const publishLatestRevision = vi.fn().mockResolvedValue(current);
    const service = new ArticleService({
      findBySlug: vi.fn().mockResolvedValue(current),
      publishLatestRevision,
    } as unknown as ArticleRepository);
    await expect(service.publishCurrentRevision("test/post")).resolves.toBe(
      current,
    );
    expect(publishLatestRevision).toHaveBeenCalledWith("test/post", "latest");
    publishLatestRevision.mockResolvedValueOnce(null);
    await expect(service.publishCurrentRevision("test/post")).rejects.toThrow(
      "revision changed",
    );
  });
});
