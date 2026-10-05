"""Freeze then run paired synthetic question-design probes, optionally with Jev.

This does not run the document parser, generate questions from a posting, carry
each model's predicted state forward, or produce a report. Throughput replay is
a workload of independent prefix decisions, not end-to-end document latency.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import random
import time

from atomic_decisions import VERSION, THRESHOLD, combine, questions_for, state_for
from decision_providers import JevProvider, LayaProvider, ProviderError
from runtime import digest


def save(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def load_cases(path):
    data = json.loads(path.read_text())
    if (data.get("synthetic") is not True or data.get("human_reviewed") is not False
            or data.get("label_status") != "provisional_agent_authored"):
        raise ValueError("only_provisional_synthetic_cases_allowed")
    cases = data.get("cases", [])
    if not 8 <= len(cases) <= 100 or len({c["id"] for c in cases}) != len(cases):
        raise ValueError("invalid_case_count_or_ids")
    for case in cases:
        state_for(case)
        if not case["expected"] or not set(case["expected"]) <= {
                "complete", "partial", "unrelated", "conflict", "unknown"}:
            raise ValueError("invalid_expected_relation")
        questions = questions_for("atomic", case["facet"])
        facts = case["expected_facts"]
        if set(facts) != set(questions) or any(facts[k] not in questions[k]["criteria"] for k in facts):
            raise ValueError("invalid_expected_facts")
        oracle = combine("atomic", case["facet"], {
            k: {"label": value, "confidence": 1} for k, value in facts.items()})
        if oracle["label"] not in case["expected"]:
            raise ValueError("oracle_composition_disagrees_with_fixture")
    return data


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def summarize(rows):
    groups = []
    for design in ("current", "atomic"):
        for order in ("canonical", "reversed"):
            all_rows = [r for r in rows if r["design"] == design and r["order"] == order]
            ok = [r for r in all_rows if "error" not in r]
            accepted = [r for r in ok if not r["gated"]["abstained"]]
            positive = [r for r in all_rows if "complete" in r["expected"]]
            times = [r["elapsed_ms"] for r in all_rows]
            groups.append({"design": design, "order": order, "attempted": len(all_rows),
                "completed": len(ok), "errors": len(all_rows) - len(ok),
                "raw_matches": sum(r["raw"]["label"] in r["expected"] for r in ok),
                "gated_matches": sum(r["gated"]["label"] in r["expected"] for r in ok),
                "accepted": len(accepted), "accepted_errors": sum(r["gated"]["label"] not in r["expected"] for r in accepted),
                "false_complete": sum(r["gated"]["label"] == "complete" and "complete" not in r["expected"] for r in ok),
                "false_conflict": sum(r["gated"]["label"] == "conflict" and "conflict" not in r["expected"] for r in ok),
                "expected_complete": len(positive),
                "missed_complete": sum("error" in r or r["gated"]["label"] != "complete" for r in positive),
                "labels": dict(Counter(r["gated"]["label"] for r in ok)),
                "question_count": sum(r["question_count"] for r in all_rows),
                "total_ms": round(sum(times), 3), "p50_ms": percentile(times, .5),
                "p95_ms": percentile(times, .95), "max_ms": max(times) if times else None})
    stability = []
    for design in ("current", "atomic"):
        original = {r["case_id"]: r for r in rows if r["design"] == design and r["order"] == "canonical" and "error" not in r}
        pairs = [(original[r["case_id"]], r) for r in rows
                 if r["design"] == design and r["order"] == "reversed"
                 and r["case_id"] in original and "error" not in r]
        stability.append({"design": design, "paired_cases": len(pairs),
            "raw_label_flips": sum(a["raw"]["label"] != b["raw"]["label"] for a, b in pairs),
            "gated_label_flips": sum(a["gated"]["label"] != b["gated"]["label"] for a, b in pairs),
            "acceptance_flips": sum(a["gated"]["abstained"] != b["gated"]["abstained"] for a, b in pairs),
            "head_label_flips": sum(a["answers"][k]["label"] != b["answers"][k]["label"] for a, b in pairs for k in a["answers"]),
            "head_pairs": sum(len(a["answers"]) for a, _ in pairs),
            "max_confidence_change": max((abs(a["answers"][k]["confidence"] - b["answers"][k]["confidence"])
                                          for a, b in pairs for k in a["answers"]), default=None)})
    return {"groups": groups, "stability": stability}


def run_one(provider, case, design, order):
    questions = questions_for(design, case["facet"], order)
    row = {"case_id": case["id"], "facet": case["facet"], "design": design, "order": order,
           "expected": case["expected"], "question_count": len(questions)}
    started = time.monotonic()
    try:
        row.update(provider.ask(state_for(case), questions))
        row["raw"] = combine(design, case["facet"], row["answers"], threshold=0)
        row["gated"] = combine(design, case["facet"], row["answers"])
        if design == "atomic":
            row["head_matches"] = {k: a["label"] == case["expected_facts"][k] for k, a in row["answers"].items()}
    except ProviderError as error:
        row.update(error=str(error), elapsed_ms=round((time.monotonic() - started) * 1000, 3))
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--provider", choices=("laya", "jev"), default="laya")
    parser.add_argument("--model", type=Path, default=Path(".local/readme-laya/model"))
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--load-counts", type=int, nargs="*", default=[])
    args = parser.parse_args()
    if any(n < 1 or n > 160 for n in args.load_counts) or len(args.load_counts) > 3:
        parser.error("load counts must be 1..160, at most three workloads")
    if args.provider != "laya" and args.candidate:
        parser.error("candidate only applies to local Laya")
    data = load_cases(args.data)
    cases = data["cases"]
    # Deterministic interleaving: every case/arm/order exactly once, not grouped
    # into a warm model for one arm and a cold model for the other.
    schedule = [(case, design, order) for case in cases for design in ("current", "atomic")
                for order in ("canonical", "reversed")]
    random.Random(24).shuffle(schedule)
    args.out.mkdir(parents=True, exist_ok=False)
    sources = args.out / "source"
    sources.mkdir()
    hashes = {}
    for name in ("decision_eval.py", "atomic_decisions.py", "decision_providers.py", "runtime.py"):
        path = Path(__file__).with_name(name)
        (sources / name).write_bytes(path.read_bytes())
        hashes[name] = digest(path)
    save(args.out / "data.json", data)
    save(args.out / "inputs.json", [{"case_id": c["id"], "state": state_for(c),
        "designs": {d: questions_for(d, c["facet"]) for d in ("current", "atomic")}} for c in cases])
    save(args.out / "freeze.json", {"version": VERSION, "created_at": datetime.now(timezone.utc).isoformat(),
        "data_sha256": digest(args.data), "source_sha256": hashes, "threshold": THRESHOLD,
        "schedule": [(c["id"], d, o) for c, d, o in schedule], "load_counts": args.load_counts,
        "requested_provider": args.provider, "dry_run": args.dry_run})
    if args.dry_run:
        print(json.dumps({"validated_cases": len(cases), "scheduled_calls": len(schedule), "model_calls": 0}))
        return
    try:
        provider = LayaProvider(args.model) if args.provider == "laya" else JevProvider(args.allow_remote)
        if args.candidate:
            from safetensors.torch import load_file
            metrics = json.loads((args.candidate / "metrics.json").read_text())
            weights_path = args.candidate / "head.safetensors"
            if (metrics.get("production_approved") is not False or metrics.get("human_reviewed") is not False
                    or not metrics.get("checkpoint_roundtrip") or digest(weights_path) != metrics["head_sha256"]
                    or any(provider.metadata.get(k) != v for k, v in metrics["model"].items())):
                raise ProviderError("candidate_validation_failed")
            loaded = provider.agent.model.load_state_dict(load_file(str(weights_path)), strict=False)
            if loaded.unexpected_keys:
                raise ProviderError("candidate_keys_invalid")
            provider.metadata.update(candidate_sha256=metrics["head_sha256"], finetuned=True, production_approved=False)
    except ProviderError as error:
        save(args.out / "failed.json", {"error": str(error), "model_calls": 0})
        print(json.dumps({"error": str(error)}))
        return 1
    save(args.out / "provider.json", provider.metadata)
    rows, load_results = [], []
    started = time.monotonic()
    with (args.out / "calls.jsonl").open("x") as journal:
        def record(case, design, order, stage):
            row = run_one(provider, case, design, order)
            row["stage"] = stage
            journal.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
            journal.flush()
            return row
        # Explicit warmup measured separately, never counted as quality data.
        warmup = record(cases[0], "atomic", "canonical", "warmup")
        for index, (case, design, order) in enumerate(schedule):
            if "error" in warmup and args.provider == "jev":
                break
            rows.append(record(case, design, order, "comparison"))
            if (index + 1) % 16 == 0:
                print(json.dumps({"completed_calls": index + 1, "of": len(schedule)}), flush=True)
            if "error" in rows[-1] and args.provider == "jev":
                break  # No paid retries or continuation after an API failure.
        comparison_wall_ms = round((time.monotonic() - started) * 1000, 3)
        stop_workloads = False
        if all("error" not in r for r in rows) and len(rows) == len(schedule):
            for count in args.load_counts:
                for design in ("current", "atomic"):
                    if stop_workloads:
                        break
                    beginning = time.monotonic()
                    workload = []
                    for i in range(count):
                        workload.append(record(cases[i % len(cases)], design, "canonical", f"load-{count}"))
                        if "error" in workload[-1] and args.provider == "jev":
                            stop_workloads = True
                            break
                    times = [r["elapsed_ms"] for r in workload]
                    load_results.append({"planned_count": count, "count": len(workload), "design": design,
                        "wall_ms": round((time.monotonic() - beginning) * 1000, 3),
                        "sum_call_ms": round(sum(times), 3), "p95_ms": percentile(times, .95),
                        "errors": sum("error" in r for r in workload),
                        "questions": sum(r["question_count"] for r in workload),
                        "scope": "repeated independent prefix workload; not long-document or end-to-end"})
    tokens = sum(r.get("usage", {}).get("input_tokens", 0) for r in rows if r.get("usage"))
    summary = {"synthetic": True, "human_reviewed": False, "production_approved": False,
        "provider": provider.metadata, "version": VERSION, "threshold": THRESHOLD,
        "completed": "error" not in warmup and len(rows) == len(schedule) and all("error" not in r for r in rows)
                     and all(r["errors"] == 0 and r["count"] == r["planned_count"] for r in load_results),
        "comparison": summarize(rows), "warmup": warmup, "load_workloads": load_results,
        "comparison_wall_ms_including_warmup": comparison_wall_ms,
        "total_wall_ms_excluding_model_load": round((time.monotonic() - started) * 1000, 3),
        "comparison_input_tokens": tokens if args.provider == "jev" else None,
        "comparison_estimated_usd": round(tokens * .042 / 1_000_000, 8) if args.provider == "jev" else None,
        "limitations": ["Agent-authored development labels, no human accuracy or product usefulness claim.",
            "Same fixed source prefixes, not model-generated memory or a complete sequential reader.",
            "Only personal-role and measured-improvement criteria; no arbitrary job rubric coverage.",
            "Raw confidence definitions differ across providers; 0.75 is an uncalibrated diagnostic gate.",
            "No posting preparation, question generation, parser, report, network serving or concurrent users in workload timing."]}
    save(args.out / "run.json", summary)
    print(json.dumps(summary["comparison"], ensure_ascii=False), flush=True)
    return 0 if summary["completed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
