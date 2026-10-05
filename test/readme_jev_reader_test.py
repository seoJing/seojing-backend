"""Reader wiring regressions; provider fakes are NOT model quality evidence."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/services/readme-lab/python"))
from decision_providers import ProviderError
from jev_reader import JevReader, BudgetProvider, QUESTIONS, proof
from atomic_decisions import state_for
import jev_runtime


class FakeProvider:
    def __init__(self, label="yes", confidence=.95):
        self.payloads = []
        self.label = label
        self.confidence = confidence

    def ask(self, state, questions):
        self.payloads.append(json.loads(json.dumps(state)))
        return {"answers": {k: {"label": self.label, "confidence": self.confidence} for k in questions},
                "usage": {"input_tokens": 100, "output_tokens": 5}}


def data(texts, questions=None):
    return {"prefix": [{"id": f"u{i+1}", "order": i, "text": t, "scope_id": "s1"} for i, t in enumerate(texts)],
        "questions": questions or [], "job": {"requirements": [{"id": "r1", "kind": "duty", "label": "안내", "quote": "안내"}],
        "reader_profile": {"criteria": [{"id": "c_r1", "label": "안내", "requirement_id": "r1",
        "checks": [{"facet": "role", "trigger": "담당 업무 주장", "sufficient": "공고에서 정한 역할 설명 조건", "insufficient": "역할이 불분명함"},
                   {"facet": "method", "trigger": "방법 설명", "sufficient": "방법 설명", "insufficient": "방법 미설명"}]}]}}}


def question(status="open"):
    return {"id": "q1", "unit_id": "u1", "scope_id": "s1", "criterion_id": "c_r1", "facet": "role",
            "text": QUESTIONS["role"], "status": status}


class ReaderTest(unittest.TestCase):
    def test_retry_replays_immutable_request_counts_usage_and_has_no_head_mixing(self):
        class Flaky:
            def __init__(self): self.calls = []
            def ask(self, state, questions):
                self.calls.append((json.loads(json.dumps(state)), json.loads(json.dumps(questions))))
                if len(self.calls) == 1:
                    state['source'] = 'mutated'; questions.clear()
                    raise ProviderError('invalid_answer_distribution_argmax', {'input_tokens': 9, 'output_tokens': 3})
                return {'answers': {'b': {'label': 'no'}}, 'usage': {'input_tokens': 10, 'output_tokens': 4}}
        raw = Flaky(); provider = BudgetProvider(raw)
        result = provider.ask({'source': 'original'}, {'b': {'criteria': {'yes': 'yes', 'no': 'no'}}})
        self.assertEqual(raw.calls[0], raw.calls[1])
        self.assertEqual(result['answers'], {'b': {'label': 'no'}})
        self.assertEqual(result['usage'], {'input_tokens': 19, 'output_tokens': 7})
        self.assertEqual((provider.calls, provider.input_tokens, provider.output_tokens), (2, 19, 7))
        self.assertEqual(result['retry_codes'], ['invalid_answer_distribution_argmax'])

    def test_retry_budget_checks_every_physical_attempt_and_preserves_failed_usage(self):
        raw = FakeProvider()
        raw.ask = lambda *_: (_ for _ in ()).throw(ProviderError('invalid_answer_distribution_argmax', {'input_tokens': 9, 'output_tokens': 3}))
        for limits in ({'max_calls': 1}, {'max_input_tokens': 9}):
            provider = BudgetProvider(raw, **limits)
            with self.assertRaisesRegex(ProviderError, 'jev_call_budget_exceeded') as failure: provider.ask({}, {})
            self.assertEqual(provider.calls, 1)
            self.assertEqual(failure.exception.usage['input_tokens'], 9)
        provider = BudgetProvider(raw)
        for _ in range(3):
            with self.assertRaises(ProviderError): provider.ask({}, {})
        self.assertEqual((provider.calls, provider.retries), (5, 2))

    def test_security_config_timeout_and_auth_failures_never_retry(self):
        for code in ('jev_http_401', 'jev_http_429', 'jev_timeout', 'jev_redirect_rejected', 'jev_model_mismatch', 'invalid_answer_distribution_keys'):
            raw = FakeProvider(); raw.ask = lambda *_: (_ for _ in ()).throw(ProviderError(code))
            provider = BudgetProvider(raw)
            with self.assertRaises(ProviderError): provider.ask({}, {})
            self.assertEqual(provider.calls, 1)

    def test_reassessment_enters_same_adopted_ledger_and_can_be_withdrawn(self):
        texts = ['자막 제작에 참여했습니다.', '맞춤법 검수를 맡을 예정이었습니다.', '제가 이 작업을 직접 마쳤습니다.', '정정하면 실제 작업자는 동료였습니다.']
        calls = []
        def review(qid, current):
            calls.append((qid, current))
            return {'evidence': [{'unit_id': f'u{i+1}', 'quote': texts[i]} for i in (1, 2)]}
        reader = JevReader(FakeProvider(), reassess=review)
        reader.step(data(texts[:1]))
        with patch('jev_reader.GroundedJev.decide', return_value={'label': 'unrelated'}): reader.step(data(texts[:2], [question()]))
        with patch('jev_reader.GroundedJev.decide', return_value={'label': 'unknown'}):
            result = reader.step(data(texts[:3], [question()]))
        self.assertEqual(result['updates'][0]['relation'], 'complete')
        self.assertEqual(calls, [('q1', 'u3')])
        self.assertEqual(reader.adopted['q1'], [{'id': 'u1', 'text': texts[1]}, {'id': 'u2', 'text': texts[2]}])
        with patch('jev_reader.GroundedJev.decide', return_value={'label': 'unknown'}), patch('jev_reader.GroundedJev.audit_adopted', return_value={'label': 'no', 'confidence': .95}):
            result = reader.step(data(texts, [question('resolved')]))
        self.assertEqual(result['updates'][0]['relation'], 'conflict')
        self.assertNotIn('q1', reader.role_links)
        self.assertEqual(len(calls), 1)

    def test_failed_step_rolls_back_adoption_links_and_caches_but_not_usage(self):
        raw = FakeProvider(); reader = JevReader(raw)
        reader.step(data(['참여했습니다.']))
        value = data(['참여했습니다.', '제가 작성했습니다.'], [question()])
        value['prefix'][-1]['scope_id'] = 's2'  # Forces a final trigger after adoption.
        raw.ask = lambda *_: (_ for _ in ()).throw(ProviderError('jev_http_401'))
        before = reader.metrics()['calls']
        with patch('jev_reader.GroundedJev.decide', return_value={'label': 'complete', 'evidence': [{'id': 'u1', 'text': '제가 작성했습니다.'}]}):
            with self.assertRaises(ProviderError): reader.step(value)
        self.assertEqual(reader.adopted, {})
        self.assertEqual(reader.readers, {})
        self.assertEqual(len(reader.prefix), 1)
        self.assertEqual(reader.metrics()['calls'], before + 1)

    def test_optional_reassessment_is_bounded_and_cannot_use_future_or_fabricated_proof(self):
        for evidence in ([{'unit_id': 'u3', 'quote': 'future'}], [{'unit_id': 'u2', 'quote': 'fabricated'}]):
            reader = JevReader(FakeProvider(), reassess=lambda *_: {'evidence': evidence})
            reader.step(data(['참여했습니다.']))
            with patch('jev_reader.GroundedJev.decide', return_value={'label': 'unknown'}):
                with self.assertRaises(ValueError): reader.step(data(['참여했습니다.', '제가 했습니다.'], [question()]))
            self.assertEqual(reader.adopted, {})
            self.assertEqual(reader.reassessment_count, 1)
        calls = []
        reader = JevReader(FakeProvider(), reassess=lambda *args: calls.append(args))
        reader.step(data(['참여했습니다.']))
        with patch('jev_reader.GroundedJev.decide', return_value={'label': 'unknown'}):
            for i in range(2, 5): reader.step(data(['참여했습니다.'] + ['제가 했습니다.'] * (i-1), [question()]))
        self.assertEqual(len(calls), 2)
        self.assertEqual(reader.adopted, {})

    def test_focused_comparison_requires_all_three_accepted_heads(self):
        for rejected in (None, "comparison", "relevant", "needed"):
            provider = FakeProvider(label="yes", confidence=.5)
            original = provider.ask
            def ask(state, questions):
                if "comparison" not in questions:
                    return original(state, questions)
                provider.payloads.append(state)
                return {"answers": {k: {"label": "no" if k == rejected else "yes", "confidence": .95} for k in questions},
                        "usage": {"input_tokens": 100, "output_tokens": 5}}
            provider.ask = ask
            value = data(["참여자 만족도를 크게 높였습니다."])
            value["job"]["reader_profile"]["criteria"][0]["checks"] = [{"facet": "basis", "trigger": "비교 성과 주장", "sufficient": "비교 근거 설명", "insufficient": "근거 없는 개선 주장"}]
            result = JevReader(provider).step(value)
            self.assertEqual(bool(result["questions"]), rejected is None)
            self.assertEqual(len(provider.payloads), 2)

    def test_compound_role_answer_survives_uncertainty_but_reopens_after_withdrawal(self):
        texts = ["프로그램 운영을 지원했습니다.", "제가 안내문을 작성했습니다.",
                 "추가 운영 배경은 잘 기억나지 않습니다.", "정정하면 안내문을 작성한 사람은 동료입니다."]
        provider = FakeProvider()
        reader = JevReader(provider)
        def inputs(count, status="open"):
            value = data(texts[:count], [question(status)] if count > 1 else [])
            value["job"]["reader_profile"]["criteria"][0]["checks"][0]["sufficient"] = "모집, 일정 조정, 안내문 작성에서 본인이 한 구체적 업무"
            return value
        reader.step(inputs(1))
        evidence = [{"id": "u1", "text": texts[1]}]
        with patch("jev_reader.GroundedJev.decide", return_value={"label": "complete", "evidence": evidence}):
            self.assertEqual(reader.step(inputs(2))["updates"][0]["relation"], "complete")
        with patch("jev_reader.GroundedJev.decide", return_value={"label": "unknown"}):
            self.assertEqual(reader.step(inputs(3, "resolved"))["updates"], [])
            self.assertEqual(provider.payloads[-1]["adopted_evidence"], evidence)
            provider.label = "no"
            step = reader.step(inputs(4, "resolved"))
        self.assertEqual(step["updates"][0]["relation"], "conflict")
        self.assertEqual([e["unit_id"] for e in step["updates"][0]["evidence"]], ["u1", "u2", "u4"])

    def test_worker_distinguishes_call_and_token_budget_from_provider_failure(self):
        for budget in ({"max_calls": 0}, {"max_input_tokens": 0}):
            messages = [{"api_key": "synthetic-key-not-a-credential", "allow_remote": True},
                        {"id": "step1", "input": data(["행사 안내에 기여했습니다."])}]
            sent = []
            with patch.object(jev_runtime, "receive", side_effect=messages), patch.object(
                    jev_runtime, "send", side_effect=sent.append), patch.object(
                    jev_runtime, "JevProvider", return_value=FakeProvider()), patch.object(
                    jev_runtime, "JevReader", side_effect=lambda provider: JevReader(provider, **budget)):
                self.assertEqual(jev_runtime.main(), 1)
            self.assertEqual(sent[-1], {"id": "step1", "error": "engine_budget_exceeded", "diagnostic_code": "jev_call_budget_exceeded",
                "metrics": {"calls": 0, "input_tokens": 0, "output_tokens": 0, "omitted_proofs": 0}})

    def test_trigger_uses_only_prefix_and_supported_job_checks(self):
        provider = FakeProvider()
        reader = JevReader(provider)
        step = reader.step(data(["행사 안내에 기여했습니다."]))
        self.assertEqual(step["questions"][0]["facet"], "role")
        self.assertEqual(step["questions"][0]["evidence"], [{"unit_id": "u1", "quote": "행사 안내에 기여했습니다."}])
        self.assertEqual(len(provider.payloads[0]["units"]), 1)
        self.assertNotIn("expected", json.dumps(provider.payloads))

    def test_uncertain_trigger_never_creates_question(self):
        self.assertEqual(JevReader(FakeProvider(confidence=.74)).step(data(["행사 안내에 참여했습니다."]))["questions"], [])

    def test_prefix_rewrite_and_repeat_rejected(self):
        reader = JevReader(FakeProvider())
        reader.step(data(["첫 문장"])); before = reader.metrics()["calls"]
        for invalid in (data(["첫 문장"]), data(["수정 문장", "다음 문장"])):
            with self.assertRaises(ValueError): reader.step(invalid)
        self.assertEqual(reader.metrics()["calls"], before)

    def test_no_new_question_for_existing_scope_and_facet(self):
        provider = FakeProvider(); reader = JevReader(provider)
        reader.step(data(["참여했습니다."]))
        with patch("jev_reader.GroundedJev.decide", return_value={"label": "unknown"}):
            step = reader.step(data(["참여했습니다.", "배경 설명입니다."], [question()]))
        self.assertEqual(step["questions"], [])
        self.assertEqual(len(provider.payloads), 1)

    def test_exact_evidence_and_withdrawal_recovery(self):
        texts = ["안내에 기여했습니다.", "제가 안내문을 썼습니다.", "정정하면 작성한 사람은 동료입니다."]
        reader = JevReader(FakeProvider()); reader.step(data(texts[:1]))
        evidence = [{"id": "u1", "text": texts[1]}]  # Grounded IDs are relative to origin, zero based.
        with patch("jev_reader.GroundedJev.decide", return_value={"label": "complete", "evidence": evidence}):
            step = reader.step(data(texts[:2], [question()]))
        self.assertEqual(step["updates"][0]["relation"], "complete")
        self.assertEqual([e["unit_id"] for e in step["updates"][0]["evidence"]], ["u1", "u2"])
        with patch("jev_reader.GroundedJev.decide", return_value={"label": "unknown"}), patch(
                "jev_reader.GroundedJev.audit_adopted", return_value={"label": "no", "confidence": .95}):
            step = reader.step(data(texts, [question("resolved")]))
        self.assertEqual(step["updates"][0]["relation"], "conflict")
        self.assertEqual([e["unit_id"] for e in step["updates"][0]["evidence"]], ["u1", "u2", "u3"])

    def test_repeated_conflict_and_partial_cannot_downgrade_resolution(self):
        for status, label in [("reopened", "conflict"), ("resolved", "partial")]:
            reader = JevReader(FakeProvider()); reader.step(data(["참여했습니다."]))
            with patch("jev_reader.GroundedJev.decide", return_value={"label": label}):
                self.assertEqual(reader.step(data(["참여했습니다.", "추가 설명"], [question(status)]))["updates"], [])

    def test_fabricated_source_fails_closed(self):
        reader = JevReader(FakeProvider()); reader.step(data(["참여했습니다."]))
        with patch("jev_reader.GroundedJev.decide", return_value={"label": "complete", "evidence": [{"id": "u1", "text": "지어낸 내용"}]}):
            with self.assertRaises(ValueError): reader.step(data(["참여했습니다.", "추가 설명"], [question()]))

    def test_support_before_question_origin_is_preserved_in_order(self):
        texts = ["행사 안내는 제가 담당했습니다.", "행사에 기여했습니다.", "담당 업무로 참가자 일정을 조정했습니다."]
        reader = JevReader(FakeProvider(label="no"))
        reader.step(data(texts[:1])); reader.step(data(texts[:2]))
        q = {**question(), "unit_id": "u2"}
        evidence = [{"id": "u0", "text": texts[0]}, {"id": "u2", "text": texts[2]}]
        with patch("jev_reader.GroundedJev.decide", return_value={"label": "complete", "evidence": evidence}) as decide:
            step = reader.step(data(texts, [q]))
        case = decide.call_args.args[0]
        self.assertEqual(case["units"], texts)
        self.assertEqual(case["origin_index"], 1)
        self.assertEqual(case["sufficient"], "공고에서 정한 역할 설명 조건")
        self.assertEqual(state_for(case)["original"], texts[1])
        self.assertEqual(state_for(case)["evidence"], [texts[0]])
        self.assertIn({"unit_id": "u1", "quote": texts[0]}, step["updates"][0]["evidence"])

    def test_total_provider_budget_and_failed_usage_are_counted(self):
        provider = BudgetProvider(FakeProvider(), max_calls=1)
        provider.ask({}, {})
        with self.assertRaises(ProviderError): provider.ask({}, {})
        raw = FakeProvider()
        raw.ask = lambda *_: (_ for _ in ()).throw(ProviderError("invalid_answer", {"input_tokens": 9, "output_tokens": 3}))
        provider = BudgetProvider(raw)
        with self.assertRaises(ProviderError): provider.ask({}, {})
        self.assertEqual((provider.calls, provider.input_tokens), (1, 9))

    def test_changed_partial_feedback_is_not_suppressed(self):
        texts = ["안내에 참여했습니다.", "팀이 업무를 나눴습니다.", "제가 직접 했지만 업무 내용은 뒤에서 설명합니다."]
        reader = JevReader(FakeProvider()); reader.step(data(texts[:1]))
        first = {"label": "partial", "unmet": ["personal", "task"], "facts": {},
                 "evidence": [{"id": "u1", "text": texts[1]}],
                 "feedback": {"text": "본인 업무와 구체적 행동을 확인해 주세요."}}
        second = {"label": "partial", "unmet": ["task"], "facts": {"personal": {"source_ids": ["u2"]}},
                  "feedback": {"text": "직접 수행한 구체적 업무를 설명해 주세요."}, "evidence": [{"id": "u2", "text": texts[2]}]}
        with patch("jev_reader.GroundedJev.decide", return_value=first):
            reader.step(data(texts[:2], [question()]))
        with patch("jev_reader.GroundedJev.decide", return_value=second):
            step = reader.step(data(texts, [question("partial")]))
        self.assertEqual(len(step["updates"]), 1)
        self.assertEqual(step["updates"][0]["text"], second["feedback"]["text"])

    def test_proofs_never_truncate_utf16_or_exceed_event_budget(self):
        self.assertIsNone(proof([{"id": "u1", "text": "😀" * 201}]))
        self.assertIsNone(proof([{"id": str(i), "text": "원문"} for i in range(7)]))

    def test_background_anchor_does_not_refresh_an_earlier_resolved_answer(self):
        texts = ["센터 운영을 도왔습니다.", "제가 안내문을 썼습니다.", "행사 전체 결과는 팀의 성과입니다."]
        reader = JevReader(FakeProvider()); reader.step(data(texts[:1]))
        evidence = [{"id": "u1", "text": texts[1]}]
        with patch("jev_reader.GroundedJev.decide", return_value={"label": "complete", "evidence": evidence}):
            reader.step(data(texts[:2], [question()]))
            self.assertEqual(reader.step(data(texts, [question("resolved")]))["updates"], [])

    def test_neutral_partial_replaces_stale_missing_value_feedback_without_resolving(self):
        texts = ["응답 시간을 줄였습니다.", "측정 방법을 설명했습니다.", "이전 12분, 이후 9분입니다."]
        reader = JevReader(FakeProvider()); reader.step(data(texts[:1]))
        stale = {"label": "partial", "unmet": ["after"], "evidence": [{"id": "u1", "text": texts[1]}],
                 "feedback": {"text": "변경 후 측정값을 설명해 주세요."}}
        latest = {"label": "partial", "unmet": [], "missing": [],
                  "facts": {"after": {"source_ids": ["u2"]}},
                  "evidence": [{"id": "u2", "text": texts[2]}],
                  "feedback": {"text": "추가 설명을 찾았습니다. 답이 충분한지는 아직 확인 중입니다."}}
        with patch("jev_reader.GroundedJev.decide", return_value=stale): reader.step(data(texts[:2], [question()]))
        with patch("jev_reader.GroundedJev.decide", return_value=latest): result = reader.step(data(texts, [question("partial")]))
        self.assertEqual(result["updates"][0]["relation"], "partial")
        self.assertNotIn("변경 후 측정값을 설명", result["updates"][0]["text"])

    def test_candidate_growth_does_not_repeat_unchanged_partial_feedback(self):
        texts = ["안내에 참여했습니다.", "제가 현장 업무를 맡았습니다.", "참가자는 오전에 모였습니다."]
        reader = JevReader(FakeProvider()); reader.step(data(texts[:1]))
        first = {"label": "partial", "unmet": ["personal", "task"],
                 "facts": {"personal": {"source_ids": ["u1"]}, "task": {"source_ids": []}},
                 "evidence": [{"id": "u1", "text": texts[1]}],
                 "feedback": {"kind": "supplement", "text": "본인 업무를 설명해 주세요.", "source_ids": ["u0", "u1"]}}
        second = {**first, "feedback": {**first["feedback"], "source_ids": ["u0", "u1", "u2"]}}
        with patch("jev_reader.GroundedJev.decide", return_value=first):
            self.assertEqual(len(reader.step(data(texts[:2], [question()]))["updates"]), 1)
        with patch("jev_reader.GroundedJev.decide", return_value=second):
            self.assertEqual(reader.step(data(texts, [question("partial")]))["updates"], [])

    def test_gap_only_decision_never_promotes_display_anchors_to_partial_proof(self):
        for status in ('open', 'partial'):
            for reason in ('not_explained', 'explicit_absence', 'planned_only', 'different_conditions'):
                reader = JevReader(FakeProvider(label='no'))
                texts = ['만족도를 높였습니다.', '다른 행사 후 설문에서 62명 중 57명이 재참여한다고 답했습니다.']
                reader.step(data(texts[:1]))
                value = data(texts, [question(status)])
                snapshot = json.loads(json.dumps(value))
                decision = {'label': 'partial', 'evidence': [], 'facts': {},
                            'gap_reasons': {'before': {'label': reason, 'confidence': .99}},
                            'feedback': {'text': '기존 질문의 근거가 부족합니다.', 'source_ids': ['u0', 'u1']}}
                with patch('jev_reader.GroundedJev.decide', return_value=decision):
                    result = reader.step(value)
                self.assertEqual(result['updates'], [])
                self.assertEqual(result['evidence'], [])
                self.assertEqual(reader.partial_signatures, {})
                self.assertEqual(value, snapshot)


if __name__ == "__main__": unittest.main()
