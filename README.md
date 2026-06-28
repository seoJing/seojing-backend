# seojing-backend

SEOJing의 콘텐츠/커뮤니티 백엔드입니다. 첫 목표는 블로그 본문 MDX가 Cloudflare Worker 번들에 계속 누적되는 구조를 끊고, 글/개정/질문/댓글을 다룰 수 있는 공개 포트폴리오형 백엔드로 키우는 것입니다.

## Problem

SEOJing은 지금까지 MDX 파일을 프런트엔드 Worker 번들 안으로 컴파일해 배포했습니다. 글이 늘면서 Worker gzip 업로드가 Cloudflare free-plan 3 MiB 제한 근처까지 커졌고, Day 6 study publish는 `Worker exceeded the size limit of 3 MiB` 오류로 보류되었습니다.

이 저장소는 MDX를 버리기 위한 저장소가 아닙니다. MDX를 authoring/import/export 형식으로 유지하되, 공개 본문 데이터와 커뮤니티 기능은 별도 백엔드가 소유하도록 분리합니다.

## Decision

초기 스택은 다음처럼 잡습니다.

- Fastify + TypeScript
- PostgreSQL
- Prisma
- Zod 기반 환경 변수 검증
- OpenAPI 문서 스켈레톤
- Vitest / ESLint / TypeScript build
- Docker Compose 개발 DB

Cloudflare Worker는 `seojing.com`의 얇은 프런트엔드/캐시/SEO 레이어로 남기고, article body와 revision/community 데이터는 이 백엔드의 API에서 가져오는 방향으로 이동합니다.

## Expected result

첫 번째 성공 기준은 다음입니다.

- 기존 `/blog/...` URL은 유지한다.
- article body를 Worker JS module로 계속 밀어 넣지 않는다.
- Worker gzip upload를 우선 `<= 1800 KiB` 수준으로 낮출 수 있는 길을 만든다.
- 이후 admin writing, block editor, GitHub OAuth comments/questions, Q&A/RAG, TTS를 같은 데이터 모델 위에 확장한다.

## Current scope

이 저장소의 첫 커밋은 skeleton입니다.

- `GET /health`
- `/docs` Swagger UI
- `/openapi.json` OpenAPI JSON
- 환경 변수 스키마
- Prisma/PostgreSQL 연결 기반
- Docker Compose PostgreSQL
- lint/test/build/check scripts

Article/Revision/Block schema와 public article API는 다음 티켓에서 추가합니다.

## Local development

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm prisma:generate
pnpm dev
```

PostgreSQL을 함께 띄울 때:

```bash
docker compose up -d postgres
pnpm prisma:migrate:dev
pnpm dev
```

Health check:

```bash
curl http://localhost:4000/health
```

OpenAPI:

```bash
open http://localhost:4000/docs
curl http://localhost:4000/openapi.json
```

## Verification

```bash
pnpm format:check
pnpm lint
pnpm test
pnpm build
pnpm openapi:check
```

## Roadmap

1. Article/Revision/Block DB schema MVP
2. Worker bundle size budget gate in SEOJing
3. MDX ingest/render pipeline
4. Public Article API and cache contract
5. SEOJing frontend integration behind feature flag
6. Study series migration
7. Admin Writing MVP
8. Block editor foundation
9. GitHub OAuth comments/questions MVP
