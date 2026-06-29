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

기존 article을 갱신하면서 현재 revision까지 발행하려면 `--publish`를 함께 붙인다. `--publish`는 DB 상태를 바꾸므로 `--write-db`와 같이 써야 한다.

```bash
DATABASE_URL='<postgres-url>' pnpm mdx:ingest --write-db --publish --content-root ../SEOJing/apps/web/content ../SEOJing/apps/web/content/study/javascript-quizbook/day6.mdx
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
  - heading, paragraph, image, code, quote
  - code fence는 `language`, `meta`, `code`를 분리해 `CODE` block에 보존
  - quiz/callout/기타 JSX는 실행하지 않고 `rawMdx`, `props`, `renderHint`, `strategy`를 가진 structured candidate/placeholder block으로 보존
- `assets`
  - Markdown image를 `INLINE_IMAGE` asset 후보로 추출

## 현재 지원 범위

| 입력                      | 처리                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `#`~`######` heading      | TOC + `HEADING` block + sanitized HTML                                                                |
| paragraph                 | `PARAGRAPH` block + escaped HTML                                                                      |
| unordered/ordered list    | `PARAGRAPH` block + `<ul>`/`<ol>` HTML                                                                |
| markdown table            | `PARAGRAPH` block + `<table>` HTML                                                                    |
| fenced code block         | `CODE` block + escaped `<pre><code>`; info string을 `language`/`meta`로 보존                          |
| `> quote`                 | `QUOTE` block                                                                                         |
| `![alt](url "title")`     | `IMAGE` block + `INLINE_IMAGE` asset                                                                  |
| markdown link             | `http(s)` 또는 `/` URL만 anchor 변환                                                                  |
| `import` / `export` line  | 렌더링 대상에서 제외                                                                                  |
| `ArticleQuiz`             | `QUIZ` block 후보. `props`, `rawMdx`, `ArticleQuizItem` props 배열 보존; 본문 placeholder HTML은 생략 |
| `Callout`                 | `CALLOUT` block 후보. `props`, `bodyText`, `rawMdx` 보존 + sanitized fallback `<aside>`               |
| 기타 대문자 JSX component | `RAW_MDX` placeholder. `props`와 `rawMdx` 보존                                                        |

## 의도적으로 아직 안 하는 것

- MDX/React component를 실제 실행하지 않는다. 서버 ingest에서 임의 JSX를 실행하면 보안·번들·런타임 경계가 흐려진다.
- 복잡한 YAML 전체 스펙을 구현하지 않는다. SEOJing frontmatter에서 자주 쓰는 단순 scalar/inline array만 MVP로 본다.
- `ArticleQuizItem`의 중첩 children/복잡한 expression을 완전 실행·평가하지 않는다. 단순 props와 원문 `rawMdx`를 보존해 프론트엔드 렌더러가 재해석할 수 있는 최소 계약까지만 제공한다.
- raw HTML을 trust하지 않는다. 이 MVP의 HTML은 allowlist 방식으로 생성한 태그와 escaped text만 담는다.

## 다음 티켓 후보

- 실제 SEOJing content tree batch ingest
- quiz/callout structured block schema 세분화
- public `GET /articles/:slug` 응답에 `toc`, `renderedHtml`, asset metadata 포함
- frontend feature-flag로 backend article body 읽기
