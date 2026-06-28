# MDX ingest/render MVP support

Ticket #163의 의도는 SEOJing 프론트엔드에 있는 MDX를 계속 저작 포맷으로 두되, 본문 런타임을 Cloudflare Worker 번들에 직접 컴파일하지 않는 첫 단계를 만드는 것이다.

## MVP 입력

- `.md` / `.mdx` 원문 문자열 또는 파일
- YAML frontmatter의 단순 `key: value` 형태
- `--content-root` 기준 파일 경로

```bash
pnpm mdx:ingest --content-root ../SEOJing/apps/web/content ../SEOJing/apps/web/content/study/javascript-quizbook/day1.mdx
```

DB에 초안으로 쓰려면 로컬 Postgres와 `DATABASE_URL`을 준비한 뒤 `--write-db`를 붙인다.

```bash
DATABASE_URL='<postgres-url>' pnpm mdx:ingest --write-db --content-root ../SEOJing/apps/web/content ../SEOJing/apps/web/content/study/javascript-quizbook/day1.mdx
```

## 생성 결과

- `slug`
  - frontmatter `slug`가 있으면 우선 사용
  - 없으면 `contentRoot` 기준 파일 경로에서 생성
- `title`
  - frontmatter `title` 우선
  - 없으면 첫 H1
- `description`
  - frontmatter `description` 또는 `summary`
- `toc`
  - Markdown heading에서 `id`, `depth`, `text` 생성
- `renderedHtml`
  - 허용한 Markdown subset만 HTML 태그로 생성
  - 일반 텍스트와 raw HTML은 escape한다
- `blocks`
  - heading, paragraph, image, code, quote, quiz/callout placeholder, raw MDX placeholder
- `assets`
  - Markdown image를 `INLINE_IMAGE` asset 후보로 추출

## 현재 지원 범위

| 입력                      | 처리                                                |
| ------------------------- | --------------------------------------------------- |
| `#`~`######` heading      | TOC + `HEADING` block + sanitized HTML              |
| paragraph                 | `PARAGRAPH` block + escaped HTML                    |
| fenced code block         | `CODE` block + escaped `<pre><code>`                |
| `> quote`                 | `QUOTE` block                                       |
| `![alt](url "title")`     | `IMAGE` block + `INLINE_IMAGE` asset                |
| markdown link             | `http(s)` 또는 `/` URL만 anchor 변환                |
| `import` / `export` line  | 렌더링 대상에서 제외                                |
| `ArticleQuiz`             | `QUIZ` placeholder, structured block 후보로 표시    |
| `Callout`                 | `CALLOUT` placeholder, structured block 후보로 표시 |
| 기타 대문자 JSX component | `RAW_MDX` placeholder                               |

## 의도적으로 아직 안 하는 것

- MDX/React component를 실제 실행하지 않는다. 서버 ingest에서 임의 JSX를 실행하면 보안·번들·런타임 경계가 흐려진다.
- 복잡한 YAML 전체 스펙을 구현하지 않는다. SEOJing frontmatter에서 자주 쓰는 단순 scalar/inline array만 MVP로 본다.
- `ArticleQuizItem` 내부 구조를 완전 파싱하지 않는다. #163에서는 placeholder와 structured block 후보 분리까지만 한다.
- raw HTML을 trust하지 않는다. 이 MVP의 HTML은 allowlist 방식으로 생성한 태그와 escaped text만 담는다.

## 다음 티켓 후보

- 실제 SEOJing content tree batch ingest
- quiz/callout structured block schema 세분화
- public `GET /articles/:slug` 응답에 `toc`, `renderedHtml`, asset metadata 포함
- frontend feature-flag로 backend article body 읽기
