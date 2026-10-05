"""Actual runtime comparisons on previously observed synthetic prefix cases.

Loads an experiment adapter only in this process. It never writes the model
directory, exports a service metadata payload, or declares a checkpoint approved.
"""
import argparse
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import time

from safetensors.torch import load_file
from runtime import load_agent, predict, READER_RELATION, READER_UNIT, RELEVANCE, READER_CHECK, digest


def relation_gate(answers):
    scope, relation = answers["scope"], answers["relation"]
    if scope["label"] == "different" and scope["confidence"] >= .75:
        return "unrelated"
    if scope["label"] == "same" and min(scope["confidence"], relation["confidence"]) >= .75:
        return relation["label"]
    return "unknown"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError("output_already_exists")
    metrics = json.loads((args.run / "metrics.json").read_text())
    previous = json.loads(args.cases.read_text())
    if (metrics.get("production_approved") is not False or metrics.get("human_reviewed") is not False
            or not metrics.get("checkpoint_roundtrip") or previous.get("synthetic") is not True
            or previous.get("human_reviewed") is not False):
        raise ValueError("only_completed_provisional_experiment")
    adapter = args.run / "head.safetensors"
    if digest(adapter) != metrics["head_sha256"]:
        raise ValueError("adapter_digest_mismatch")
    agent, base_metadata = load_agent(args.model.resolve())
    if base_metadata != metrics["model"]:
        raise ValueError("base_model_mismatch")
    results = []
    checks = [
        ("personal-action", "제가 SQL로 주간 판매 보고서를 직접 작성했습니다.", "SQL을 이용한 판매 보고서 작성 경험"),
        ("team-action", "우리 팀 전체가 함께 주간 판매 보고서를 작성했습니다.", "SQL을 이용한 판매 보고서 작성 경험"),
        ("future-plan", "저는 다음 달부터 SQL을 배워 판매 보고서를 작성할 계획입니다.", "SQL을 이용한 판매 보고서 작성 경험"),
        ("participation-claim", "저는 지역 행사 운영에 참여해 성공적인 진행에 기여했습니다.", "행사 운영 지원 경험"),
    ]
    for variant in ("base", "candidate"):
        if variant == "candidate":
            weights = load_file(str(adapter))
            loaded = agent.model.load_state_dict(weights, strict=False)
            if loaded.unexpected_keys:
                raise ValueError("adapter_keys_invalid")
        for case in previous["rows"]:
            for order in ("canonical", "reversed"):
                questions = deepcopy(READER_RELATION)
                if order == "reversed":
                    for q in questions.values():
                        q["criteria"] = dict(reversed(list(q["criteria"].items())))
                started = time.monotonic()
                answer = predict(agent, case["laya_input"], questions, strict_head=True)
                gate = relation_gate(answer)
                results.append({"variant": variant, "order": order, "id": case["id"], "kind": "reader_relation",
                                "expected": case["expected"], "answer": answer, "policy_candidate": gate,
                                "matches_provisional": gate in case["expected"],
                                "elapsed_ms": round((time.monotonic()-started)*1000)})
        for name, current, requirement in checks:
            facts = predict(agent, {"current": current, "previous": [], "context_limited": False}, READER_UNIT, strict_head=True)
            relevance = predict(agent, {"current": current, "requirement": requirement}, RELEVANCE, strict_head=True)
            check = predict(agent, {"current": current, "previous": [], "check": {
                "facet": "role", "trigger": "참여 또는 기여 주장은 있으나 개인 담당 범위가 없음",
                "sufficient": "해당 경험에서 본인이 실제 수행한 업무 설명", "insufficient": "팀 전체 업무 또는 차후 계획만 제시",
            }}, READER_CHECK, strict_head=True)
            results.append({"variant": variant, "kind": "reader_unit", "id": name, "current": current,
                            "facts": facts, "relevance": relevance, "check": check})
    summaries = []
    for variant in ("base", "candidate"):
        rows = [r for r in results if r["variant"] == variant and r["kind"] == "reader_relation" and r["order"] == "canonical"]
        summaries.append({"variant": variant, "cases": len(rows), "policy_labels": dict(Counter(r["policy_candidate"] for r in rows)),
                          "matches_provisional": sum(r["matches_provisional"] for r in rows),
                          "false_complete": sum(r["policy_candidate"] == "complete" and "complete" not in r["expected"] for r in rows)})
    result = {"synthetic": True, "human_reviewed": False, "production_approved": False,
              "base_model": base_metadata, "adapter_sha256": metrics["head_sha256"], "cases_sha256": digest(args.cases),
              "runtime_sha256": digest(Path(__file__).with_name("runtime.py")), "probe_sha256": digest(Path(__file__)),
              "temperature": "runtime_default_1.0_not_experimental_calibration", "summary": summaries, "results": results,
              "limitations": ["Previously observed development controls, not a new held-out benchmark.",
                              "Unit outputs are diagnostics, not replayed UI notes or validated competency."]}
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summaries), flush=True)


if __name__ == "__main__":
    main()
