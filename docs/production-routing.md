# Production routing: api.seojing.com

Ticket #172 switched the public SEOJing API boundary from the old OkayJing sidecar to this `seojing-backend` service.

## Runtime contract

The Mac mini uses these user launchd agents (all in `~/Library/LaunchAgents`):

| Label                      | Process                                                                                                                                                    | Local boundary        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `com.seojing.postgres`     | PostgreSQL 16 using `/Users/seojing/Projects/seojing-backend/.local/postgres-data`                                                                         | `127.0.0.1:5432`      |
| `com.seojing.backend`      | compiled Node service from `/Users/seojing/Projects/seojing-backend/dist/src/server.js`, using the app-owned Node binary at `.local/runtime/node-v24.19.0` | `127.0.0.1:4027`      |
| `com.okayjing.cloudflared` | `cloudflared` using `~/.cloudflared/config.yml`                                                                                                            | public Tunnel ingress |

The canonical checkout is `/Users/seojing/Projects/seojing-backend`; the old `.hermes` working directory no longer exists. The backend uses `seojing_backend` in the existing local PostgreSQL cluster and publishes through `https://api.seojing.com`. The plist files are mode `0600`; keep runtime credentials out of this document and the repository. As restored on 2026-09-29, only the public content API environment was recovered; optional admin-token, GitHub OAuth, and Python-worker integrations were not re-enabled.

Before replacing the compiled server, verify the intended source commit and build it. The restored 2026-09-29 checkout lacked a `packages` entry in `pnpm-workspace.yaml`; the README development branch adds it so the package-owned `pnpm build` command can run again. Do not use a build from an unreviewed branch as a silent production upgrade.

The old `com.seojing.api` FastAPI sidecar on `127.0.0.1:9101` is retired. SEOJing public routes (`/articles`, `/community`, `/tts`, `/article-qa`, `/docs`, `/openapi.json`) are owned by this Node service. Any remaining Python process must be treated as an internal worker dependency only; it must not be the public API boundary and must not be routed by Cloudflare Tunnel.

## Boundary matrix

| Host / port                                      | Owner                          | Allowed responsibility                                                        | Must not expose                                                                        |
| ------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `https://api.seojing.com` → `127.0.0.1:4027`     | `seojing-backend` Node service | SEOJing public content/community/TTS/Q&A API                                  | OkayJing habitat, ticket, session, worker, or ops endpoints                            |
| `https://ops-api.seojing.com` → `127.0.0.1:9100` | OkayJing 서식지 / Ops FastAPI  | private OkayJing control-plane and habitat endpoints behind Cloudflare Access | SEOJing public article/community/TTS API                                               |
| Python worker / retired sidecar ports            | internal only                  | loopback-only worker dependency for long-running generation/RAG tasks         | public HTTP API routing, Cloudflare Tunnel ingress, or unauthenticated direct exposure |

## Cloudflare Tunnel ingress

`~/.cloudflared/config.yml` should route:

```yaml
ingress:
  - hostname: api.seojing.com
    service: http://127.0.0.1:4027
  - hostname: ops-api.seojing.com
    service: http://127.0.0.1:9100
  - service: http_status:404
```

`ops-api.seojing.com` remains the private OkayJing Ops API and should stay behind Cloudflare Access.

## Verification

Run these after any deploy or service restart:

```bash
curl -fsS http://127.0.0.1:4027/health
curl -fsS https://api.seojing.com/health
curl -sS -o /dev/null -w '%{http_code}\n' 'https://api.seojing.com/articles/study%2Fjavascript-quizbook%2Fday10'
curl -sS -o /dev/null -w '%{http_code}\n' 'https://api.seojing.com/articles/study%2Feffective-typescript%2Fday5'
curl -sS -o /tmp/ops-api-check.txt -w '%{http_code} %{redirect_url}\n' https://ops-api.seojing.com/health
cd /Users/seojing/Projects/SEOJing/apps/web && node scripts/check-public-blog-readback.mjs
```

Expected:

- `/health` returns 200 locally and through `api.seojing.com`.
- The bundled-MDX slug returns API 404; the Day 5 backend-migrated slug returns API 200 with `PUBLISHED` and a block array.
- `ops-api.seojing.com` is still protected by Cloudflare Access (usually a 302 to Access login for unauthenticated probes) or otherwise unchanged from its pre-deploy behavior.
- The public-blog readback passes. A frontend HTML 200 alone does not prove that the backend API is healthy.

## Recovery and rollback

Inspect the agents before changing them:

```bash
for label in com.seojing.postgres com.seojing.backend com.okayjing.cloudflared; do
  launchctl print "gui/$(id -u)/$label" | grep -E 'state =|pid =|last exit code'
done
```

For a failed new backend build, restore the last verified compiled artifact or commit before restarting `com.seojing.backend`; do not route `api.seojing.com` to the retired FastAPI sidecar at port 9101. The frontend has bundled-MDX fallback for public reading, but the backend API and readback gate must be reported as unavailable until verified again. The preserved PostgreSQL backups are in `.seojing-backups/postgres/`; a cold cluster backup was taken before the 2026-09-29 restart.
