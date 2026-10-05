"""Offline metric/data invariants. No model load, tokenizer download or training."""
from copy import deepcopy
import json
from pathlib import Path
import random
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/services/readme-lab/python"))
from data_validation import fingerprint, target_slot
from experiment import read_experiment, ordered_questions, items_for, summary, fit_temperature, order_flips
from experiment_data import dataset, dataset_v2
from train import encode


def record(head, expected, selected, confidence=.99):
    import math
    labels = ["same", "different", "unknown"] if head == "scope" else ["complete", "partial", "conflict", "unrelated", "unknown"]
    probs = [(1-confidence)/(len(labels)-1)] * len(labels)
    probs[labels.index(selected)] = confidence
    return {"id": "sample", "kind": "reader_relation", "head": head, "labels": labels,
            "target": labels.index(expected), "logits": [math.log(p) for p in probs]}


class ExperimentTests(unittest.TestCase):
    def validate(self, rows):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"data.jsonl"
            path.write_text("\n".join(json.dumps(r) for r in rows))
            return read_experiment(path)

    def test_generated_dataset_is_reproducible_and_four_way(self):
        saved = [json.loads(line) for line in (Path(__file__).parent/"fixtures/readme/laya-curriculum-v1.jsonl").read_text().splitlines()]
        self.assertEqual(dataset(), saved)
        self.assertEqual(len(self.validate(saved)), 223)

    def test_v2_preserves_v1_and_corrects_named_actor_with_broader_coverage(self):
        saved = [json.loads(line) for line in (Path(__file__).parent/"fixtures/readme/laya-curriculum-v2.jsonl").read_text().splitlines()]
        self.assertEqual(dataset_v2(), saved)
        self.assertEqual(len(self.validate(saved)), 260)
        self.assertEqual(next(r for r in saved if r["id"] == "dev-193")["labels"]["actor"], "other")
        self.assertEqual(next(r for r in dataset() if r["id"] == "dev-193")["labels"]["actor"], "self")
        for split in ("dev", "calibration", "test"):
            rows = [r for r in saved if r["split"] == split]
            self.assertEqual(len({r["group_id"] for r in rows}), 2)
            self.assertTrue(any(r["labels"].get("basis") == "missing" for r in rows))
            self.assertTrue(any(r["labels"].get("relation") == "unknown" for r in rows))

    def test_content_leak_even_with_new_id_and_group(self):
        rows = dataset()
        rows.append(dict(rows[0], id="copy", group_id="another", template_family="another", split="test"))
        with self.assertRaisesRegex(ValueError, "content_split_leakage"):
            self.validate(rows)
        self.assertEqual(fingerprint({"b": "Ａ   B", "a": 1}), fingerprint({"a": 1, "b": "A B"}))

    def test_template_leak_and_human_approval_fabrication_rejected(self):
        rows = dataset()
        rows[-1]["template_family"] = rows[0]["template_family"]
        with self.assertRaisesRegex(ValueError, "group_or_template_split_leakage"):
            self.validate(rows)
        rows = dataset(); rows[0]["human_reviewed"] = True
        with self.assertRaisesRegex(ValueError, "only_provisional_synthetic_experiments"):
            self.validate(rows)

    def test_conflicting_labels_on_same_input_rejected_even_inside_train(self):
        rows = dataset()
        duplicate = deepcopy(rows[0]); duplicate["id"] = "conflict"
        duplicate["labels"]["actor"] = "other"
        with self.assertRaisesRegex(ValueError, "conflicting_labels_for_same_input"):
            self.validate(rows + [duplicate])

    def test_reverse_and_shuffle_targets_follow_encoded_criteria(self):
        row = next(r for r in dataset() if r["kind"] == "reader_check")
        canonical = ordered_questions(row)
        reverse = ordered_questions(row, reverse=True)
        self.assertEqual(list(reverse["check"]["criteria"]), list(reversed(canonical["check"]["criteria"])))
        with patch("experiment.encode_checked", side_effect=lambda agent, state, questions, strict_head: [{} for _ in questions]):
            for seed in range(20):
                items = items_for(None, [row], rng=random.Random(seed))
                self.assertEqual(items[0]["labels"][items[0]["target"]], "needed")
        q = deepcopy(canonical["check"]); q["option_order"] = [3, 2, 1, 0]
        self.assertEqual(target_slot(q, "needed"), 3)

    def test_training_reuses_runtime_head_budget_guard(self):
        row = next(r for r in dataset() if r["kind"] == "reader_check")
        with patch("train.encode_checked", side_effect=ValueError("context_budget_exceeded")) as check:
            with self.assertRaisesRegex(ValueError, "context_budget_exceeded"):
                encode(None, row)
            self.assertTrue(check.call_args.kwargs["strict_head"])

    def test_relation_gate_excludes_unrelated_and_counts_wrong_scope(self):
        result = summary([record("scope", "same", "same"), record("relation", "unrelated", "unrelated")])
        self.assertEqual(result["relation_gate"]["accepted"], 0)
        result = summary([record("scope", "different", "same"), record("relation", "complete", "complete")])
        self.assertEqual(result["relation_gate"]["wrong"], 1)
        self.assertEqual(result["relation_gate"]["false_complete"], 1)

    def test_temperature_does_not_change_top_one_and_order_compares_labels(self):
        rows = [record("scope", "different", "same"), record("relation", "partial", "complete")]
        temperature, _ = fit_temperature(rows)
        self.assertGreater(temperature, 1)
        self.assertEqual(summary(rows)["all"]["correct"], summary(rows, temperature)["all"]["correct"])
        reverse = deepcopy(rows)
        for r in reverse:
            expected = r["labels"][r["target"]]
            r["labels"].reverse(); r["logits"].reverse()
            r["target"] = r["labels"].index(expected)
        self.assertEqual(order_flips(rows, reverse)["flips"], 0)


if __name__ == "__main__":
    unittest.main()
