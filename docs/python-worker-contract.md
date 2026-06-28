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

| Variable                       | Default                 | Notes                                                                                                 |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `PYTHON_WORKER_ENABLED`        | `false`                 | Readiness checks include the worker only when enabled.                                                |
| `PYTHON_WORKER_BASE_URL`       | `http://127.0.0.1:4037` | Must be loopback (`127.0.0.1`, `localhost`, or `::1`).                                                |
| `PYTHON_WORKER_TIMEOUT_MS`     | `10000`                 | Per-request Node-side timeout.                                                                        |
| `PYTHON_WORKER_RETRY_ATTEMPTS` | `1`                     | Retry count for idempotent worker health/readiness checks. Task invocation is not retried by default. |

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

The concrete payload/result schemas should be added per feature ticket. This ticket intentionally only creates the common transport, timeout, cancellation, and error boundary.

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
