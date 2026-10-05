"""Ephemeral JSONL worker. Secrets enter over stdin, never argv or stdout."""
import json
import os
import sys

from decision_providers import JevProvider, JEV_MODEL, ProviderError
from jev_reader import JevReader

MAX_LINE = 1_000_000


def receive():
    raw = sys.stdin.buffer.readline(MAX_LINE + 1)
    if not raw:
        return None
    if len(raw) > MAX_LINE or not raw.endswith(b"\n"):
        raise ValueError("engine_input_invalid")
    return json.loads(raw)


def send(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    try:
        config = receive()
        if (not isinstance(config, dict) or set(config) not in (
                    {"api_key", "allow_remote"}, {"api_key", "allow_remote", "reassessment"})
                or config["allow_remote"] is not True or not isinstance(config["api_key"], str)
                or not 16 <= len(config["api_key"]) <= 1000
                or type(config.get("reassessment", False)) is not bool):
            raise ValueError("invalid_config")
        os.environ["TYPESAFE_API_KEY"] = config.pop("api_key")
        try:
            provider = JevProvider(True)
        finally:
            os.environ.pop("TYPESAFE_API_KEY", None)
        def reassess(question_id, current_unit_id):
            nonce = f"r{reader.reassessment_count}"
            send({"id": message["id"], "reassessment": {"nonce": nonce,
                "question_id": question_id, "current_unit_id": current_unit_id}})
            response = receive()
            if (not isinstance(response, dict) or set(response) != {"id", "nonce", "reassessment_result"}
                    or response["id"] != message["id"] or response["nonce"] != nonce
                    or (response["reassessment_result"] is not None and not isinstance(response["reassessment_result"], dict))):
                raise ValueError("invalid_reassessment_response")
            return response["reassessment_result"]

        reader = JevReader(provider)
        if config.get("reassessment", False):
            reader.reassess = reassess
        diagnostic_cursor = 0
        send({"ready": {"model": JEV_MODEL, "provider": "typesafe", "execution": "remote",
                        "calibrated_for_readme": False}})
        while True:
            message = receive()
            if message is None:
                return 0
            if not isinstance(message, dict) or set(message) != {"id", "input"} or not isinstance(message["id"], str):
                raise ValueError("invalid_input")
            try:
                result = reader.step(message["input"])
                retries = reader.provider.failures[diagnostic_cursor:]
                diagnostic_cursor = len(reader.provider.failures)
                send({"id": message["id"], "result": result, "metrics": reader.metrics(), "diagnostics": reader.diagnostics, "retries": retries})
            except ProviderError as error:
                code = "engine_timeout" if str(error) == "jev_timeout" else "engine_unavailable"
                if str(error) == "jev_call_budget_exceeded":
                    code = "engine_budget_exceeded"
                if str(error).startswith("invalid_answer") or str(error) == "jev_model_mismatch":
                    code = "engine_output_invalid"
                # ProviderError messages originate only from fixed local codes;
                # never attach HTTP bodies, headers, source or exceptions.
                send({"id": message["id"], "error": code, "diagnostic_code": str(error), "metrics": reader.metrics(), "diagnostics": reader.diagnostics,
                      **({"retries": reader.provider.failures[diagnostic_cursor:]} if reader.provider.failures[diagnostic_cursor:] else {})})
                return 1
    except Exception:
        # Never serialize exceptions: they can contain input or provider secrets.
        send({"error": "engine_input_invalid"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
