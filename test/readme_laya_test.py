"""Training-data contract tests; no model load or network access."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/services/readme-lab/python"))
from train import read_rows


class TrainingDataTests(unittest.TestCase):
    def setUp(self):
        self.rows = [json.loads(line) for line in (Path(__file__).parent / "fixtures/readme/laya-smoke.jsonl").read_text().splitlines()]

    def check_rows(self, rows, smoke):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.jsonl"
            path.write_text("\n".join(json.dumps(row) for row in rows))
            return read_rows(path, smoke)

    def test_smoke_is_explicit_and_not_production_training(self):
        self.assertEqual(len(self.check_rows(self.rows, True)), 10)
        with self.assertRaisesRegex(ValueError, "human_review_required"):
            self.check_rows(self.rows, False)

    def test_group_overlap_is_rejected(self):
        self.rows[-1]["group_id"] = self.rows[0]["group_id"]
        with self.assertRaisesRegex(ValueError, "group_split_leakage"):
            self.check_rows(self.rows, True)

    def test_unknown_labels_are_rejected(self):
        self.rows[0]["labels"]["signal"] = "hire"
        with self.assertRaisesRegex(ValueError, "invalid_label"):
            self.check_rows(self.rows, True)

    def test_missing_validation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "both_splits_required"):
            self.check_rows([row for row in self.rows if row["split"] == "train"], True)

    def test_reader_v2_labels_still_require_explicit_review(self):
        rows = [{"id": "a", "group_id": "one", "split": "train", "kind": "reader_relation",
                 "state": {"current": "개인 역할 설명"}, "labels": {"scope": "same", "relation": "complete"}, "synthetic_smoke": True},
                {"id": "b", "group_id": "two", "split": "validation", "kind": "reader_relation",
                 "state": {"current": "다른 경험 설명"}, "labels": {"scope": "different", "relation": "unrelated"}, "synthetic_smoke": True}]
        self.assertEqual(len(self.check_rows(rows, True)), 2)
        with self.assertRaisesRegex(ValueError, "human_review_required"):
            self.check_rows(rows, False)
        rows[0]["labels"]["relation"] = "answers"
        with self.assertRaisesRegex(ValueError, "invalid_label"):
            self.check_rows(rows, True)

    def test_content_relabelled_with_different_group_still_cannot_cross_split(self):
        copied = dict(self.rows[0], id="copy", group_id="different-group", split="validation")
        with self.assertRaisesRegex(ValueError, "content_split_leakage"):
            self.check_rows(self.rows + [copied], True)

    def test_template_family_cannot_cross_split(self):
        self.rows[0]["template_family"] = "template-one"
        self.rows[-1]["template_family"] = "template-one"
        with self.assertRaisesRegex(ValueError, "template_split_leakage"):
            self.check_rows(self.rows, True)

    def test_conflicting_labels_on_same_input_are_rejected(self):
        copied = dict(self.rows[0], id="conflict", labels={"signal": "context", "missing": "none"})
        with self.assertRaisesRegex(ValueError, "conflicting_labels_for_same_input"):
            self.check_rows(self.rows + [copied], True)


if __name__ == "__main__":
    unittest.main()
