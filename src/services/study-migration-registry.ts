export type StudyMigrationStatus =
  | "already-projected"
  | "ready-for-ingest"
  | "needs-quiz-projection"
  | "needs-component-parity"
  | "needs-existing-article-review";

export interface StudyMigrationAssessmentInput {
  slug: string;
  articleStatus?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  hasCurrentRevision: boolean;
  unsupportedComponents: Array<{ name: string }>;
  quizzes: Array<{ itemCount: number }>;
}

export interface StudyMigrationAssessment {
  slug: string;
  status: StudyMigrationStatus;
  nextStep: string;
  reasons: string[];
}

const supportedStructuredComponents = new Set([
  "ArticleQuiz",
  "ArticleQuizItem",
  "Callout",
]);

export function assessStudyMigration(
  input: StudyMigrationAssessmentInput,
): StudyMigrationAssessment {
  const unsupportedNames = [
    ...new Set(
      input.unsupportedComponents
        .map((component) => component.name)
        .filter((name) => !supportedStructuredComponents.has(name)),
    ),
  ];

  if (unsupportedNames.length) {
    return {
      slug: input.slug,
      status: "needs-component-parity",
      nextStep: "Add renderer parity before ingesting this article.",
      reasons: [`Unsupported MDX component: ${unsupportedNames.join(", ")}`],
    };
  }

  if (input.quizzes.some((quiz) => quiz.itemCount === 0)) {
    return {
      slug: input.slug,
      status: "needs-quiz-projection",
      nextStep:
        "Repair ArticleQuiz item projection before ingesting this article.",
      reasons: ["At least one ArticleQuiz has no projected items."],
    };
  }

  if (input.articleStatus === "PUBLISHED" && input.hasCurrentRevision) {
    return {
      slug: input.slug,
      status: "already-projected",
      nextStep: "Run API and canonical-route public readback.",
      reasons: ["A published article with a current revision already exists."],
    };
  }

  if (input.articleStatus) {
    return {
      slug: input.slug,
      status: "needs-existing-article-review",
      nextStep:
        "Review the existing draft or archived revision before creating or publishing another revision.",
      reasons: [
        `Existing ${input.articleStatus} article must not be treated as a new ingest candidate.`,
      ],
    };
  }

  return {
    slug: input.slug,
    status: "ready-for-ingest",
    nextStep:
      "Ingest one slug, publish it, then run API and canonical-route readback.",
    reasons: ["No blocking component or empty quiz projection was found."],
  };
}
