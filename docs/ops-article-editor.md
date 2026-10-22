# Ops article editor MDX contract

Imported legacy articles remain `MDX` revisions. Their exact `sourceText` is the editable source of truth; saving in `/ops/articles/edit` creates a new private revision. The backend parses that source as MDX data (never executes JSX or JavaScript), generates sanitized preview HTML, structured public blocks, and image assets. A generated block is a rendering projection, not a destructive rewrite to `BLOCKS`.

`GET /admin/articles/:slug/editor` returns `previewRenderedHtml` and `previewIssues` for the latest revision. Unsupported/dynamic syntax remains in `sourceText`, is identified by name and body-relative line, and may be saved privately. `POST /admin/articles/:slug/publish` returns 409 with those issues until they are resolved. It also requires the saved HTML and blocks to match the current parser output; stale imported revisions must be saved as a fresh revision first. The repository pins the expected revision ID during publication to avoid publishing a different concurrent edit.

The public `/articles/:slug` API exposes only the selected published revision. It sanitizes generated inline HTML in blocks before the frontend renders it, and keeps source text private. The frontend's canonical `/blog/...` migration flag and bundled fallback are unchanged. No existing article is bulk-published or switched to the backend by this change.

Before opting a slug into backend public reading, save its current source as a private revision, compare the private preview and structured blocks to the bundled page (headings, text, inline formatting, lists, tables, code, images, quizzes), publish deliberately, then verify the public API and canonical `/blog/...` readback. A clean parser result is necessary but not by itself a visual-parity proof.

## Bounded bulk visibility

`POST /admin/articles/bulk-visibility` requires the existing admin bearer token.

```json
{
  "action": "unpublish",
  "slugs": ["study/topic/day1", "study/topic/day2"],
  "scope": { "category": "Study", "status": "PUBLISHED", "query": "study/" }
}
```

`action` is `publish` or `unpublish`. `slugs` is a unique, nonempty array of at most 20 explicit canonical identifiers, each at most 240 characters. There is no implicit select-all. Scope can intersect category, status, source format (`format`) and case-insensitive title/slug/category search (`query`). Every item is checked against current state and its subsequent write is conditional on that state's `updatedAt`, so a concurrent change yields a failed item rather than overriding it.

A valid batch responds HTTP 200 with `{ ok, results }`. Each result includes `slug`, `ok`, and either the resulting `status` (plus the public article payload for publish) or an `error`. Successful items stay committed if another item fails. Publishing uses the existing per-article PostgreSQL transaction; unpublishing is a single conditional SQL update. A batch is not one global transaction.

The frontend ops proxy coordinates the D1 public snapshot. This backend endpoint alone does not update Cloudflare. The proxy reports D1 sync failures explicitly and offers authenticated reconciliation; an uncertain unpublish response must never resurrect an old D1 snapshot. Public/private readback must be checked before reporting end-to-end success.

### Disposable integration gate

After creating and migrating a new **loopback-only** database named `cms_test_*`, run `RUN_BULK_DB_TESTS=true pnpm exec vitest run test/bulk-visibility-db.test.ts` with its local `DATABASE_URL`. The test rejects non-loopback and other database names before writes, injects a SQL trigger failure to exercise rollback, and cleans up its own fixtures. Never point this command at a production database. PostgreSQL startup is blocked by the current sandbox's shared-memory permission, so this gate is not yet executed.

No MDX source/revision retention or production database changes accompany the bulk API.

## Public preview boundary

`GET /admin/articles/:slug/editor` now returns `article.preview`, the latest saved revision projected through the exact `toPublicArticleDetail` used by public GET and D1 snapshots. Raw `article.blocks` remain lossless editing data and must never be sent to a public HTML renderer. Legacy `previewRenderedHtml` is not the rendering contract.

`POST /admin/articles/preview` accepts an explicit slug and current draft fields (title, description/category, document or blocks, and document metadata). It requires the existing admin bearer boundary, limits the body to 512 KiB and block lists to 1,000 entries, reads the latest source format, and uses the same document/block validators and renderers as save. Invalid content returns 400, missing articles 404, oversized requests 413. Success returns `{ preview: <public article projection> }` with `Cache-Control: private, no-store`. It never saves a revision, changes visibility or writes a D1 snapshot. Projected `status` describes public presentation, not persisted publication status.

The frontend Access-protected proxy forwards only these draft fields, keeps the bearer credential server-side, and does not synchronize public storage for preview requests. Saved and unsaved previews both use the public content adapter, including canonical reading-time input. Hostile inline HTML/event-attribute tests compare editor preview with the actual sanitized public route payload. Independent correction review remains pending; MDX retirement is prohibited until ACCEPT.
