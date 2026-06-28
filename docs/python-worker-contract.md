# SEOJing API 2 — Node/Python internal worker contract

## Status

Accepted for the MVP API 2 boundary.

## Context

SEOJing will add TTS, article Q&A, and RAG features that are easier to run in Python than inside the public Node/Fastify API. The public product boundary should still stay simple:

- public clients call the Node API only;
- the Python process is an internal worker dependency;
- no Python worker port is exposed through Cloudflare Tunnel or a public reverse proxy.

## Decision

Use a localhost-only HTTP worker contract for the MVP.

Alternatives considered:

| Option                 | Decision         | Why                                                                                                                                                         |
| ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subprocess per request | Rejected for MVP | Simple to wire, but slow for TTS/RAG warm state and weak for cancellation/health.                                                                           |
| Queue first            | Deferred         | Better for long-running jobs, but needs persistence, job status, and retries before the feature contract is known.                                          |
| Localhost HTTP worker  | Accepted         | Gives a small health/readiness contract, request cancellation via AbortSignal, and clean route/service tests while keeping the public port surface on Node. |

The default worker URL is `http://127.0.0.1:4037`; `PythonWorkerClient` rejects non-loopback hosts so misconfiguration cannot accidentally point the backend at a public Python URL.

## Runtime contract

### Environment

| Variable                                   | Default                     | Notes                                                                                                      |
| ------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PYTHON_WORKER_ENABLED`                    | `false`                     | Readiness checks include the worker only when enabled.                                                     |
| `PYTHON_WORKER_BASE_URL`                   | `http://127.0.0.1:4037`     | Must be loopback (`127.0.0.1`, `localhost`, or `::1`).                                                     |
| `PYTHON_WORKER_TIMEOUT_MS`                 | `10000`                     | Per-request Node-side timeout.                                                                             |
| `PYTHON_WORKER_RETRY_ATTEMPTS`             | `1`                         | Retry count for idempotent worker health/readiness checks. Task invocation is not retried by default.      |
| `TTS_AUDIO_ROOT` / `SEOJING_TTS_AUDIO_DIR` | `.seojing-worker/tts-audio` | Node will stream only worker-returned audio paths contained under this root. Keep it local and non-public. |

### Worker endpoints expected by Node

#### `GET /health`

Response:

```json
{
  "status": "ok",
  "worker": "seojing-python-worker",
  "version": "0.1.0",
  "capabilities": ["tts", "qa", "rag"]
}
```

`status: "degraded"` is allowed when the process is alive but a capability is unavailable.

#### `POST /v1/tasks/:kind`

`kind` is one of `tts`, `qa`, or `rag`.

Request:

```json
{
  "requestId": "optional-correlation-id",
  "payload": {}
}
```

Response:

```json
{
  "requestId": "optional-correlation-id",
  "result": {}
}
```

### TTS task payload/result

Node owns the public TTS API and job lifecycle. The Python worker owns only local synthesis/cache work behind the loopback boundary.

Public Node endpoints:

- `GET /tts/summary` — summary/counts and defaults, no local paths;
- `POST /tts/jobs` — create a job, returns `202`, supports `idempotency_key` or `Idempotency-Key`;
- `GET /tts/jobs` — list jobs with optional `status` and `limit`;
- `GET /tts/jobs/:jobId` — read status;
- `GET /tts/audio/:jobId` — Node streams generated audio with `Accept-Ranges: bytes`.

Worker request payload for `POST /v1/tasks/tts`:

```json
{
  "requestId": "TTS-abc123",
  "payload": {
    "operation": "synthesize",
    "jobId": "TTS-abc123",
    "text": "Korean narration text",
    "articleId": "optional-article-id",
    "voice": "ko-KR-SunHiNeural",
    "rate": "+0%",
    "metadata": {},
    "idempotencyKey": "optional-client-key"
  }
}
```

Worker response result:

```json
{
  "requestId": "TTS-abc123",
  "result": {
    "audioPath": "/loopback/local/cache/TTS-abc123.mp3",
    "mimeType": "audio/mpeg",
    "byteLength": 12345,
    "durationMs": 1000
  }
}
```

`audioPath` is an internal Node↔Python handoff field only. Public job responses expose `/tts/audio/:jobId`, never local file paths or text. Node resolves `audioPath` and rejects values outside `TTS_AUDIO_ROOT`/`SEOJING_TTS_AUDIO_DIR` before streaming, so a worker bug cannot turn the public audio route into arbitrary file disclosure. Routes convert worker timeouts/errors to stable public TTS job/error states instead of leaking Python stack traces.

