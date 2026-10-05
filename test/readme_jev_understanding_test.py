"""Deterministic invariants; fake decisions do not establish model accuracy."""
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/services/readme-lab/python"))
from jev_reader import JevReader
from jev_grounded import GroundedJev
from decision_providers import ProviderError


def inputs(texts, facet="method", notes=(), retractions=()):
    return {"prefix": [{"id": f"u{i+1}", "order": i, "scope_id": "s1", "text": t} for i,t in enumerate(texts)],
        "questions": [], "notes": list(notes), "note_retractions": list(retractions),
        "job": {"requirements": [{"id": "r1", "kind": "duty", "label": "문의 분류와 안내", "quote": "문의 분류와 안내"}],
            "reader_profile": {"criteria": [{"id": "c_r1", "requirement_id": "r1", "label": "문의 분류와 안내", "checks": [{
                "facet": facet, "trigger": "문의 처리 경험 주장", "sufficient": "분류 기준과 안내 방식을 설명",
                "insufficient": "분류했다고만 함", "question": "어떤 기준으로 문의를 분류하고 안내했나요?"}]}]}}}


def note():
    return {"id": "n1", "kind": "evidence", "unit_id": "u1", "text": "제가 안내문을 작성했습니다.",
        "requirement_ids": ["r1"], "evidence_unit_ids": ["u1"]}


class Provider:
    def __init__(self, trigger="no", withdraw=False, reject_audit=False):
        self.trigger, self.withdraw, self.reject_audit = trigger, withdraw, reject_audit
        self.payloads = []

    def ask(self, state, heads):
        self.payloads.append(copy.deepcopy((state, heads)))
        answers = {}
        for k in heads:
            label = self.trigger if k.startswith("trigger_") else "yes"
            if k in ("n1", "withdrawn"): label = "yes" if self.withdraw else "no"
            if k == "grounded" and self.reject_audit: label = "no"
            answers[k] = {"label": label, "confidence": .95}
        return {"answers": answers, "usage": {"input_tokens": 10, "output_tokens": 2}}


