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
from jev_understanding import note_text, WORDING


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
            if k in ("invalidated", "overclaims_answer", "duplicate"): label = "no"
            if k in ("n1", "withdrawn"): label = "yes" if self.withdraw else "no"
            if k == "grounded" and self.reject_audit: label = "no"
            answers[k] = {"label": label, "confidence": .95}
        return {"answers": answers, "usage": {"input_tokens": 10, "output_tokens": 2}}


class UnderstandingTest(unittest.TestCase):
    def focused(self, focus, link=False, duplicate=False):
        p=Provider(); original=p.ask
        def ask(state, heads):
            value=original(state, heads)
            for key in heads:
                if key.startswith("focus_"):
                    value["answers"][key]["label"]="yes" if key=="focus_"+focus else "no"
                if "prior_note_anchors" in state:
                    value["answers"][key]["label"]="yes" if link and not key.startswith("context_") else "no"
                if key=="new" and duplicate: value["answers"][key]["label"]="no"
            return value
        p.ask=ask
        return p

    def test_routes_overlap_by_confidence_and_does_not_treat_topic_as_full_qualification(self):
        p=self.focused("method"); original=p.ask
        def ask(state, heads):
            v=original(state, heads)
            if "focus_boundary" in heads: v["answers"]["focus_boundary"]={"label":"yes","confidence":.76}
            return v
        p.ask=ask; r=JevReader(p)
        result=r.step(inputs(["급한 문의부터 확인하고 처리 절차를 안내했습니다."]))
        self.assertTrue(result["evidence"][0]["text"].startswith("수행 방식:"))
        state,heads=p.payloads[-1]
        self.assertEqual(state["proposed_evidence"],result["evidence"][0]["evidence"])
        self.assertTrue(result["evidence"][0]["text"].startswith(state["proposed_text"] + " 공고의 "))
        self.assertNotIn("new", heads)  # No earlier note can be duplicated.

    def test_self_contained_preparation_does_not_attach_application_question_as_factual_context(self):
        p=self.focused("preparation"); original=p.ask
        def ask(state,heads):
            value=original(state,heads)
            if "needs_context" in heads: value["answers"]["needs_context"]={"label":"no","confidence":.95}
            return value
        p.ask=ask;r=JevReader(p)
        texts=["지원 이유와 준비 경험을 설명해 주세요.","통계 수업을 수강하고 연습 문제를 풀었습니다."]
        r.step(inputs(texts[:1]))
        result=r.step(inputs(texts))
        card=result["evidence"][0]
        self.assertIn("학습과 준비",card["text"])
        self.assertIn("실무 수행 경력과는 구분",card["text"])
        self.assertEqual([e["unit_id"] for e in card["evidence"]],["u2"])
        self.assertFalse(any("context_u1" in heads for _,heads in p.payloads))

    def test_pending_question_does_not_block_independent_source_but_overclaim_still_fails(self):
        from jev_understanding import observations
        from jev_reader import proof
        for label,confidence,expected in [("no",.95,1),("yes",.95,0),("no",.74,0)]:
            p=self.focused("role"); original=p.ask
            def ask(state,heads):
                value=original(state,heads)
                if "overclaims_answer" in heads:value["answers"]["overclaims_answer"]={"label":label,"confidence":confidence}
                if "needs_context" in heads:value["answers"]["needs_context"]={"label":"no","confidence":.95}
                return value
            p.ask=ask;data=inputs(["연구 목표가 있었습니다.","별개 봉사 활동에서 참여자에게 그리는 방법을 알려 주었습니다."])
            data["questions"]=[{"id":"q1","status":"open","text":"그 연구 목표를 정한 이유가 무엇인가요?"}]
            result={"questions":[],"updates":[],"evidence":[],"retractions":[]}
            observations(data,p,result,proof,JevReader(p).diagnostics)
            self.assertEqual(len(result["evidence"]),expected)
            self.assertNotIn("consistent",p.payloads[-1][1])

    def test_plan_and_boundary_wording_keep_their_limits(self):
        for focus,source,copy in [
            ("plan","앞으로 문의 안내문을 정리하고 싶습니다.","이미 수행한 경험이나 달성한 성과로 읽지는 않습니다"),
            ("boundary","승인은 책임자가 맡았고 저는 안내만 했습니다.","다른 담당자의 수행·결정 책임"),
            ("experience","교육센터에서 수강 문의 안내 업무를 맡았습니다.","구체적 역할이나 성과까지 확인한 뜻은 아닙니다"),
        ]:
            r=JevReader(self.focused(focus))
            result=r.step(inputs([source]))
            self.assertIn(copy,result["evidence"][0]["text"])
            self.assertEqual(result["questions"],[])
            self.assertEqual(result["updates"],[])

    def test_answer_fragment_updates_its_question_without_standalone_positive(self):
        from jev_understanding import observations
        from jev_reader import proof
        p=self.focused("role"); data=inputs(["행사 운영에 참여했습니다.","저는 회차별 안내문을 작성했습니다."], "role")
        data["questions"]=[{"id":"q1","unit_id":"u1","status":"open","criterion_id":"c_r1","facet":"role","text":"행사에서 직접 맡은 역할과 진행 방법은 무엇인가요?"}]
        result={"questions":[],"updates":[],"evidence":[],"retractions":[]}
        observations(data,p,result,proof,JevReader(p).diagnostics)
        self.assertEqual(result["evidence"],[])
        self.assertEqual([(u["question_id"],u["relation"]) for u in result["updates"]],[("q1","partial")])
        self.assertEqual([e["unit_id"] for e in result["updates"][0]["evidence"]],["u1","u2"])
        state,heads=next((state,heads) for state,heads in reversed(p.payloads) if "answer_q1" in heads)
        self.assertEqual(state["pending_question_origins"][0]["source"]["id"],"u1")
        self.assertIn("actual/planned",heads["answer_q1"]["instructions"])
        final_state,final_heads=p.payloads[-1]
        self.assertEqual(set(final_heads),{"grounded"})
        self.assertEqual(final_state["proposed_text"],result["updates"][0]["text"])
        self.assertEqual(final_state["proposed_evidence"],result["updates"][0]["evidence"])
        self.assertNotIn("sources",final_state)
        self.assertNotIn("prior_notes",final_state)
        self.assertEqual(final_state["question"]["facet"],"role")
        self.assertIn("한 가지",final_state["question"]["sufficient"])

    def test_compact_fact_audit_cannot_borrow_unquoted_source_or_generic_note(self):
        p=self.focused("role");r=JevReader(p)
        r.step(inputs(["다른 행사에 관한 배경 설명입니다."]))
        out=r.step(inputs(["다른 행사에 관한 배경 설명입니다.","저는 안내문을 작성했습니다."]))
        state,heads=p.payloads[-1]
        self.assertEqual(set(heads),{"grounded"})
        self.assertEqual([e["unit_id"] for e in state["proposed_evidence"]],["u2"])
        self.assertTrue(out["evidence"][0]["text"].startswith(state["proposed_text"] + " 공고의 "))
        self.assertNotIn("selected_criterion",state)
        full_state,full_heads=next((s,h) for s,h in reversed(p.payloads) if "relevant" in h)
        self.assertEqual(full_state["proposed_text"],out["evidence"][0]["text"])
        self.assertIn("invalidated",full_heads)
        self.assertNotIn("sources",state)
        self.assertNotIn("prior_notes",state)
        self.assertIsNone(state["question"])

    def test_link_state_deduplicates_context_without_dropping_exact_sources_or_anchors(self):
        p=self.focused("method",link=True);r=JevReader(p)
        r.step(inputs(["저는 일정표를 작성했습니다."]))
        data=inputs(["저는 일정표를 작성했습니다.","일정표에는 담당 요일을 표시했습니다."],notes=[note()])
        out=r.step(data)
        state,heads=next((s,h) for s,h in p.payloads if "prior_note_anchors" in s)
        self.assertEqual(state["sources"],[{"id":u["id"],"text":u["text"]} for u in data["prefix"]])
        self.assertEqual(state["prior_note_anchors"]["n1"],state["sources"][0])
        self.assertNotIn("context_candidates",state)
        self.assertNotIn("prior_notes",state)
        self.assertIn("prior_note_anchors[n1]",heads["n1"]["instructions"])
        self.assertEqual([e["unit_id"] for e in out["evidence"][0]["evidence"]],["u1","u2"])

    def test_partial_routing_needs_accepted_answer_relation_and_all_factual_audits(self):
        from jev_understanding import observations
        from jev_reader import proof
        # These are routing invariants, not evidence of model semantics: an
        # unrelated/uncertain relation cannot create a partial; bad facts block both.
        for answer,confidence,grounded,updates,notes in [
            ("no",.95,True,0,1),("yes",.74,True,0,1),
            ("unclear",.95,True,0,1),("yes",.95,False,0,0),
        ]:
            p=self.focused("plan"); original=p.ask
            def ask(state,heads):
                out=original(state,heads)
                if "answer_q1" in heads:out["answers"]["answer_q1"]={"label":answer,"confidence":confidence}
                if "grounded" in heads:out["answers"]["grounded"]["label"]="yes" if grounded else "no"
                return out
            p.ask=ask;data=inputs(["행사를 운영했습니다.","다음 봉사에서는 제가 안내문을 만들 계획입니다."], "role")
            data["questions"]=[{"id":"q1","unit_id":"u1","status":"open","criterion_id":"c_r1","facet":"role","text":"행사에서 직접 한 일은 무엇인가요?"}]
            result={"questions":[],"updates":[],"evidence":[],"retractions":[]}
            observations(data,p,result,proof,JevReader(p).diagnostics)
            self.assertEqual(len(result["updates"]),updates)
            self.assertEqual(len(result["evidence"]),notes)

    def test_partial_routing_selects_one_pending_question_and_leaves_resolved_or_reopened_alone(self):
        from jev_understanding import observations
        from jev_reader import proof
        p=self.focused("role"); original=p.ask
        def ask(state,heads):
            out=original(state,heads)
            if "answer_q1" in heads:out["answers"]["answer_q1"]={"label":"yes","confidence":.8}
            if "answer_q2" in heads:out["answers"]["answer_q2"]={"label":"yes","confidence":.95}
            return out
        p.ask=ask;data=inputs(["행사를 운영했습니다.","안내문은 제가 작성했습니다."])
        data["questions"]=[{"id":f"q{i}","unit_id":"u1","status":status,"criterion_id":"c_r1","facet":"method","text":"직접 맡은 일은 무엇인가요?"}
                           for i,status in enumerate(("open","partial","resolved","reopened"),1)]
        result={"questions":[],"updates":[],"evidence":[],"retractions":[]}
        observations(data,p,result,proof,JevReader(p).diagnostics)
        self.assertEqual([u["question_id"] for u in result["updates"]],["q2"])
        self.assertEqual(result["evidence"],[])
        heads=p.payloads[-1][1]
        self.assertNotIn("answer_q3",heads)
        self.assertNotIn("answer_q4",heads)

    def test_partial_extension_preserves_prior_proof_only_after_retained_audit(self):
        from jev_understanding import observations
        from jev_reader import proof
        for label,confidence,should_update in [("yes",.95,True),("no",.95,False),("yes",.74,False)]:
            p=self.focused("method");original=p.ask
            def ask(state,heads):
                out=original(state,heads)
                if "retained_q1" in heads:out["answers"]["retained_q1"]={"label":label,"confidence":confidence}
                return out
            p.ask=ask;data=inputs(["문의 안내를 개선했습니다.","긴급도를 기준으로 분류했습니다.","유형별 안내문을 작성했습니다."])
            data["questions"]=[{"id":"q1","unit_id":"u1","status":"partial","criterion_id":"c_r1","facet":"method",
                                "text":"어떤 기준으로 문의를 분류하고 안내했나요?","evidence_unit_ids":["u2"]}]
            result={"questions":[],"updates":[],"evidence":[],"retractions":[]}
            observations(data,p,result,proof,JevReader(p).diagnostics)
            self.assertEqual(bool(result["updates"]),should_update)
            if should_update:
                self.assertEqual([e["unit_id"] for e in result["updates"][0]["evidence"]],["u1","u2","u3"])
            self.assertEqual(result["evidence"],[])
            state,heads=next((state,heads) for state,heads in reversed(p.payloads) if "retained_q1" in heads)
            self.assertIn("retained_q1",heads)
            self.assertEqual([u["id"] for u in state["question_context"]["q1"]["existing_evidence"]],["u2"])
            self.assertEqual(state["question_context"]["q1"]["sufficient"],data["job"]["reader_profile"]["criteria"][0]["checks"][0]["sufficient"])

    def test_partial_extension_never_truncates_existing_proof_to_fit_limit(self):
        from jev_understanding import observations
        from jev_reader import proof
        p=self.focused("method");data=inputs([f"문의 처리 단계 {i}를 수행했습니다." for i in range(7)])
        data["questions"]=[{"id":"q1","unit_id":"u1","status":"partial","criterion_id":"c_r1","facet":"method",
                            "text":"문의 처리 단계는 무엇인가요?","evidence_unit_ids":["u2","u3","u4","u5","u6"]}]
        result={"questions":[],"updates":[],"evidence":[],"retractions":[]}
        observations(data,p,result,proof,JevReader(p).diagnostics)
        self.assertEqual(result["updates"],[])
        self.assertEqual(data["questions"][0]["evidence_unit_ids"],["u2","u3","u4","u5","u6"])

    def test_link_uses_only_prior_anchor_and_current_not_recursive_note_proof(self):
        p=self.focused("method",link=True);r=JevReader(p)
        texts=["문의 안내를 맡았습니다.","저는 취소 절차를 정리했습니다.","취소 접수 순서대로 절차를 안내했습니다."]
        r.step(inputs(texts[:1]));r.step(inputs(texts[:2]))
        prior={**note(),"unit_id":"u2","evidence_unit_ids":["u1","u2"]}
        result=r.step(inputs(texts,notes=[prior]))
        card=result["evidence"][0]
        self.assertEqual([e["unit_id"] for e in card["evidence"]],["u2","u3"])
        self.assertIn("이해가 구체화",card["text"])
        self.assertEqual(r.diagnostics["evidence_linked"],1)
        self.assertTrue(any("linked" in heads for _,heads in p.payloads))

    def test_different_experience_can_make_independent_note_without_linking(self):
        p=self.focused("role",link=False);r=JevReader(p)
        r.step(inputs(["센터에서 문의 안내를 맡았습니다."]))
        result=r.step(inputs(["센터에서 문의 안내를 맡았습니다.","별개 도서관에서는 제가 예약 문의를 안내했습니다."],notes=[note()]))
        self.assertEqual([e["unit_id"] for e in result["evidence"][0]["evidence"]],["u2"])
        self.assertNotIn("앞서 연결한",result["evidence"][0]["text"])

    def test_uncertain_novelty_uses_only_displayed_ledger_once_but_never_retries_known_duplicate(self):
        for confidence,expected in [(.4,1),(.95,0)]:
            p=self.focused("role"); original=p.ask
            def ask(state,heads):
                v=original(state,heads)
                if "new" in heads:
                    v["answers"]["new"]={"label":"no","confidence":confidence}
                return v
            p.ask=ask;r=JevReader(p)
            r.step(inputs(["제가 안내문을 작성했습니다."]))
            out=r.step(inputs(["제가 안내문을 작성했습니다.","다른 교육 행사에서는 취소 접수 순서를 안내했습니다."],notes=[note()]))
            self.assertEqual(len(out["evidence"]),expected)
            focused=[state for state,heads in p.payloads if set(heads)=={"duplicate"}]
            self.assertEqual(len(focused),expected)
            if focused:
                self.assertNotIn("sources",focused[0])
                self.assertEqual(len(focused[0]["source_context"]),2)
                self.assertEqual(focused[0]["prior_note_sources"][0]["note_id"],"n1")

    def test_rephrased_information_is_not_a_new_note_despite_relevance(self):
        p=self.focused("role",duplicate=True);r=JevReader(p)
        r.step(inputs(["제가 문의 안내를 맡았습니다."]))
        result=r.step(inputs(["제가 문의 안내를 맡았습니다.","문의 안내 담당자는 저였습니다."],notes=[note()]))
        self.assertEqual(result["evidence"],[])
        self.assertEqual(r.diagnostics["evidence_repeated"],1)

    def test_focused_duplicate_check_keeps_confident_no_and_all_other_gates_required(self):
        for label,confidence,expected in [("no",.95,1),("no",.4,0),("unclear",.95,0),("yes",.95,0)]:
            p=self.focused("role"); original=p.ask
            def ask(state,heads):
                value=original(state,heads)
                if "new" in heads: value["answers"]["new"]={"label":"unclear","confidence":.4}
                if "duplicate" in heads: value["answers"]["duplicate"]={"label":label,"confidence":confidence}
                return value
            p.ask=ask;r=JevReader(p)
            r.step(inputs(["저는 안내문을 작성했습니다."]))
            out=r.step(inputs(["저는 안내문을 작성했습니다.","다른 행사에서는 예약 순서를 조정했습니다."],notes=[note()]))
            self.assertEqual(len(out["evidence"]),expected)
            self.assertEqual(sum(set(h)=={"duplicate"} for _,h in p.payloads),1)

        p=self.focused("role");p.reject_audit=True;original=p.ask
        def ask_rejected(state,heads):
            value=original(state,heads)
            if "new" in heads: value["answers"]["new"]={"label":"unclear","confidence":.4}
            return value
        p.ask=ask_rejected;r=JevReader(p)
        r.step(inputs(["저는 안내문을 작성했습니다."]))
        out=r.step(inputs(["저는 안내문을 작성했습니다.","다른 행사에서는 예약 순서를 조정했습니다."],notes=[note()]))
        self.assertEqual(out["evidence"],[])
        self.assertFalse(any("duplicate" in h for _,h in p.payloads))

    def test_unconfirmed_link_fails_closed_and_uses_no_future_source(self):
        p=self.focused("method",link=True);original=p.ask
        def ask(state,heads):
            v=original(state,heads)
            if "linked" in heads:v["answers"]["linked"]={"label":"yes","confidence":.4}
            return v
        p.ask=ask;r=JevReader(p)
        r.step(inputs(["문의 안내를 맡았습니다."]))
        result=r.step(inputs(["문의 안내를 맡았습니다.","급한 문의부터 안내했습니다."],notes=[note()]))
        self.assertEqual(result["evidence"],[])
        for state,_ in p.payloads:
            self.assertTrue(all(u["id"] in ("u1","u2") for u in state.get("sources",[])))

    def test_context_and_prior_note_are_distinct_and_leave_room_for_correction(self):
        p=self.focused("method",link=True); original=p.ask
        def ask(state,heads):
            v=original(state,heads)
            if "context_u1" in heads: v["answers"]["context_u1"]={"label":"yes","confidence":.99}
            return v
        p.ask=ask;r=JevReader(p)
        texts=["교육센터 문의 안내 경험입니다.","제가 취소 절차를 정리했습니다.","취소 요청을 받은 순서대로 안내했습니다."]
        r.step(inputs(texts[:1]));r.step(inputs(texts[:2]))
        prior={**note(),"unit_id":"u2","evidence_unit_ids":["u2"]}
        card=r.step(inputs(texts,notes=[prior]))["evidence"][0]
        state=next(state for state,heads in reversed(p.payloads) if "contextual" in heads)
        self.assertEqual([e["unit_id"] for e in card["evidence"]],["u1","u2","u3"])
        self.assertEqual(state["previous_source"]["id"],"u2")
        self.assertEqual(state["context_source"]["id"],"u1")
        self.assertEqual(state["current_source"]["id"],"u3")
        self.assertEqual([u["id"] for u in state["prior_note_sources"][0]["sources"]],["u2"])
        p.withdraw=True
        retraction=r.step(inputs([*texts,"정정하면 취소 절차 정리와 안내는 모두 동료의 업무였습니다."],notes=[{
            **prior,"id":"n1","unit_id":"u3","evidence_unit_ids":["u1","u2","u3"],"text":card["text"]}]))["retractions"][0]
        self.assertEqual([e["unit_id"] for e in retraction["evidence"]],["u1","u2","u3","u4"])
        audit=next(state for state,heads in reversed(p.payloads) if "target_sources" in state)
        self.assertEqual([u["id"] for u in audit["target_sources"]],["u1","u2","u3"])
        self.assertEqual(audit["target_sources"],audit["note_sources"]["n1"])

    def test_uncertain_retrieved_relevance_still_needs_confirmed_final_audit(self):
        for confirmed in (False,True):
            p=self.focused("role");original=p.ask
            def ask(state,heads):
                v=original(state,heads)
                if "criteria" in state and "c_r1" in heads:v["answers"]["c_r1"]={"label":"yes","confidence":.55}
                if "relevant" in heads:v["answers"]["relevant"]={"label":"yes","confidence":.9 if confirmed else .74}
                return v
            p.ask=ask;r=JevReader(p)
            result=r.step(inputs(["제가 문의를 안내했습니다."]))
            self.assertEqual(len(result["evidence"]),int(confirmed))

    def test_contradicted_or_uncertain_validity_cannot_emit_a_note(self):
        for label,confidence in [("yes",.95),("no",.74),("unclear",.9)]:
            p=self.focused("role");original=p.ask
            def ask(state,heads):
                v=original(state,heads)
                if "invalidated" in heads:v["answers"]["invalidated"]={"label":label,"confidence":confidence}
                return v
            p.ask=ask
            self.assertEqual(JevReader(p).step(inputs(["제가 문의를 안내했습니다."]))["evidence"],[])

    def test_link_failure_rolls_back_state_and_can_retry_same_prefix(self):
        p=self.focused("method",link=True);r=JevReader(p)
        texts=["제가 문의를 안내했습니다.","긴급 문의부터 안내했습니다."]
        r.step(inputs(texts[:1]));before=copy.deepcopy(r.diagnostics);calls=r.provider.calls
        original=p.ask
        def ask(state,heads):
            if "linked" in heads:raise ProviderError("jev_http_503")
            return original(state,heads)
        p.ask=ask
        with self.assertRaises(ProviderError):r.step(inputs(texts,notes=[note()]))
        self.assertEqual(len(r.prefix),1)
        self.assertEqual(r.diagnostics,before)
        self.assertGreater(r.provider.calls,calls)
        p.ask=original
        self.assertEqual(len(r.step(inputs(texts,notes=[note()]))["evidence"]),1)

    def test_copy_stays_inside_utf16_public_limit_for_every_focus(self):
        for focus in WORDING:
            self.assertLessEqual(len(note_text(focus,"🙂"*100,True).encode("utf-16-le"))//2,200)

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
        self.assertEqual(r.provider.calls, 4)

    def test_later_detail_in_same_experience_is_not_filtered_before_novelty_audit(self):
        p=Provider(); r=JevReader(p)
        r.step(inputs(["제가 문의를 긴급도에 따라 분류했습니다."]))
        out=r.step(inputs(["제가 문의를 긴급도에 따라 분류했습니다.", "취소 절차는 안내문을 작성해 전달했습니다."], notes=[note()]))
        self.assertEqual(len(out["evidence"]), 1)
        self.assertEqual(out["evidence"][0]["evidence"][-1]["unit_id"], "u2")
        self.assertTrue(any("new" in heads for _,heads in p.payloads))

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

    def test_pending_question_completion_overclaim_is_not_presented_as_positive(self):
        p=Provider(); original=p.ask
        def ask(state, heads):
            value=original(state, heads)
            if "overclaims_answer" in heads: value["answers"]["overclaims_answer"]["label"]="yes"
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