### Article Q&A/RAG task payload/result

Node owns the public article, section, question, and session policy. Python receives only the already-selected published article context chunks and returns generation/retrieval output.

Public Node endpoint:

- `POST /articles/:slug/qa` — ask a source-backed question about one published article. Body: `question`, optional `section_id`/`sectionId`, optional opaque `session_id`/`sessionId`.

Node validates:

- the slug resolves to a `PUBLISHED` article through `ArticleService.getPublicArticleBySlug`;
- optional `section_id` exists in the current article revision and scopes context to that heading section;
- question/session identifiers are bounded strings;
- responses expose source excerpts and public slugs only, not local paths, worker URLs, raw stack traces, ops routes, or private data.

Worker request payload for `POST /v1/tasks/qa`:

```json
{
  "requestId": "qa-correlation-id",
  "payload": {
    "article": {
      "slug": "study/js-closure",
      "title": "JavaScript Closure Study",
      "sectionId": "closure"
    },
    "question": "How does closure lexical scope work?",
    "sessionId": "optional-opaque-reader-session",
    "context": [
      {
        "blockId": "p-closure",
        "sectionId": "closure",
        "heading": null,
        "text": "A closure keeps lexical scope after the outer function returns.",
        "excerpt": "A closure keeps lexical scope after the outer function returns.",
        "score": 3
      }
    ]
  }
}
```

Worker response result:

```json
{
  "requestId": "qa-correlation-id",
  "result": {
    "status": "answered",
    "answer": "Source-backed answer text",
    "sources": [
      {
        "articleSlug": "study/js-closure",
        "blockId": "p-closure",
        "sectionId": "closure",
        "heading": null,
        "excerpt": "A closure keeps lexical scope after the outer function returns.",
        "score": 3
      }
    ],
    "related": [
      { "slug": "study/js-closure", "title": "JavaScript Closure Study" }
    ]
  }
}
```

If the worker times out, returns invalid output, or is not configured, Node returns a deterministic source-backed fallback. If no chunk has enough evidence, the public response uses `status: "insufficient_context"` rather than guessing.

The included `workers/seojing_python_worker.py` is the loopback MVP worker. Provision it with `python3 -m pip install -r workers/requirements.txt` inside the worker virtualenv; it uses `edge-tts` for real synthesis and a deterministic source-citation Q&A fallback for the initial QA/RAG contract. It refuses non-loopback binds by default.

## Timeout, retry, and cancellation

- Node wraps worker calls in `AbortSignal.timeout(PYTHON_WORKER_TIMEOUT_MS)`.
- Caller cancellation is composed with the timeout via `AbortSignal.any`.
- Readiness/health can retry transient `timeout`, `unavailable`, and `upstream_error` failures.
- Task invocation is not automatically retried because TTS/RAG side effects may be non-idempotent until a future job model exists.

## Error mapping

`PythonWorkerClient` maps worker failures to stable internal codes:

| Code             | Meaning                                               |
| ---------------- | ----------------------------------------------------- |
| `invalid_config` | Worker URL is not loopback or protocol is invalid.    |
| `timeout`        | Node-side timeout expired.                            |
| `cancelled`      | Upstream caller cancelled the request.                |
| `unavailable`    | Fetch/network failed.                                 |
| `upstream_error` | Worker returned 5xx.                                  |
| `bad_response`   | Worker returned non-2xx client error or invalid JSON. |

Routes should convert these codes into public API errors per feature surface rather than leaking Python stack traces.

## Logging and redaction

- Send correlation through `x-request-id` when available.
- Log worker status/error code and request id, not full prompts, article text, generated audio bytes, API keys, local file paths, or OAuth/session secrets.
- Python worker logs should follow the same rule: structured metadata is okay; content payloads are redacted by default.

## Readiness

`GET /health` remains the lightweight Node process health check.

`GET /health/ready` reports dependency readiness:

- worker disabled: `200`, `pythonWorker.status = "not_configured"`, `required = false`;
- worker enabled and healthy: `200`, status/capabilities from worker;
- worker enabled and degraded: `200`, top-level `status = "degraded"`, status/capabilities from worker;
- worker enabled and failing: `503`, `pythonWorker.status = "unavailable"`.

## Operations rule

Only the Node/Fastify API should be exposed through Cloudflare Tunnel or public routing. The Python worker listens on loopback only. If TTS/Q&A/RAG later need long-running async jobs, add a queue/job-status layer behind Node rather than exposing Python directly.
