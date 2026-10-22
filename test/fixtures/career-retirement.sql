-- Synthetic production-shaped data, never an export of production content.
INSERT INTO articles (id, slug, title, source_text, updated_at)
VALUES ('10000000-0000-0000-0000-000000000001', 'retained-sentinel', 'Retained article', '# Original MDX', now());
INSERT INTO article_revisions (id, article_id, revision_number, source_format, source_text, document)
VALUES ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 1, 'MDX', '# Original MDX', '{"type":"doc","content":[]}');
UPDATE articles SET current_revision_id = '10000000-0000-0000-0000-000000000002';
INSERT INTO article_blocks (id, article_id, revision_id, type, sort_order, content, updated_at)
VALUES ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'RAW_MDX', 0, '{"source":"# Original MDX"}', now());
INSERT INTO article_assets (id, article_id, revision_id, block_id, kind, url)
VALUES ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', 'COVER', '/sentinel.png');
INSERT INTO users (id, github_id, github_login, updated_at)
VALUES ('10000000-0000-0000-0000-000000000005', 'sentinel', 'sentinel', now());
INSERT INTO article_comments (id, article_id, author_id, body, updated_at)
VALUES ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'Retained comment', now());

CREATE SCHEMA retirement_sentinel;
CREATE TYPE retirement_sentinel.state AS ENUM ('KEEP');
CREATE TABLE retirement_sentinel.records (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  state retirement_sentinel.state NOT NULL,
  payload TEXT NOT NULL
);
INSERT INTO retirement_sentinel.records (state, payload) VALUES ('KEEP', 'untouched');
CREATE VIEW retirement_sentinel.record_view AS SELECT * FROM retirement_sentinel.records;

INSERT INTO career_companies (id, slug, name, updated_at)
VALUES ('20000000-0000-0000-0000-000000000001', 'fixture-company', 'Synthetic company', now());
INSERT INTO career_opportunities (id, company_id, slug, title, employment_type, summary, updated_at)
VALUES ('20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'fixture-opportunity', 'Synthetic opportunity', 'FULL_TIME', 'Fixture only', now());
INSERT INTO career_recruitment_history (id, opportunity_id, key, actual_status, updated_at)
VALUES ('20000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'fixture-history', 'CLOSED', now());
INSERT INTO career_forecasts (id, opportunity_id, predicted_status, confidence, rationale, updated_at)
VALUES ('20000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000002', 'UPCOMING', 'LOW', 'Fixture only', now());
INSERT INTO career_sources (id, key, label, url, retrieved_at, updated_at)
VALUES ('20000000-0000-0000-0000-000000000005', 'fixture-source', 'Synthetic source', 'https://example.invalid', now(), now());
INSERT INTO career_source_links (id, opportunity_id, source_id, recruitment_history_id, relationship)
VALUES ('20000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000003', 'RECRUITMENT_HISTORY');
INSERT INTO career_source_links (id, opportunity_id, source_id, forecast_id, relationship)
VALUES ('20000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000004', 'FORECAST');
