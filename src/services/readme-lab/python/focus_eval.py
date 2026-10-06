"""Explicit, synthetic-only remote evaluation. Never loads applicant uploads.

Run with --allow-remote --config /protected/runtime.json. Credentials are read
locally and never copied into artifacts. Frozen expectations are evaluator-only.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

from decision_providers import JevProvider, ProviderError
from jev_focus_reader import FocusReader, SPEECH


def units_for(texts):
    return [{"id": "u" + str(i + 1), "order": i, "block_id": "b" + str(i + 1),
             "scope_id": "s" + str(sum(t.startswith("#") for t in texts[:i + 1])),
             "start": 0, "end": len(text.encode("utf-16-le")) // 2, "text": text,
             "block_type": "heading" if text.startswith("#") else "paragraph"}
            for i, text in enumerate(texts)]


class CapturedProvider:
    def __init__(self, provider):
        self.provider = provider
        self.requests = []

    def ask(self, state, questions):
        record = {"state": state, "questions": questions}
        self.requests.append(record)
        try:
            result = self.provider.ask(state, questions)
            record["result"] = result
            return result
        except ProviderError as error:
            record["error"] = str(error)
            raise


def check(case, trace, snapshot, error):
    expect = case["expect"]
    checks = {"completed": error is None}
    events = [e for step in trace for e in step["events"]]
    qs = snapshot["questions"]
    target = next((q for q in qs if q["origin_unit_id"] == "u" + str(expect.get("question_at"))
                   and q["facet"] == expect.get("facet")), None)
    if "question_at" in expect:
        checks["question"] = target is not None
    for name, status in (("resolved_at", "resolved"), ("reopened_at", "reopened")):
        if name in expect:
            checks[name] = bool(target and any(e["type"] == "updated" and e["question"]["id"] == target["id"]
                and e["question"]["status"] == status and e["at_unit_id"] == "u" + str(expect[name]) for e in events))
    if "revisit_at" in expect:
        checks["revisit"] = bool(target and any(e["type"] == "revisit" and e["question_id"] == target["id"]
            and e["at_unit_id"] == "u" + str(expect["revisit_at"]) for e in events))
    if "parked_by" in expect:
        checks["parked"] = bool(target and any(e["type"] == "parked" and e["question_id"] == target["id"]
            and int(e["at_unit_id"][1:]) <= expect["parked_by"] for e in events))
    if expect.get("never_resolved"):
        checks["never_resolved"] = bool(target and not any(e["type"] == "updated" and
            e["question"]["id"] == target["id"] and e["question"]["status"] == "resolved" for e in events))
    if "not_resolved_before" in expect:
        checks["no_early_resolution"] = bool(target and not any(e["type"] == "updated" and
            e["question"]["id"] == target["id"] and e["question"]["status"] == "resolved" and
            int(e["at_unit_id"][1:]) < expect["not_resolved_before"] for e in events))
    if expect.get("no_questions"):
        checks["no_questions"] = not qs
    if expect.get("no_resolved"):
        checks["no_resolved"] = not any(e["type"] == "updated" and e["question"]["status"] == "resolved" for e in events)
    if "min_observations" in expect:
        checks["observations"] = sum(e["type"] == "observation" for e in events) >= expect["min_observations"]
    if "min_retractions" in expect:
        checks["retractions"] = sum(e["type"] == "retracted" for e in events) >= expect["min_retractions"]
    if "active_at" in expect:
        at = expect["active_at"] - 1
        checks["active_preserved"] = bool(target and len(trace) > at and trace[at]["active_question_id"] == target["id"])
    # Independent structural invariants, not outputs inferred from expected labels.
    source = {u["id"]: u for u in units_for(case["units"])}
    def valid(item, frontier):
        if isinstance(item, dict):
            if "unit_id" in item:
                u = source.get(item["unit_id"])
                if not u or u["order"] > frontier or "quote" in item and item["quote"] != u["text"]:
                    return False
            for key in ("target_unit_ids", "source_unit_ids"):
                if key in item and any(uid not in source or source[uid]["order"] > frontier for uid in item[key]):
                    return False
            return all(valid(v, frontier) for v in item.values())
        if isinstance(item, list):
            return all(valid(v, frontier) for v in item)
        return True
    checks["grounded_prefix"] = all(valid(step, i) for i, step in enumerate(trace))
    checks["one_active"] = sum(q["focus"] == "active" for q in qs) <= 1
    checks["speech_once"] = all(len([e.get("question_id") for e in step["events"] if e["type"] == "speech" and e.get("question_id")]) ==
        len({e["question_id"] for e in step["events"] if e["type"] == "speech" and e.get("question_id")}) for step in trace)
    checks["no_silent_limit"] = not any(e["type"] == "limited" for e in events)
    for i, extra in enumerate(case.get("extra_expect", [])):
        checks.update({"extra_" + str(i) + "_" + k: v for k, v in check(
            {**case, "expect": extra, "extra_expect": []}, trace, snapshot, error).items()})
    return checks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-remote", action="store_true", required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, default=Path("test/fixtures/readme/focus-reader-v1.json"))
    parser.add_argument("--case", action="append")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    corpus = json.loads(args.fixtures.read_text())
    if not corpus.get("purpose", "").startswith("Synthetic"):
        raise SystemExit("synthetic_fixture_required")
    config = json.loads(args.config.read_text())
    os.environ["TYPESAFE_API_KEY"] = config["TYPESAFE_API_KEY"]
    try:
        provider = JevProvider(True)
    finally:
        os.environ.pop("TYPESAFE_API_KEY", None)
    args.output.mkdir(parents=True, exist_ok=False)
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (
        args.fixtures, Path(__file__), Path(__file__).with_name("jev_focus_reader.py"))}
    results = []
    for case in corpus["cases"]:
        if args.case and case["id"] not in args.case:
            continue
        capture = CapturedProvider(provider)
        reader = FocusReader(capture)
        units = units_for(case["units"])
        trace = []
        error = None
        started = time.monotonic()
        for i in range(len(units)):
            try:
                trace.append(reader.step({"prefix": units[:i + 1], "role_context": case["role_context"]}))
            except ProviderError as exc:
                error = str(exc)
                break
        snapshot = reader.snapshot()
        checks = check(case, trace, snapshot, error)
        result = {"id": case["id"], "passed": all(checks.values()), "checks": checks,
                  "error": error, "elapsed_ms": round((time.monotonic() - started) * 1000),
                  "metrics": reader.metrics(), "trace": trace, "snapshot": snapshot}
        (args.output / (case["id"] + ".json")).write_text(json.dumps({**result, "synthetic_input": case,
            "requests": capture.requests}, ensure_ascii=False, indent=2))
        results.append(result)
        print(json.dumps({k: v for k, v in result.items() if k not in ("trace", "snapshot")}, ensure_ascii=False), flush=True)
    (args.output / "summary.json").write_text(json.dumps({"synthetic": True, "hashes": hashes,
        "results": [{k: v for k, v in r.items() if k not in ("trace", "snapshot")} for r in results]}, ensure_ascii=False, indent=2))
    lines = ["# 실제 Jev 독해 — 합성 검증", "", "개인 이력서가 아닌 고정 합성 사례입니다. 말풍선은 상태 코드의 표시 문구입니다.", ""]
    for r in results:
        lines.extend(["## " + r["id"], "", "통과" if r["passed"] else "실패 — " + str(r["checks"]), ""])
        case = next(c for c in corpus["cases"] if c["id"] == r["id"])
        for i, t in enumerate(r["trace"]):
            lines.extend(["**" + t["at_unit_id"] + "** " + case["units"][i], ""])
            for e in t["events"]:
                if e["type"] == "speech":
                    lines.extend(["> " + SPEECH[e["code"]], ""])
                elif e["type"] == "revisit":
                    lines.extend(["원문 재확인: " + ", ".join(e["target_unit_ids"]), ""])
                elif e["type"] == "updated":
                    lines.extend(["질문 상태: " + e["previous_status"] + " → " + e["question"]["status"], ""])
        lines.extend(["실제 호출/토큰: `" + json.dumps(r["metrics"]) + "`", ""])
    (args.output / "READING.md").write_text("\n".join(lines))
    return 0 if results and all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
