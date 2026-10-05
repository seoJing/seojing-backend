"""Synthetic diagnostic ablation, not human-reviewed evaluation or training.

Keeps Korean states and the serving checkpoint fixed; compares instructions and
criterion descriptions translated to English, then reverses their option order.
Stores every answer/probability, rejects state truncation and merged option token
sequences. Partial head-description truncation is not audited. No serving changes.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import contextlib
import json
from pathlib import Path
import time

from runtime import QUESTIONS, RELATION, RELEVANCE, digest, load_agent

KO = {"unit": QUESTIONS, "relation": RELATION, "relevance": RELEVANCE}
EN = {
    "unit": {
        "signal": {"type": "choice", "instructions": "Judge how specific the current resume sentence is. Do not infer facts outside the supplied text.", "criteria": {
            "concrete": "A specific personal role, action, output, or measurement basis is described.",
            "claim": "Participation, contribution, competence, or results are claimed without concrete explanation.",
            "context": "A heading, period, or background context, not a claim of competence.",
            "unclear": "The meaning or who performed the work cannot be determined.",
        }},
        "missing": {"type": "choice", "instructions": "Choose the most important missing information needed to understand the current claim. Do not ask for information already explained.", "criteria": {
            "role": "The applicant's own role, distinct from the team's result.",
            "method": "The specific actions or methods used.",
            "basis": "The comparison baseline and measurement supporting a numerical or outcome claim.",
            "none": "No additional clarification is needed, or this is not a competence claim.",
        }},
    },
    "relation": {"relation": {"type": "choice", "instructions": "Compare the earlier question with the current sentence. An answer candidate must be confirmed to concern the same experience and directly answer the question.", "criteria": {
        "answers": "The current sentence concerns the same experience and directly answers the question.",
        "partial": "Some explanation is provided, but it does not sufficiently answer the question.",
        "unrelated": "The current sentence concerns a different experience or is unrelated to the question.",
        "uncertain": "It is unclear whether the experience is the same or whether the question is answered.",
    }}},
    "relevance": {"relevance": {"type": "choice", "instructions": "Judge whether the current sentence offers concrete experience relevant to the job requirement. Matching words alone are not evidence.", "criteria": {
        "supports": "A concrete action in the current sentence is directly relevant to the requirement.",
        "mentions": "The requirement is mentioned but supporting action evidence is missing.",
        "unrelated": "The sentence is unrelated to the requirement, or relevance cannot be determined.",
    }}},
}


def questions_for(variant, kind):
    questions = deepcopy(KO[kind] if variant.startswith("current_ko") else EN[kind])
    if variant.endswith("_reversed"):
        for question in questions.values():
            question["criteria"] = dict(reversed(list(question["criteria"].items())))
    return questions


def summarize(records):
    groups = defaultdict(list)
    for row in records:
        groups[(row["variant"], "all")].append(row)
        groups[(row["variant"], row["question_id"])].append(row)
    summaries = []
    for (variant, question), rows in groups.items():
        above_threshold = [row for row in rows if row["confidence"] >= 0.65]
        summaries.append({"variant": variant, "question": question,
            "matched_provisional_labels": sum(row["matches_provisional_label"] for row in rows),
            "total": len(rows), "heads_at_or_above_065": len(above_threshold),
            "provisional_mismatches_at_or_above_065": sum(not row["matches_provisional_label"] for row in above_threshold),
            "selected_labels": dict(Counter(row["label"] for row in rows))})
    comparisons = []
    for base, other in (("current_ko", "current_ko_repeat"), ("current_ko", "current_ko_reversed"), ("english", "english_reversed")):
        regular = {(r["case_id"], r["question_id"]): r["label"] for r in records if r["variant"] == base}
        compared = [r for r in records if r["variant"] == other]
        flips = [r for r in compared if r["label"] != regular[(r["case_id"], r["question_id"])]]
        comparisons.append({"base": base, "other": other, "label_flips": len(flips), "decisions": len(compared),
            "flips_by_question": dict(Counter(r["question_id"] for r in flips))})
    return {"groups": summaries, "comparisons": comparisons}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError("output_already_exists")
    dataset = json.loads(args.data.read_text())
    if dataset.get("label_status") != "provisional_agent_authored" or not dataset.get("synthetic") or dataset.get("human_reviewed") is not False:
        raise ValueError("only_synthetic_diagnostics_allowed")
    agent, metadata = load_agent(args.model.resolve())
    records = []
    for variant in ("current_ko", "current_ko_repeat", "current_ko_reversed", "english", "english_reversed"):
        for case in dataset["cases"]:
            questions = questions_for(variant, case["kind"])
            internal = {k: agent._to_internal(q) for k, q in questions.items()}
            encoded = agent._encode_state(case["state"], list(questions), internal, max_len=1024, head_max_len=256)
            if any(item["state_stats"]["truncated"] or item["options"]["options_distinct"] != item["options"]["options"] for item in encoded):
                raise ValueError("diagnostic_token_truncation")
            started = time.monotonic()
            with contextlib.redirect_stdout(__import__("sys").stderr):
                result = agent.predict(case["state"], questions, lang="ko", max_len=1024, head_max_len=256)
            elapsed_ms = round((time.monotonic() - started) * 1000)
            for key, answer in result["answers"].items():
                expected = case["expected"][key]
                records.append({"variant": variant, "case_id": case["id"], "kind": case["kind"], "question_id": key,
                    "expected": expected, "label": answer["choice"], "confidence": answer["answer_confidence"],
                    "probabilities": answer["probabilities"], "matches_provisional_label": answer["choice"] in expected,
                    "elapsed_ms": elapsed_ms})
    result = {"synthetic": True, "human_reviewed": False, "production_approved": False,
        "limitations": ["Provisional agent-authored labels, not held-out product accuracy.",
            "Relation/relevance heads run independently of the serving concrete gate; head threshold counts are not UI actions.",
            "State truncation and option collapse checked; partial head-description truncation not checked.",
            "One repeated Korean control and fixed variant order; no latency comparison.",
            "elapsed_ms repeats the same unit-call duration for its two heads; do not sum per-record latency."],
        "label_status": dataset["label_status"], "model": metadata, "dataset_sha256": digest(args.data),
        "probe_sha256": digest(Path(__file__)), "runtime_sha256": digest(Path(__file__).with_name("runtime.py")),
        "summary": summarize(records), "records": records}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
