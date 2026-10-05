"""Providers for synthetic offline decisions; no fallback or service activation."""
import contextlib
import json
import math
import os
import socket
import sys
import time
import urllib.error
import urllib.request

from runtime import encode_checked, load_agent

JEV_MODEL = "jev-1.13.0"
JEV_URL = "https://api.typesafe.ai/v1/systemone"


class ProviderError(Exception):
    """Message must be a fixed public code, never the raw provider exception."""

    def __init__(self, code, usage=None):
        super().__init__(code)
        self.usage = usage


def normalize(payload, questions, provider):
    if not isinstance(payload, dict):
        raise ProviderError("invalid_answer")
    answers = payload.get("answers")
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise ProviderError("invalid_answer_keys")
    result = {}
    for key, question in questions.items():
        answer = answers[key]
        if not isinstance(answer, dict):
            raise ProviderError("invalid_answer")
        label = answer.get("choice")
        probabilities = answer.get("probabilities")
        confidence = answer.get("confidence" if provider == "jev" else "answer_confidence")
        # Fixed codes distinguish provider failures without exposing raw payloads
        # or credentials. All validation remains fail-closed; no automatic retry.
        if not isinstance(label, str) or label not in question["criteria"]:
            raise ProviderError("invalid_answer_distribution_label")
        if not isinstance(probabilities, dict) or set(probabilities) != set(question["criteria"]):
            raise ProviderError("invalid_answer_distribution_keys")
        if not valid_probability(confidence) or not all(valid_probability(p) for p in probabilities.values()):
            raise ProviderError("invalid_answer_distribution_values")
        if abs(sum(probabilities.values()) - 1) > 0.02:
            raise ProviderError("invalid_answer_distribution_sum")
        if probabilities[label] + 1e-5 < max(probabilities.values()):
            raise ProviderError("invalid_answer_distribution_argmax")
        if provider == "jev" and answer.get("type") != "choice":
            raise ProviderError("invalid_answer_type")
        result[key] = {"label": label, "confidence": confidence,
                       "probabilities": probabilities}
    return result


def valid_probability(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and 0 <= value <= 1)


class LayaProvider:
    def __init__(self, model):
        started = time.monotonic()
        self.agent, self.metadata = load_agent(model.resolve())
        self.metadata = {**self.metadata, "provider": "laya",
                         "load_ms": round((time.monotonic() - started) * 1000)}

    def ask(self, state, questions):
        started = time.monotonic()
        try:
            items = encode_checked(self.agent, state, questions, strict_head=True)
            with contextlib.redirect_stdout(sys.stderr):
                raw = self.agent.predict(state, questions, lang="ko", max_len=1024, head_max_len=256)
            answers = normalize(raw, questions, "laya")
        except ProviderError:
            raise
        except ValueError:
            raise ProviderError("laya_input_or_context_invalid") from None
        except Exception:
            raise ProviderError("laya_inference_failed") from None
        return {"answers": answers, "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                "model": self.metadata["revision"], "question_count": len(questions),
                "encoded_lengths": [len(item["ids"]) for item in items],
                "usage": None}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProviderError("jev_redirect_rejected")


class JevProvider:
    def __init__(self, allow_remote=False):
        if not allow_remote:
            raise ProviderError("jev_requires_explicit_remote_flag")
        self.key = os.environ.get("TYPESAFE_API_KEY")
        if not self.key:
            raise ProviderError("jev_key_missing")
        # Fixed HTTPS origin and no redirects: never forward the key elsewhere.
        self.opener = urllib.request.build_opener(NoRedirect())
        self.metadata = {"provider": "jev", "requested_model": JEV_MODEL,
                         "load_ms": 0, "input_usd_per_million": 0.042,
                         "price_source": "https://docs.typesafe.ai/models",
                         "price_checked": "2026-10-04", "automatic_retries": 0}

    def ask(self, state, questions):
        started = time.monotonic()
        validated_usage = None
        body = json.dumps({"state": state, "questions": questions, "model": JEV_MODEL},
                          ensure_ascii=False).encode()
        try:
            request = urllib.request.Request(JEV_URL, data=body, method="POST", headers={
                "Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise ProviderError("jev_response_too_large")
                payload = json.loads(raw)
            if not isinstance(payload, dict) or payload.get("model") != JEV_MODEL:
                raise ProviderError("jev_model_mismatch")
            usage = payload.get("usage")
            if (not isinstance(usage, dict) or any(type(usage.get(k)) is not int or usage[k] < 0
                    for k in ("input_tokens", "output_tokens"))):
                raise ProviderError("jev_usage_missing")
            validated_usage = {k: usage[k] for k in ("input_tokens", "output_tokens")}
            answers = normalize(payload, questions, "jev")
        except ProviderError as error:
            error.usage = validated_usage
            raise
        except urllib.error.HTTPError as error:
            raise ProviderError("jev_http_" + str(error.code)) from None
        except (TimeoutError, socket.timeout):
            raise ProviderError("jev_timeout") from None
        except Exception:
            raise ProviderError("jev_request_or_response_failed", validated_usage) from None
        # Allowlist only. Headers, provider errors and arbitrary payloads are not logged.
        return {"answers": answers, "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                "model": payload["model"], "question_count": len(questions),
                "usage": {k: usage[k] for k in ("input_tokens", "output_tokens")}}
