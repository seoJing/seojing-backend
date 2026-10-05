"""Synthetic current-unit trigger diagnostic, not an end-to-end reader score."""
import argparse
import json
from pathlib import Path
import time

from decision_providers import JevProvider
from jev_reader import JevReader
from runtime import digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--allow-remote", action="store_true")
    args = parser.parse_args()
    fixture = json.loads(args.data.read_text())
    if (fixture.get("synthetic") is not True or fixture.get("human_reviewed") is not False
            or fixture.get("label_status") != "provisional_agent_authored"
            or not 1 <= len(fixture["cases"]) <= 20):
        raise ValueError("synthetic_provisional_only")
    job = {"requirements": [{"id": "r1", "kind": "duty", "label": "프로그램 운영과 문의 응대", "quote": "프로그램 운영과 문의 응대"}],
           "reader_profile": {"criteria": [{"id": "c_r1", "requirement_id": "r1", "label": "프로그램 운영과 문의 응대",
               "checks": [{"facet": "basis", "trigger": "프로그램 성과나 응대 결과의 개선을 주장할 때",
                           "sufficient": "같은 지표의 전후 값과 조사 대상, 비교 기간, 측정 방법이 설명됨",
                           "insufficient": "개선 주장만 있고 비교 기준이 설명되지 않음"}]}]}}
    args.out.mkdir(parents=True, exist_ok=False)
    source = args.out / "source"
    source.mkdir()
    hashes = {}
    for name in ("jev_trigger_eval.py", "jev_reader.py", "jev_grounded.py", "atomic_decisions.py", "decision_providers.py", "runtime.py"):
        path = Path(__file__).with_name(name)
        (source / name).write_bytes(path.read_bytes())
        hashes[name] = digest(path)
    save = lambda name, value: (args.out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    save("freeze.json", {"fixture": fixture, "job": job, "source_sha256": hashes})
    provider = JevProvider(args.allow_remote)
    rows, calls, tokens = [], [], 0
    class Recording:
        def ask(self, state, questions):
            response = provider.ask(state, questions)
            calls.append({"state": state, "questions": questions, **response})
            return response
    started = time.monotonic()
    for case in fixture["cases"]:
        units = [{"id": f"u{i+1}", "text": text, "order": i, "scope_id": "s1"} for i, text in enumerate(case["prefix"])]
        reader = JevReader(Recording())
        # Isolate this current-unit trigger with already-read context, no earlier
        # questions. This intentionally is not a complete stream simulation.
        reader.prefix = units[:-1]
        result = reader.step({"prefix": units, "job": job, "questions": []})
        row = {"id": case["id"], "expected_question": case["expected_question"], "opened": bool(result["questions"]), "result": result, "usage": reader.metrics()}
        rows.append(row)
        tokens += row["usage"]["input_tokens"]
        print(json.dumps({"id": row["id"], "opened": row["opened"], "matches": row["opened"] == row["expected_question"]}), flush=True)
        save("calls.json", calls)
        save("rows.json", rows)
    save("summary.json", {"synthetic": True, "human_reviewed": False, "production_approved": False,
                          "matched": sum(r["opened"] == r["expected_question"] for r in rows), "total": len(rows),
                          "calls": len(calls), "input_tokens": tokens, "elapsed_ms": round((time.monotonic()-started)*1000)})


if __name__ == "__main__":
    main()
