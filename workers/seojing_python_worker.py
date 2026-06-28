#!/usr/bin/env python3
"""Loopback-only SEOJing Python worker for TTS MVP.

Run locally with:
  SEOJING_PYTHON_WORKER_HOST=127.0.0.1 SEOJING_PYTHON_WORKER_PORT=4037 python3 workers/seojing_python_worker.py

The public API must remain the Node/Fastify process. This worker intentionally binds to
loopback by default and implements only the internal `/health` and `/v1/tasks/tts`
contract consumed by `PythonWorkerClient`.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4037
DEFAULT_VOICE = "ko-KR-SunHiNeural"
DEFAULT_RATE = "+0%"
MAX_TEXT_CHARS = 5000
AUDIO_DIR = Path(os.environ.get("SEOJING_TTS_AUDIO_DIR", ".seojing-worker/tts-audio"))


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def safe_job_id(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]", "-", value.strip())
    return normalized[:80] or "tts-job"


async def synthesize_with_edge_tts(text: str, audio_path: Path, voice: str, rate: str) -> None:
    try:
        import edge_tts  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "edge_tts is required for real TTS synthesis; install it in the worker venv"
        ) from exc

    communicate = edge_tts.Communicate(text, voice=voice, rate=rate)
    await communicate.save(str(audio_path))


def synthesize_tts(payload: dict[str, Any]) -> dict[str, Any]:
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("payload.text is required")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(f"payload.text must be <= {MAX_TEXT_CHARS} characters")

    job_id = safe_job_id(str(payload.get("jobId") or "tts-job"))
    voice = str(payload.get("voice") or DEFAULT_VOICE)
    rate = str(payload.get("rate") or DEFAULT_RATE)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    audio_path = AUDIO_DIR / f"{job_id}.mp3"

    asyncio.run(synthesize_with_edge_tts(text, audio_path, voice, rate))
    return {
        "audioPath": str(audio_path.resolve()),
        "mimeType": "audio/mpeg",
        "byteLength": audio_path.stat().st_size,
    }


class WorkerHandler(BaseHTTPRequestHandler):
    server_version = "SEOJingPythonWorker/0.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib API
        # Keep logs metadata-only; never log full TTS text/payload content.
        print(f"{self.address_string()} - {format % args}")

    def do_GET(self) -> None:  # noqa: N802 - stdlib API
        if self.path == "/health":
            json_response(
                self,
                200,
                {
                    "status": "ok",
                    "worker": "seojing-python-worker",
                    "version": "0.1.0",
                    "capabilities": ["tts"],
                },
            )
            return
        json_response(self, 404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib API
        if self.path != "/v1/tasks/tts":
            json_response(self, 404, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            payload = body.get("payload")
            if not isinstance(payload, dict):
                raise ValueError("payload object is required")
            if payload.get("operation") != "synthesize":
                raise ValueError("only operation=synthesize is supported")
            result = synthesize_tts(payload)
        except ValueError as exc:
            json_response(self, 400, {"error": "bad_request", "message": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001 - converted to internal worker error
            json_response(
                self,
                500,
                {
                    "error": "tts_synthesis_failed",
                    "message": f"{type(exc).__name__}: {exc}",
                },
            )
            return

        json_response(
            self,
            200,
            {"requestId": body.get("requestId"), "result": result},
        )


def main() -> None:
    host = os.environ.get("SEOJING_PYTHON_WORKER_HOST", DEFAULT_HOST)
    port = int(os.environ.get("SEOJING_PYTHON_WORKER_PORT", str(DEFAULT_PORT)))
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Refusing to bind Python worker to a non-loopback host")
    server = ThreadingHTTPServer((host, port), WorkerHandler)
    print(f"seojing-python-worker listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
