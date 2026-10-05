"""Synthetic 2/40/80/160-unit input-budget probe, not a sequential reader.

Keeps the answer-bearing first/last units, inserts unique background units that
precede the current unit, and exercises the unchanged runtime truncation guard.
Long-input refusal is recorded as failure; text is never silently truncated.
"""
import argparse
from copy import deepcopy
import json
from pathlib import Path

from atomic_decisions import questions_for, state_for
from decision_eval import load_cases, run_one, save
from decision_providers import JevProvider, LayaProvider, ProviderError
from runtime import digest


def extended_case(case, count):
    if count < 2:
        raise ValueError("at_least_two_units_required")
    result = deepcopy(case)
    background = [f"배경 기록 {i + 1}번: 당시 사무실에는 안내 게시판과 공용 물품 보관함이 있었습니다."
                  for i in range(count - 2)]
    result["units"] = [case["units"][0], *background, case["units"][case["current_index"]]]
    result["current_index"] = count - 1
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", type=Path, default=Path(".local/readme-laya/model"))
    parser.add_argument("--provider", choices=("laya", "jev"), default="laya")
    parser.add_argument("--allow-remote", action="store_true")
    args = parser.parse_args()
    data = load_cases(args.data)
    cases = [c for c in data["cases"] if c["id"] in ("role-direct", "basis-complete")]
    if len(cases) != 2:
        raise ValueError("controls_missing")
    args.out.mkdir(parents=True, exist_ok=False)
    generated = [extended_case(c, count) for c in cases for count in (2, 40, 80, 160)]
    save(args.out / "inputs.json", generated)
    sources = args.out / "source"
    sources.mkdir()
    hashes = {}
    for name in ("decision_context_probe.py", "atomic_decisions.py", "decision_eval.py", "decision_providers.py", "runtime.py"):
        path = Path(__file__).with_name(name)
        (sources / name).write_bytes(path.read_bytes())
        hashes[name] = digest(path)
    save(args.out / "freeze.json", {"input_sha256": digest(args.out / "inputs.json"), "source_sha256": hashes,
                                   "requested_provider": args.provider})
    try:
        provider = LayaProvider(args.model) if args.provider == "laya" else JevProvider(args.allow_remote)
    except ProviderError as error:
        save(args.out / "failed.json", {"error": str(error), "model_calls": 0})
        return 1
    rows = []
    stop = False
    for case in generated:
        for design in ("current", "atomic"):
            questions = questions_for(design, case["facet"])
            encoded = None
            if args.provider == "laya":
                internal = {key: provider.agent._to_internal(q) for key, q in questions.items()}
                encoded = provider.agent._encode_state(state_for(case), list(questions), internal,
                                                        max_len=1024, head_max_len=256)
            row = run_one(provider, case, design, "canonical")
            row.update(units=len(case["units"]), characters=sum(map(len, case["units"])),
                       state_stats=[item["state_stats"] for item in encoded] if encoded else None,
                       token_guard_rejected=any(item["state_stats"]["truncated"] for item in encoded) if encoded else None)
            rows.append(row)
            if "error" in row and args.provider == "jev":
                stop = True
                break
        if stop:
            break
    tokens = sum(r["usage"]["input_tokens"] for r in rows if r.get("usage"))
    save(args.out / "run.json", {"synthetic": True, "human_reviewed": False,
        "production_approved": False, "provider": provider.metadata, "rows": rows,
        "completed": len(rows) == 16 and all("error" not in r for r in rows),
        "input_tokens": tokens if args.provider == "jev" else None,
        "estimated_usd": round(tokens * .042 / 1_000_000, 8) if args.provider == "jev" else None,
        "limitations": ["Artificial distractor-length probe, not realistic resume quality or end-to-end time.",
            "Input guard rejection is NOT a completed decision; no text truncation or recovery was applied.",
            "Laya uses current 1024-token runtime configuration, not its theoretical maximum context.",
            "Jev internal tokenization/truncation is not exposed; local state_stats and token_guard_rejected are null."]})
    print(json.dumps([{k: r.get(k) for k in ("case_id", "design", "units", "characters", "error", "token_guard_rejected", "elapsed_ms")} for r in rows]))
    return 1 if stop else 0


if __name__ == "__main__":
    raise SystemExit(main())
