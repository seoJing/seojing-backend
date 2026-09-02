import { describe, expect, it } from "vitest";

import {
  blocksToSourceText,
  normalizeBlockEditorInputs,
  renderArticleBlocks,
} from "../src/services/block-renderer.js";

describe("block editor quote blocks", () => {
  it("normalizes, renders, and serializes an attributed quote", () => {
    const blocks = normalizeBlockEditorInputs([
      {
        type: "QUOTE",
        content: {
          text: "A backend renderer needs an observable origin marker.",
          attribution: "SEOJing migration gate",
        },
      },
    ]);

    expect(blocks[0]).toMatchObject({
      type: "QUOTE",
      plainText:
        "A backend renderer needs an observable origin marker. — SEOJing migration gate",
    });
    expect(renderArticleBlocks(blocks)).toContain(
      "<blockquote><p>A backend renderer needs an observable origin marker.</p><footer>— SEOJing migration gate</footer></blockquote>",
    );
    expect(blocksToSourceText(blocks)).toBe(
      "> A backend renderer needs an observable origin marker.\n> — SEOJing migration gate",
    );
  });
});
