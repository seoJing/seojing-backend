# Study article migration audit

Run this before moving an existing JavaScript Quizbook or Effective TypeScript
MDX article to the backend article API. It is read-only: it compares the MDX
dry-run projection with the current article DB state and prints JSON.

```bash
# Source-only projection check; pass the separate SEOJing content checkout.
pnpm study:migration-audit --content-root ../SEOJing/apps/web/content --no-db

# An isolated worktree can use an absolute path or SEOJING_CONTENT_ROOT.
SEOJING_CONTENT_ROOT=/absolute/path/to/SEOJing/apps/web/content \
  pnpm study:migration-audit --no-db

# Read the current article DB through a supplied DATABASE_URL.
DATABASE_URL='<connection-url>' \
  pnpm study:migration-audit --content-root ../SEOJing/apps/web/content
```

The audit classifies every Day article as one of:

- `ready-for-ingest`: no unsupported component or empty projected quiz items;
  ingest one slug at a time, publish, then read back API and canonical routes.
- `already-projected`: published DB revision exists; perform public readback,
  not another blind import.
- `needs-existing-article-review`: a DRAFT or ARCHIVED DB article already
  exists; review its revision/status before importing or publishing anything.
- `needs-quiz-projection`: an `ArticleQuiz` has no nested items, so do not
  publish the broken projection.
- `needs-component-parity`: a component outside the supported structured set
  (`ArticleQuiz`, `ArticleQuizItem`, `Callout`) needs renderer work first.

The audit is deliberately not a bulk-ingest command. MDX remains the source of
truth while each slug passes DB/API/canonical-route evidence.
