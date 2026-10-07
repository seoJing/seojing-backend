"""Offline protocol/invariant tests. No remote model or credentials."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/services/readme-lab/python"))
from decision_providers import ProviderError
from focus_eval import units_for
from jev_focus_reader import FocusReader, MAX_REQUEST_CHARS, MAX_FALLBACK_RECHECKS
from runtime import choice


class Stub:
    def __init__(self, choose):
        self.choose, self.requests = choose, []

    def ask(self, state, heads):
        self.requests.append((state, heads))
        labels = self.choose(state, heads, len(self.requests))
        return {"answers": {k: {"label": labels.get(k, "no"), "confidence": .99,
                 "probabilities": {c: float(c == labels.get(k, "no")) for c in h["criteria"]}}
                 for k, h in heads.items()}, "usage": {"input_tokens": 10, "output_tokens": 2}}


class FocusInvariantTest(unittest.TestCase):
    def test_failed_later_call_rolls_back_semantics_but_not_spend(self):
        def choose(state, heads, call):
            if call == 2:
                raise ProviderError("jev_timeout")
            return {k: "new" if k == "context" else "none" if k == "kind" else "yes" if k == "ask_role" else "no" for k in heads}
        reader = FocusReader(Stub(choose))
        before = reader.snapshot()
        with self.assertRaises(ProviderError):
            reader.step({"prefix": units_for(["팀에서 개발에 참여했습니다."]), "role_context": "개발"})
        self.assertEqual(reader.snapshot(), before)
        self.assertEqual(reader.metrics()["calls"], 2)
        self.assertEqual(reader.metrics()["input_tokens"], 10)
        self.assertTrue(all(v == 0 for v in reader.diagnostics.values()))

    def test_long_positive_retrieval_keeps_old_proof_and_current(self):
        reader = FocusReader(Stub(lambda *args: {}))
        reader.prefix = units_for(["설명" * 75 for _ in range(80)])
        context = {"source_unit_ids": [u["id"] for u in reader.prefix], "heading_unit_id": "u1"}
        sources = reader._working_sources(context, reader.prefix[-1], ["u2", "u5"])
        self.assertTrue({"u1", "u2", "u5", "u80"}.issubset({s["unit_id"] for s in sources}))
        self.assertLessEqual(sum(len(s["text"]) for s in sources), 8000)
        self.assertIsNone(reader._working_sources(context, reader.prefix[-1], complete=True))

    def test_cross_page_answer_components_are_not_misread_as_absence(self):
        provider = Stub(lambda state, heads, _: {k: "no" if k in ("answered", "comparison_checked") else "yes" for k in heads})
        reader = FocusReader(provider)
        reader.prefix = units_for(["비교 전 평균 800ms. " + "측정 설명 " * 25] + ["다른 활동 설명 " * 20 for _ in range(60)] + ["비교 후 같은 조건의 평균 400ms.", "평균 응답 시간이 줄었습니다."])
        context = {"id": "c1", "source_unit_ids": [u["id"] for u in reader.prefix], "heading_unit_id": None}
        self.assertFalse(reader._new_question("basis", context, reader.prefix[-1], []))
        self.assertEqual(reader.questions, [])
        self.assertTrue(any("component" in heads for _, heads in provider.requests))

    def test_chunk_budget_checks_actual_payload_and_preserves_every_head(self):
        provider = Stub(lambda *args: {})
        reader = FocusReader(provider)
        heads = {"h" + str(i): choice("독해 정책 " * 100, {"yes": "Yes", "no": "No"}) for i in range(60)}
        answers = reader._ask({"source": "원문 " * 1000}, heads)
        self.assertEqual(set(answers), set(heads))
        self.assertGreater(len(provider.requests), 1)
        for state, chunk in provider.requests:
            self.assertLessEqual(len(json.dumps({"state": state, "questions": chunk}, ensure_ascii=False)), MAX_REQUEST_CHARS)

    def test_prefix_and_role_context_cannot_be_replaced(self):
        reader = FocusReader(Stub(lambda *args: {}))
        units = units_for(["# 제목", "# 둘째 제목"])
        reader.step({"prefix": units[:1], "role_context": "직무"})
        with self.assertRaises(ValueError):
            reader.step({"prefix": units, "role_context": "새 지시문"})
        changed = json.loads(json.dumps(units)); changed[0]["text"] = "수정된 제목"
        with self.assertRaises(ValueError):
            reader.step({"prefix": changed, "role_context": "직무"})
        self.assertEqual(len(reader.prefix), 1)


class DiscoveryAndRecheckTest(unittest.TestCase):
    """Force routing mistakes; verify guards and event ordering independently of model quality."""
    def run_reader(self, *, relation="none", same="yes", proof=True, explicit=False,
                   second_question=True, second_claim=True, context_missing=False, cap=False):
        def choose(state, heads, _):
            uid = state.get("current", {}).get("unit_id")
            if "context" in heads:
                return {k: (
                    ("none" if context_missing and uid == "u3" else "c1" if state["contexts"] else "new") if k == "context" else
                    "none" if k == "kind" else
                    "answer" if k.startswith("q_") and explicit else
                    "none" if k.startswith("q_") else
                    "yes" if (k == "ask_basis" and uid == "u2") or (k == "ask_reason" and uid == "u3" and second_question) else "no"
                ) for k in heads}
            if "claim" in heads:
                return {k: "yes" if k == "claim" and (uid == "u2" or second_claim) else "no" for k in heads}
            if "same" in heads:
                return {k: same if k == "same" else "yes" if k == relation else "no" for k in heads}
            if "scope" in heads:
                return {"scope": "same"}
            return {k: "yes" if proof and k == "proof_" + str(uid) else "no" for k in heads}
        provider = Stub(choose)
        reader = FocusReader(provider)
        units = units_for(["# 합성 경험", "처리 오류를 줄였습니다.", "이 도구에서 다른 저장 방식을 선택했습니다."])
        trace = [reader.step({"prefix": units[:i], "role_context": "synthetic"}) for i in (1, 2)]
        if cap:
            reader.diagnostics["fallback_rechecks"] = MAX_FALLBACK_RECHECKS
        trace.append(reader.step({"prefix": units, "role_context": "synthetic"}))
        return reader, trace

    def test_active_inquiry_does_not_block_new_facet(self):
        reader, trace = self.run_reader()
        self.assertEqual([(q["facet"], q["focus"]) for q in reader.questions], [("basis", "parked"), ("reason", "active")])
        kinds = [e["type"] for e in trace[-1]["events"]]
        self.assertLess(kinds.index("parked"), kinds.index("inquiry"))
        self.assertEqual(reader.diagnostics["accepted_questions"], 2)

    def test_answer_update_does_not_block_new_claim(self):
        reader, trace = self.run_reader(relation="complete")
        self.assertEqual([q["status"] for q in reader.questions], ["resolved", "open"])
        self.assertEqual(reader.questions[0]["evidence"][0]["unit_id"], "u3")
        self.assertEqual(reader.diagnostics["fallback_updates"], 1)
        self.assertTrue(any(e["type"] == "inquiry" for e in trace[-1]["events"]))

    def test_partial_then_park_preserves_update_and_final_speech(self):
        reader, trace = self.run_reader(relation="partial")
        events = trace[-1]["events"]
        self.assertEqual(reader.questions[0]["status"], "partial")
        self.assertEqual(reader.questions[0]["focus"], "parked")
        update = next(e for e in events if e["type"] == "updated")
        self.assertEqual(update["question"]["evidence"][0]["unit_id"], "u3")
        self.assertEqual([e["code"] for e in events if e["type"] == "speech" and e.get("question_id") == "q1"], ["parked"])

    def test_rejected_candidate_keeps_existing_focus(self):
        reader, _ = self.run_reader(second_claim=False)
        self.assertEqual(len(reader.questions), 1)
        self.assertEqual(reader.active_question_id, "q1")
        self.assertEqual(reader.diagnostics["unsupported_claim"], 1)

    def test_weak_route_and_missing_context_still_get_adjacent_recheck(self):
        reader, _ = self.run_reader(relation="complete", second_question=False, context_missing=True)
        self.assertEqual(reader.questions[0]["status"], "resolved")
        self.assertEqual(reader.diagnostics["fallback_rechecks"], 1)

    def test_fallback_never_overrides_same_experience_or_current_proof_guards(self):
        for overrides, reason in [({"same": "no"}, "different_or_uncertain_experience"),
                                  ({"proof": False}, "missing_current_proof")]:
            with self.subTest(reason=reason):
                reader, _ = self.run_reader(relation="complete", second_question=False, **overrides)
                self.assertEqual(reader.questions[0]["status"], "open")
                self.assertEqual(reader.diagnostics[reason], 1)

    def test_explicit_candidate_is_not_reviewed_twice(self):
        reader, _ = self.run_reader(relation="complete", second_question=False, explicit=True)
        self.assertEqual(reader.metrics()["retrievals"], 1)
        self.assertEqual(reader.diagnostics["explicit_rechecks"], 1)
        self.assertEqual(reader.diagnostics["fallback_rechecks"], 0)

    def test_optional_recheck_cap_is_observable_without_failing_reading(self):
        reader, _ = self.run_reader(second_question=False, cap=True)
        self.assertEqual(reader.diagnostics["fallback_budget_skipped"], 1)
        self.assertEqual(reader.metrics()["limited"], 0)
        self.assertEqual(len(reader.prefix), 3)

    def test_fallback_rotates_and_never_uses_a_new_heading_as_identity(self):
        reader, _ = self.run_reader()
        reader.last_review_order = {"q1": 3, "q2": 2}
        self.assertEqual([q["id"] for q in reader._fallback_candidates(reader.prefix[-1], "c1", set())], ["q2", "q1"])
        reader.heading_id = "different-heading"
        self.assertEqual(reader._fallback_candidates(reader.prefix[-1], None, set()), [])

    def test_oversized_first_fallback_cannot_starve_the_next_question(self):
        reader, _ = self.run_reader()
        reader.last_review_order = {}
        # Force a bounded-source miss for the oldest question only. The
        # following window must give the independently viable q2 its turn.
        original = reader._working_sources
        reader._working_sources = lambda context, current, extra=None, complete=False: (
            None if extra and extra[0] == "u2" else original(context, current, extra, complete))
        for i in (4, 5):
            units = units_for(["# 합성 경험", "처리 오류를 줄였습니다.", "다른 저장 방식을 선택했습니다."] + ["같은 경험의 배경입니다."] * (i - 3))
            # Keep the accepted prefix byte-for-byte identical.
            units[:len(reader.prefix)] = reader.prefix
            reader.step({"prefix": units, "role_context": "synthetic"})
        self.assertEqual(reader.diagnostics["fallback_source_skipped"], 1)
        self.assertEqual(reader.last_review_order, {"q1": 3, "q2": 4})



if __name__ == "__main__":
    unittest.main()
