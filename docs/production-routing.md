# Production routing: api.seojing.com

Ticket #172 switched the public SEOJing API boundary from the old OkayJing sidecar to this `seojing-backend` service.

## Runtime contract

- launchd label: `com.seojing.backend`
- working directory: `/Users/seojing/.hermes/workspace/projects/seojing-backend`
- command: `pnpm start`
- host/port: `127.0.0.1:4027`
- database: local PostgreSQL database `seojing_backend`
- public hostname: `https://api.seojing.com`

The old `com.seojing.api` sidecar may still exist locally on `127.0.0.1:9101`, but Cloudflare Tunnel must not route `api.seojing.com` to it.

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

Run these after any deploy or rollback:

```bash
curl -fsS http://127.0.0.1:4027/health
curl -fsS https://api.seojing.com/health
curl -fsS 'https://api.seojing.com/articles/study%2Fjavascript-quizbook%2Fday6'
curl -fsS 'https://api.seojing.com/articles/study%2Feffective-typescript%2Fday6'
curl -sS -o /tmp/ops-api-check.txt -w '%{http_code} %{redirect_url}\n' https://ops-api.seojing.com/health
```

Expected:

- `/health` returns 200 locally and through `api.seojing.com`.
- Both encoded article slugs return 200 and a JSON article body.
- `ops-api.seojing.com` is still protected by Cloudflare Access (usually a 302 to Access login for unauthenticated probes) or otherwise unchanged from its pre-deploy behavior.

## Rollback

1. Restore `~/.cloudflared/config.yml` so `api.seojing.com` points back to `http://127.0.0.1:9101`.
2. Reload Cloudflare Tunnel:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.okayjing.cloudflared
   ```

3. If needed, stop the backend service:

   ```bash
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.seojing.backend.plist
   ```

4. Verify `https://api.seojing.com/health` and `https://ops-api.seojing.com/health` again.
