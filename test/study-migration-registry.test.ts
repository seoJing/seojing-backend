import { describe, expect, it } from "vitest";

import { assessStudyMigration } from "../src/services/study-migration-registry.js";

describe("study migration registry assessment", () => {
  it("keeps an already-published current revision in readback-only state", () => {
    expect(
      assessStudyMigration({
        slug: "study/effective-typescript/day5",
        articleStatus: "PUBLISHED",
        hasCurrentRevision: true,
        unsupportedComponents: [],
        quizzes: [{ itemCount: 3 }],
      }),
    ).toMatchObject({
      status: "already-projected",
      nextStep: "Run API and canonical-route public readback.",
    });
  });

  it("blocks a candidate whose structured quiz lost all items", () => {
    expect(
      assessStudyMigration({
        slug: "study/javascript-quizbook/day1",
        hasCurrentRevision: false,
        unsupportedComponents: [{ name: "ArticleQuiz" }],
        quizzes: [{ itemCount: 0 }],
      }),
    ).toMatchObject({
      status: "needs-quiz-projection",
    });
  });

  it("blocks unsupported components before a DB projection is created", () => {
    expect(
      assessStudyMigration({
        slug: "study/javascript-quizbook/day2",
        hasCurrentRevision: false,
        unsupportedComponents: [{ name: "InteractiveSandbox" }],
        quizzes: [],
      }),
    ).toMatchObject({
      status: "needs-component-parity",
      reasons: ["Unsupported MDX component: InteractiveSandbox"],
    });
  });

  it("requires review for an existing non-published article", () => {
    expect(
      assessStudyMigration({
        slug: "study/javascript-quizbook/day3",
        articleStatus: "DRAFT",
        hasCurrentRevision: true,
        unsupportedComponents: [],
        quizzes: [],
      }),
    ).toMatchObject({
      status: "needs-existing-article-review",
    });

    expect(
      assessStudyMigration({
        slug: "study/javascript-quizbook/day4",
        articleStatus: "ARCHIVED",
        hasCurrentRevision: false,
        unsupportedComponents: [],
        quizzes: [],
      }),
    ).toMatchObject({
      status: "needs-existing-article-review",
    });
  });

  it("marks a component-safe source as a one-slug ingest candidate", () => {
    expect(
      assessStudyMigration({
        slug: "study/effective-typescript/day6",
        hasCurrentRevision: false,
        unsupportedComponents: [{ name: "ArticleQuiz" }],
        quizzes: [{ itemCount: 2 }],
      }),
    ).toMatchObject({
      status: "ready-for-ingest",
    });
  });
});
