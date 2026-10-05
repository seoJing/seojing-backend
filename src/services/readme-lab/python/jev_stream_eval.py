"""Sequential synthetic probe of PRE-SPECIFIED questions, not a full product.

Carries predicted question state and an exact source-filter cache forward. No
expected answer is injected. Posting extraction, question generation and final
Codex reporting are excluded and must be timed in a separate integration test.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from decision_eval import save, percentile
from decision_providers import JevProvider, ProviderError
from jev_grounded import GroundedJev, VERSION, accepted
from runtime import digest


def next_status(previous, label):
    if label == "complete":
        return "resolved"
    if label == "conflict":
        return "reopened"
    if label == "partial":
        return previous if previous in ("resolved", "reopened") else "partial"
    return previous  # Uncertainty is separately flagged, never missing ability.


def stream(data, provider, record):
    units = data["units"]
    readers, states, rows, ledger, adopted = {}, {}, [], [], {}
    for seed in data["seeds"]:
        readers[seed["id"]] = GroundedJev(provider, record, max_calls=500)
        states[seed["id"]] = "open"
        adopted[seed["id"]] = []
    started = time.monotonic()
    for index in range(len(units)):
        for seed in data["seeds"]:
            if index <= seed["origin"]:
                continue
            case = {k: seed[k] for k in ("facet", "question", "sufficient", "insufficient")}
            case.update(units=units[seed["origin"]:index + 1], current_index=index - seed["origin"])
            row_started = time.monotonic()
            reader = readers[seed["id"]]
            calls_before, tokens_before = reader.calls, reader.input_tokens
            result = reader.decide(case)
            previous = states[seed["id"]]
            states[seed["id"]] = next_status(previous, result["label"])
            audit = None
            recovery = None
            if result["label"] == "complete":
                adopted[seed["id"]] = result.get("evidence", [])
            elif previous == "resolved" and result["label"] in ("partial", "unknown") and adopted[seed["id"]]:
                audit = reader.audit_adopted(case, adopted[seed["id"]])
                if audit["label"] == "no" and accepted(audit):
                    states[seed["id"]] = "reopened"
                    recovery = "adopted_evidence_invalidated"
            result["calls"] = reader.calls - calls_before
            result["input_tokens"] = reader.input_tokens - tokens_before
            result["elapsed_ms"] = round((time.monotonic() - row_started) * 1000, 3)
            row = {"question_id": seed["id"], "at": index, "previous_status": previous,
                   "status": states[seed["id"]], "result": result,
                   "adopted_evidence_audit": audit, "recovery_reason": recovery,
                   "uncertain_update": result["label"] == "unknown" or (audit is not None and
                       (audit["label"] == "unclear" or not accepted(audit)))}
            rows.append(row)
            if states[seed["id"]] != previous:
                ledger.append({k: row[k] for k in ("question_id", "at", "previous_status", "status")})
            if index % 10 == 0:
                print(json.dumps({"at": index, "of": len(units), "question": seed["id"], "status": states[seed["id"]]}), flush=True)
    checks = []
    for seed in data["seeds"]:
        for index, expected in seed["expected_states"].items():
            row = next(r for r in rows if r["question_id"] == seed["id"] and r["at"] == int(index))
            checks.append({"question_id": seed["id"], "at": int(index), "expected": expected,
                           "actual": row["status"], "latest_label": row["result"]["label"],
                           "expected_label": seed["expected_labels"][index],
                           "pass": row["status"] == expected and row["result"]["label"] in
                           ([seed["expected_labels"][index]] if isinstance(seed["expected_labels"][index], str)
                            else seed["expected_labels"][index])})
    tokens = sum(r.input_tokens for r in readers.values())
    return {"synthetic": True, "human_reviewed": False, "production_approved": False,
        "version": VERSION, "units": len(units), "rows": rows, "transitions": ledger,
        "source_maps": {seed["id"]: {f"u{i}": {"global_index": seed["origin"] + i, "text": text}
            for i, text in enumerate(units[seed["origin"]:])} for seed in data["seeds"]},
        "checks": checks, "check_matches": sum(c["pass"] for c in checks),
        "states": states, "calls": sum(r.calls for r in readers.values()),
        "input_tokens": tokens, "output_tokens": sum(r.output_tokens for r in readers.values()),
        "estimated_usd": tokens * .042 / 1_000_000,
        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        "decision_p95_ms": percentile([r["result"]["elapsed_ms"] for r in rows], .95),
        "limitations": ["Two pre-specified question seeds; automatic question generation is not tested.",
            "Posting preparation, report generation, upload/parser, HTTP serving and concurrent users are excluded.",
            "All original source is retained; source IDs in each result are relative to its seed origin.",
            "Relevant or unknown updates to a resolved question re-audit its exact adopted evidence; a confident invalidation reopens it.",
            "Uncertain audits preserve the previous status with uncertain_update=true; they do not certify that the answer remains valid."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    data = json.loads(args.data.read_text())
    if data.get("synthetic") is not True or data.get("human_reviewed") is not False or data.get("label_status") != "provisional_agent_authored":
        raise ValueError("synthetic_only")
    if not 40 <= len(data["units"]) <= 160 or not 1 <= len(data["seeds"]) <= 4:
        raise ValueError("invalid_stream_size")
    if len({s["id"] for s in data["seeds"]}) != len(data["seeds"]):
        raise ValueError("duplicate_seed")
    for seed in data["seeds"]:
        if not 0 <= seed["origin"] < len(data["units"]) - 1 or any(not seed["origin"] < int(i) < len(data["units"]) for i in seed["expected_states"]):
            raise ValueError("invalid_seed_or_check_position")
    args.out.mkdir(parents=True, exist_ok=False)
    sources = args.out / "source"
    sources.mkdir()
    hashes = {}
    for name in ("jev_stream_eval.py", "jev_grounded.py", "atomic_decisions.py", "decision_eval.py", "decision_providers.py", "runtime.py"):
        path = Path(__file__).with_name(name)
        (sources / name).write_bytes(path.read_bytes())
        hashes[name] = digest(path)
    save(args.out / "data.json", data)
    save(args.out / "freeze.json", {"created_at": datetime.now(timezone.utc).isoformat(),
        "data_sha256": digest(args.data), "source_sha256": hashes})
    if args.dry_run:
        print(json.dumps({"units": len(data["units"]), "questions": len(data["seeds"]), "calls": 0}))
        return 0
    try:
        provider = JevProvider(args.allow_remote)
        with (args.out / "calls.jsonl").open("x") as journal:
            def record(event):
                journal.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
                journal.flush()
            result = stream(data, provider, record)
        save(args.out / "run.json", result)
        print(json.dumps({k: v for k, v in result.items() if k not in ("rows", "transitions", "checks")}, ensure_ascii=False))
        return 0
    except ProviderError as error:
        save(args.out / "failed.json", {"error": str(error), "completed": False})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