class UnderstandingTest(unittest.TestCase):
    def test_method_result_questions_use_posting_wording_and_only_prefix(self):
        for facet in ("method", "result"):
            p=Provider(trigger="yes"); r=JevReader(p); value=inputs(["문의 처리 경험이 있습니다."], facet)
            step=r.step(value)
            self.assertEqual(step["questions"][0]["facet"], facet)
            self.assertEqual(step["questions"][0]["text"], value["job"]["reader_profile"]["criteria"][0]["checks"][0]["question"])
            self.assertEqual(step["evidence"], [])
            self.assertEqual(p.payloads[0][0]["units"], [{"id":"u1","text":value["prefix"][0]["text"]}])

    def test_positive_requires_all_audits_and_never_certifies_hiring(self):
        for rejected in (False, True):
            r=JevReader(Provider(reject_audit=rejected))
            out=r.step(inputs(["서비스가 중단된 문의를 먼저 안내했습니다."]))
            self.assertEqual(len(out["evidence"]), 0 if rejected else 1)
            self.assertEqual(r.diagnostics["evidence_audit_rejected"], int(rejected))
            if not rejected:
                self.assertEqual(out["evidence"][0]["requirement_ids"], ["r1"])
                self.assertNotIn("합격", out["evidence"][0]["text"])
                self.assertNotIn("consistent", r.provider.provider.payloads[-1][1])

    def test_withdrawal_is_exact_once_and_independent_new_evidence_is_allowed(self):
        p=Provider(); r=JevReader(p)
        r.step(inputs(["제가 안내문을 작성했습니다."]))
        p.withdraw=True
        texts=["제가 안내문을 작성했습니다.","정정하면 작성자는 동료입니다."]
        out=r.step(inputs(texts, notes=[note()]))
        self.assertEqual(out["retractions"][0]["note_id"], "n1")
        self.assertEqual([e["unit_id"] for e in out["retractions"][0]["evidence"]], ["u1","u2"])
        self.assertEqual(out["evidence"], [])
        p.withdraw=False
        out=r.step(inputs([*texts,"저는 이용자가 남긴 질문을 분류했습니다."], notes=[note()], retractions=[{"note_id":"n1","at_unit_id":"u2"}]))
        self.assertEqual(out["retractions"], [])
        self.assertEqual(len(out["evidence"]), 1)

    def test_failed_observation_rolls_back_prefix_and_decisions_but_counts_calls(self):
        p=Provider(); original=p.ask
        def ask(state, heads):
            if "grounded" in heads: raise ProviderError("jev_http_401")
            return original(state, heads)
        p.ask=ask; r=JevReader(p)
        with self.assertRaises(ProviderError): r.step(inputs(["문의 내용을 분류했습니다."]))
        self.assertEqual(r.prefix, [])
        self.assertTrue(all(x==0 for x in r.diagnostics.values()))
        self.assertEqual(r.provider.calls, 3)

    def test_later_detail_in_same_experience_is_not_filtered_before_novelty_audit(self):
        p=Provider(); r=JevReader(p)
        r.step(inputs(["제가 문의를 긴급도에 따라 분류했습니다."]))
        out=r.step(inputs(["제가 문의를 긴급도에 따라 분류했습니다.", "취소 절차는 안내문을 작성해 전달했습니다."], notes=[note()]))
        self.assertEqual(len(out["evidence"]), 1)
        self.assertEqual(out["evidence"][0]["evidence"][0]["unit_id"], "u2")
        self.assertIn("new", p.payloads[-1][1])

    def test_missed_correction_is_recovered_from_full_prefix(self):
        p=Provider(); r=JevReader(p)
        texts=["제가 안내문을 작성했습니다.", "정정하면 작성자는 동료입니다."]
        r.step(inputs(texts[:1])); r.step(inputs(texts, notes=[note()]))
        p.withdraw=True
        original=p.ask
        def ask(state, heads):
            value=original(state, heads)
            if set(heads)=={"u2","u3"}:
                value["answers"]["u3"]["label"]="no"
            return value
        p.ask=ask
        out=r.step(inputs([*texts,"행사는 토요일에 끝났습니다."], notes=[note()]))
        self.assertEqual([e["unit_id"] for e in out["retractions"][0]["evidence"]], ["u1","u2","u3"])
        audit=next(state for state,heads in p.payloads if set(heads)=={"u2","u3"})
        self.assertEqual(audit["target_note"]["id"], "n1")

    def test_withdrawal_requires_a_confirmed_correction_source_after_global_flag(self):
        p=Provider(); r=JevReader(p)
        r.step(inputs(["제가 안내문을 작성했습니다."]))
        p.withdraw=True; original=p.ask
        def ask(state, heads):
            value=original(state, heads)
            if set(heads)=={"u2"}: value["answers"]["u2"]["label"]="no"
            return value
        p.ask=ask
        out=r.step(inputs(["제가 안내문을 작성했습니다.","별도 행사의 안내문은 동료가 작성했습니다."], notes=[note()]))
        self.assertEqual(out["retractions"], [])
        self.assertEqual(r.diagnostics["evidence_retracted"], 0)

    def test_pending_same_experience_answer_is_not_presented_as_separate_positive(self):
        p=Provider(); original=p.ask
        def ask(state, heads):
            value=original(state, heads)
            if "consistent" in heads: value["answers"]["consistent"]["label"]="no"
            return value
        p.ask=ask; r=JevReader(p)
        r.step(inputs(["문의 대응을 담당했습니다."]))
        value=inputs(["문의 대응을 담당했습니다.","중단 문의를 먼저 처리했습니다."])
        value["questions"]=[{"id":"q1","unit_id":"u1","scope_id":"s1","criterion_id":"c_r1","facet":"method","text":"분류 기준은 무엇인가요?","status":"open"}]
        with patch("jev_reader.GroundedJev.decide", return_value={"label":"unknown"}):
            out=r.step(value)
        self.assertEqual(out["evidence"], [])
        self.assertEqual(r.diagnostics["evidence_audit_rejected"], 1)

    def test_distributed_method_proof_reaches_complete_audit_together(self):
        reader=GroundedJev(Provider()); audits=[]
        def ask(stage, state, heads, order):
            if stage=="confirm_complete": audits.append(state["proposed_evidence"])
            answers={}
            for k in heads:
                label="same" if k=="scope" else "related" if k=="topic" else "no" if k=="unlinked" or k.startswith("withdraw_") or k=="approach_u0" else "yes"
                answers[k]={"label":label,"confidence":.95}
            return answers
        reader.ask=ask
        case={"facet":"method","question":"어떤 기준으로 분류하고 안내했나요?","sufficient":"분류 기준과 안내 방법 모두 설명", "insufficient":"둘 중 하나만 설명", "units":["문의 대응을 맡았습니다.","서비스 중단 문의를 먼저 처리했습니다.","취소 절차를 안내문으로 전달했습니다."],"current_index":2}
        out=reader.decide(case)
        self.assertEqual(out["label"],"complete")
        self.assertEqual([u["id"] for u in audits[0]], ["u1","u2"])
        self.assertEqual(out["evidence"],audits[0])

    def test_method_and_qualitative_result_do_not_inherit_measurement_facts(self):
        reader=GroundedJev(Provider())
        for facet in ("method","result"):
            facts=reader.conditions({"facet":facet,"sufficient":"공고에 맞는 정성 설명","insufficient":"관련 설명 없음"}, "canonical")
            self.assertFalse({"before","after","comparable","periods"}.intersection(facts))
            self.assertIn("공고에 맞는 정성 설명", next(iter(facts.values()))[0])


if __name__ == "__main__": unittest.main()
