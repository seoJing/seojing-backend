"""Composition, causal input and provider isolation tests. No live model/API."""
from copy import deepcopy
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/services/readme-lab/python"))
from atomic_decisions import combine, questions_for, state_for
from decision_eval import load_cases, main, run_one, summarize
from decision_context_probe import extended_case, main as context_main
from decision_providers import JevProvider, NoRedirect, ProviderError, normalize


class AtomicTests(unittest.TestCase):
    def setUp(self):
        self.data = load_cases(Path(__file__).parent / "fixtures/readme/atomic-decisions-v1.json")
        self.case = deepcopy(self.data["cases"][0])

    def answers(self):
        return {k: {"label": v, "confidence": 1} for k, v in self.case["expected_facts"].items()}

    def test_suffix_labels_and_metadata_never_reach_state(self):
        original = state_for(self.case)
        self.case["units"].append("FUTURE CANARY: the answer is complete")
        self.case.update(expected=["unknown"], expected_facts={}, secret_metadata="canary")
        self.assertEqual(original, state_for(self.case))
        self.assertNotIn("canary", json.dumps(original))
        self.assertEqual(set(original), {"question", "sufficient", "insufficient", "original", "current", "evidence"})

    def test_long_input_control_preserves_answer_and_only_adds_prior_text(self):
        for count in (2, 40, 80, 160):
            case = extended_case(self.case, count)
            self.assertEqual(len(case["units"]), count)
            self.assertEqual(case["current_index"], count - 1)
            state = state_for(case)
            self.assertEqual(state["current"], state_for(self.case)["current"])
            self.assertEqual(state["original"], state_for(self.case)["original"])
            self.assertEqual(len(state["evidence"]), count - 2)

    def test_uncertainty_does_not_become_missing(self):
        for key in ("scope", "revision", "topic", "personal"):
            answers = self.answers()
            answers[key]["confidence"] = .1
            result = combine("atomic", "role", answers)
            self.assertEqual(result["label"], "unknown")
            self.assertEqual(result["missing"], [])

    def test_known_missing_and_explicit_denial_stay_distinct(self):
        for label in ("not_stated", "denied"):
            answers = self.answers()
            answers["performed"]["label"] = label
            result = combine("atomic", "role", answers)
            self.assertEqual(result["label"], "partial")
            self.assertEqual(result["missing"], [{"head": "performed", "reason": label}])

    def test_different_experience_never_resolves_or_retracts(self):
        answers = self.answers()
        answers["scope"]["label"] = "different"
        answers["revision"]["label"] = "contradicts"
        self.assertEqual(combine("atomic", "role", answers)["label"], "unrelated")

    def test_conflict_precedes_completeness(self):
        answers = self.answers()
        answers["revision"]["label"] = "contradicts"
        self.assertEqual(combine("atomic", "role", answers)["label"], "conflict")

    def test_unrelated_fact_correction_does_not_retract_answer(self):
        answers = self.answers()
        answers["topic"]["label"] = "unrelated"
        answers["revision"]["label"] = "contradicts"
        result = combine("atomic", "role", answers)
        self.assertEqual(result["label"], "unrelated")
        self.assertNotIn("revision", result["used_heads"])

    def test_order_reverses_without_changing_semantic_keys(self):
        for design in ("current", "atomic"):
            original = questions_for(design, "basis")
            reverse = questions_for(design, "basis", "reversed")
            for key in original:
                self.assertEqual(original[key], reverse[key])
                self.assertEqual(list(original[key]["criteria"]), list(reversed(reverse[key]["criteria"])))

    def test_all_oracle_facts_compose_to_allowed_relation(self):
        # This checks the deterministic table; it does not validate model quality.
        for case in self.data["cases"]:
            answer = {k: {"label": v, "confidence": 1} for k, v in case["expected_facts"].items()}
            self.assertIn(combine("atomic", case["facet"], answer)["label"], case["expected"])

    def test_provider_failure_is_not_a_successful_unknown(self):
        class Failed:
            def ask(self, state, questions):
                raise ProviderError("jev_timeout")
        row = run_one(Failed(), self.case, "atomic", "canonical")
        group = next(g for g in summarize([row])["groups"] if g["design"] == "atomic" and g["order"] == "canonical")
        self.assertNotIn("gated", row)
        self.assertEqual((group["errors"], group["missed_complete"], group["accepted"]), (1, 1, 0))

    def test_remote_warmup_failure_stops_before_any_more_paid_calls(self):
        class Failed:
            metadata = {"provider": "jev"}
            calls = 0

            def ask(self, state, questions):
                self.calls += 1
                raise ProviderError("jev_timeout")
        failed = Failed()
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "new-run"
            args = ["decision_eval.py", "--provider", "jev", "--allow-remote", "--data",
                    str(Path(__file__).parent / "fixtures/readme/atomic-decisions-v1.json"),
                    "--out", str(out), "--load-counts", "80"]
            with patch.object(sys, "argv", args), patch("decision_eval.JevProvider", return_value=failed), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(), 1)
            result = json.loads((out / "run.json").read_text())
            self.assertFalse(result["completed"])
            self.assertEqual(result["load_workloads"], [])
        self.assertEqual(failed.calls, 1)

    def test_remote_context_failure_stops_without_local_provider_fallback(self):
        class Failed:
            metadata = {"provider": "jev"}
            calls = 0

            def ask(self, state, questions):
                self.calls += 1
                raise ProviderError("jev_timeout")
        failed = Failed()
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "context-run"
            args = ["decision_context_probe.py", "--provider", "jev", "--allow-remote", "--data",
                    str(Path(__file__).parent / "fixtures/readme/atomic-decisions-v1.json"), "--out", str(out)]
            with patch.object(sys, "argv", args), patch("decision_context_probe.JevProvider", return_value=failed), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(context_main(), 1)
            result = json.loads((out / "run.json").read_text())
            self.assertFalse(result["completed"])
            self.assertEqual(len(result["rows"]), 1)
            self.assertIsNone(result["rows"][0]["state_stats"])
            self.assertIsNone(result["rows"][0]["token_guard_rejected"])
        self.assertEqual(failed.calls, 1)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.questions = {"q": {"type": "choice", "instructions": "Choose.", "criteria": {"a": "first", "b": "second"}}}
        self.payload = {"model": "jev-1.13.0", "answers": {"q": {"type": "choice", "choice": "a",
            "confidence": .8, "probabilities": {"a": .9, "b": .1}}}, "usage": {"input_tokens": 12, "output_tokens": 4}}

    def provider(self):
        with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test-key"}):
            return JevProvider(True)

    def test_explicit_flag_and_key_are_both_required(self):
        with self.assertRaisesRegex(ProviderError, "explicit_remote"):
            JevProvider()
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ProviderError, "key_missing"):
            JevProvider(True)

    def test_invalid_probability_or_label_fails_closed(self):
        for field, value in (("choice", "invented"), ("confidence", float("nan")), ("confidence", True),
                             ("probabilities", {"a": .5, "b": .1}), ("probabilities", {"a": .1, "b": .9})):
            payload = deepcopy(self.payload)
            payload["answers"]["q"][field] = value
            with self.assertRaises(ProviderError):
                normalize(payload, self.questions, "jev")

    def test_response_is_allowlisted_and_model_and_usage_validated(self):
        provider = self.provider()
        self.payload["debug"] = "must-not-be-retained"
        with patch.object(provider.opener, "open", return_value=io.BytesIO(json.dumps(self.payload).encode())) as call:
            result = provider.ask({"current": "synthetic"}, self.questions)
        self.assertNotIn("must-not-be-retained", json.dumps(result))
        request = call.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.typesafe.ai/v1/systemone")
        self.assertEqual(call.call_args.kwargs["timeout"], 30)
        for field, value in (("model", "jev-latest"), ("usage", {"input_tokens": True, "output_tokens": 0})):
            payload = dict(self.payload, **{field: value})
            with patch.object(provider.opener, "open", return_value=io.BytesIO(json.dumps(payload).encode())):
                with self.assertRaises(ProviderError):
                    provider.ask({}, self.questions)

    def test_remote_error_never_exposes_raw_details(self):
        provider = self.provider()
        with patch.object(provider.opener, "open", side_effect=ValueError("test-key private source")):
            with self.assertRaises(ProviderError) as caught:
                provider.ask({}, self.questions)
        self.assertEqual(str(caught.exception), "jev_request_or_response_failed")

    def test_redirect_cannot_forward_authorization(self):
        with self.assertRaisesRegex(ProviderError, "redirect_rejected"):
            NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid")


if __name__ == "__main__":
    unittest.main()
