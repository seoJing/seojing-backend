# Ops article editor MDX contract

Imported legacy articles remain `MDX` revisions. Their exact `sourceText` is the editable source of truth; saving in `/ops/articles/edit` creates a new private revision. The backend parses that source as MDX data (never executes JSX or JavaScript), generates sanitized preview HTML, structured public blocks, and image assets. A generated block is a rendering projection, not a destructive rewrite to `BLOCKS`.

`GET /admin/articles/:slug/editor` returns `previewRenderedHtml` and `previewIssues` for the latest revision. Unsupported/dynamic syntax remains in `sourceText`, is identified by name and body-relative line, and may be saved privately. `POST /admin/articles/:slug/publish` returns 409 with those issues until they are resolved. It also requires the saved HTML and blocks to match the current parser output; stale imported revisions must be saved as a fresh revision first. The repository pins the expected revision ID during publication to avoid publishing a different concurrent edit.

The public `/articles/:slug` API exposes only the selected published revision. It sanitizes generated inline HTML in blocks before the frontend renders it, and keeps source text private. The frontend's canonical `/blog/...` migration flag and bundled fallback are unchanged. No existing article is bulk-published or switched to the backend by this change.

Before opting a slug into backend public reading, save its current source as a private revision, compare the private preview and structured blocks to the bundled page (headings, text, inline formatting, lists, tables, code, images, quizzes), publish deliberately, then verify the public API and canonical `/blog/...` readback. A clean parser result is necessary but not by itself a visual-parity proof.
