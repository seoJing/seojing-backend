"""Ephemeral opt-in JSONL worker. Credentials arrive only via protected stdin."""
import os
from decision_providers import JevProvider, JEV_MODEL, ProviderError
from jev_situation_reader import SituationReader, VERSION
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
            reader = SituationReader(JevProvider(True))
        finally:
            os.environ.pop("TYPESAFE_API_KEY", None)
        def reply(value):
            send({**value, "metrics": reader.metrics(), "diagnostics": reader.counters()})
        send({"ready": {"model": JEV_MODEL, "provider": "typesafe", "execution": "remote",
                        "calibrated_for_readme": False}, "version": VERSION})
        while True:
            message = receive()
            if message is None:
                return 0
            if not isinstance(message, dict) or not isinstance(message.get("id"), str):
                raise ValueError("invalid_input")
            if set(message) == {"id", "finish"} and message["finish"] is True:
                try:
                    result = reader.finish(config["total_units"])
                except ValueError:
                    reply({"id": message["id"], "error": "reader_not_complete"})
                    return 1
                reply({"id": message["id"], "result": result})
                return 0
            if set(message) != {"id", "input"} or len(reader.prefix) >= config["total_units"]:
                raise ValueError("invalid_input")
            try:
                result = reader.step(message["input"])
                reply({"id": message["id"], "result": result})
            except ProviderError as error:
                code = "engine_unavailable"
                if str(error) == "jev_timeout":
                    code = "engine_timeout"
                elif str(error) in ("jev_call_budget_exceeded", "focus_request_budget_exceeded", "situation_budget_exceeded"):
                    code = "engine_budget_exceeded"
                elif str(error).startswith("invalid_answer") or str(error) == "jev_model_mismatch":
                    code = "engine_output_invalid"
                reply({"id": message["id"], "error": code})
                return 1
    except Exception:
        send({"error": "engine_input_invalid"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
