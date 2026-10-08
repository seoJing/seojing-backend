"""Opt-in ephemeral focus worker. No source, key or provider body is logged."""
import os

from decision_providers import JevProvider, JEV_MODEL, ProviderError
from jev_focus_reader import FocusReader, VERSION
from jev_runtime import receive, send


def main():
    try:
        config = receive()
        if (not isinstance(config, dict) or set(config) != {"api_key", "allow_remote", "total_units"}
                or config["allow_remote"] is not True or not isinstance(config["api_key"], str)
                or not 16 <= len(config["api_key"]) <= 1000
                or type(config["total_units"]) is not int or not 1 <= config["total_units"] <= 120):
            raise ValueError("invalid_config")
        os.environ["TYPESAFE_API_KEY"] = config.pop("api_key")
        try:
            reader = FocusReader(JevProvider(True))
        finally:
            os.environ.pop("TYPESAFE_API_KEY", None)
        def reply(value):
            # Optional internal telemetry. Public focus events and metrics stay v1.
            send({**value, "diagnostics": reader.diagnostics})
        send({"ready": {"model": JEV_MODEL, "provider": "typesafe", "execution": "remote",
                        "calibrated_for_readme": False}, "version": VERSION})
        while True:
            message = receive()
            if message is None:
                return 0
            if not isinstance(message, dict) or not isinstance(message.get("id"), str):
                raise ValueError("invalid_input")
            if set(message) == {"id", "finish"} and message["finish"] is True:
                if len(reader.prefix) != config["total_units"] or reader.counters["limited"]:
                    reply({"id": message["id"], "error": "reader_not_complete", "metrics": reader.metrics()})
                    return 1
                reply({"id": message["id"], "snapshot": reader.snapshot(), "metrics": reader.metrics()})
                return 0
            if set(message) != {"id", "input"} or len(reader.prefix) >= config["total_units"]:
                raise ValueError("invalid_input")
            try:
                result = reader.step(message["input"])
                # Capacity limits are visible failures; never a success with
                # silently skipped questions or unsupported absence judgments.
                if reader.counters["limited"]:
                    reply({"id": message["id"], "error": "engine_budget_exceeded", "metrics": reader.metrics()})
                    return 1
                reply({"id": message["id"], "result": result, "metrics": reader.metrics()})
            except ProviderError as error:
                code = "engine_unavailable"
                if str(error) == "jev_timeout":
                    code = "engine_timeout"
                elif str(error) in ("jev_call_budget_exceeded", "focus_request_budget_exceeded"):
                    code = "engine_budget_exceeded"
                elif str(error).startswith("invalid_answer") or str(error) == "jev_model_mismatch":
                    code = "engine_output_invalid"
                reply({"id": message["id"], "error": code, "metrics": reader.metrics()})
                return 1
    except Exception:
        send({"error": "engine_input_invalid"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
