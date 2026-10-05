"""Frozen synthetic evaluation of source-linked Jev; not a production endpoint."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from atomic_decisions import state_for
from decision_eval import save, percentile
from decision_providers import JevProvider, ProviderError
from jev_grounded import GroundedJev, VERSION, DECISION_THRESHOLDS
from runtime import digest


def load(path):
    data = json.loads(path.read_text())
    if (data.get("synthetic") is not True or data.get("human_reviewed") is not False
            or data.get("label_status") != "provisional_agent_authored"):
        raise ValueError("synthetic_provisional_only")
    cases = data["cases"]
    if not 1 <= len(cases) <= 100 or len({c["id"] for c in cases}) != len(cases):
        raise ValueError("invalid_cases")
    for c in cases:
        state_for(c)
        if c["facet"] not in ("role", "basis") or not c["expected"] or not set(c["expected"]) <= {
                "complete", "partial", "unrelated", "conflict", "unknown"}:
            raise ValueError("invalid_case")
    return data


def summarize(rows):
    good = [r for r in rows if "error" not in r]
    accepted = [r for r in good if not r["result"]["abstained"]]
    return {"attempted": len(rows), "completed": len(good),
        "matches": sum(r["result"]["label"] in r["expected"] for r in good),
        "accepted": len(accepted), "accepted_errors": sum(r["result"]["label"] not in r["expected"] for r in accepted),
        "false_complete": sum(r["result"]["label"] == "complete" and "complete" not in r["expected"] for r in good),
        "false_conflict": sum(r["result"]["label"] == "conflict" and "conflict" not in r["expected"] for r in good),
        "by_expected": {label: {"total": sum(label in r["expected"] for r in rows),
            "matched": sum(label in r["expected"] and r["result"]["label"] == label for r in good)}
            for label in ("complete", "partial", "conflict", "unrelated", "unknown")},
        "labels": dict(Counter(r["result"]["label"] for r in good)),
        "clarifications": sum(r["result"].get("feedback", {}).get("kind") == "clarify" for r in good if r["result"].get("feedback")),
        "p50_ms": percentile([r["result"]["elapsed_ms"] for r in good], .5),
        "p95_ms": percentile([r["result"]["elapsed_ms"] for r in good], .95)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--order", choices=("canonical", "reversed"), default="canonical")
    parser.add_argument("--threshold", action="append", default=[], metavar="GATE=VALUE",
                        help="Offline decision-specific override; does not change serving defaults or establish calibration.")
    args = parser.parse_args()
    thresholds = {}
    try:
        for value in args.threshold:
            gate, number = value.split("=", 1)
            if gate in thresholds:
                raise ValueError("duplicate_decision_threshold")
            thresholds[gate] = float(number)
        policy = GroundedJev(None, thresholds=thresholds).thresholds
    except (ValueError, TypeError) as error:
        parser.error(str(error))
    data = load(args.data)
    args.out.mkdir(parents=True, exist_ok=False)
    sources = args.out / "source"
    sources.mkdir()
    hashes = {}
    for name in ("jev_grounded.py", "jev_grounded_eval.py", "atomic_decisions.py", "decision_eval.py", "decision_providers.py", "runtime.py"):
        path = Path(__file__).with_name(name)
        (sources / name).write_bytes(path.read_bytes())
        hashes[name] = digest(path)
    save(args.out / "data.json", data)
    save(args.out / "freeze.json", {"created_at": datetime.now(timezone.utc).isoformat(), "version": VERSION,
        "data_sha256": digest(args.data), "source_sha256": hashes, "order": args.order, "max_calls": 2000, "decision_thresholds": policy, "calibrated": False})
    if args.dry_run:
        print(json.dumps({"validated": len(data["cases"]), "calls": 0}))
        return 0
    rows = []
    started = time.monotonic()
    try:
        provider = JevProvider(args.allow_remote)
    except ProviderError as error:
        save(args.out / "failed.json", {"error": str(error), "calls": 0})
        return 1
    total_calls = total_tokens = total_outputs = 0
    with (args.out / "calls.jsonl").open("x") as journal:
        for c in data["cases"]:
            def record(event):
                journal.write(json.dumps({"case_id": c["id"], **event}, ensure_ascii=False, allow_nan=False) + "\n")
                journal.flush()
            reader = GroundedJev(provider, record, max_calls=2000-total_calls, thresholds=policy)
            try:
                result = reader.decide(c, args.order)
                row = {"case_id": c["id"], "expected": c["expected"], "result": result}
            except ProviderError as error:
                row = {"case_id": c["id"], "expected": c["expected"], "error": str(error)}
            rows.append(row)
            total_calls += reader.calls
            total_tokens += reader.input_tokens
            total_outputs += reader.output_tokens
            save(args.out / (c["id"] + ".json"), row)
            print(json.dumps({"done": len(rows), "of": len(data["cases"]), "case_id": c["id"],
                              "label": row.get("result", {}).get("label"), "error": row.get("error")}), flush=True)
            if "error" in row:
                break
    result = {"synthetic": True, "human_reviewed": False, "production_approved": False,
        "version": VERSION, "decision_thresholds": policy, "serving_defaults": DECISION_THRESHOLDS, "calibrated": False, "provider": provider.metadata, "rows": rows, "summary": summarize(rows),
        "calls": total_calls, "input_tokens": total_tokens, "output_tokens": total_outputs,
        "estimated_usd": total_tokens * .042 / 1_000_000,
        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        "completed": len(rows) == len(data["cases"]) and all("error" not in r for r in rows)}
    save(args.out / "run.json", result)
    print(json.dumps({k: v for k, v in result.items() if k != "rows"}, ensure_ascii=False))
    return 0 if result["completed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
