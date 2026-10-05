import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/services/readme-lab/python'))
from decision_providers import ProviderError
from jev_grounded import GroundedJev, compact_support, SCOPE_BOUNDARY


def answer(label, confidence=.95):
    return {'label': label, 'confidence': confidence}


def facts(sources, support=(), weak=(), withdraw=()):
    result = {}
    for key in ('personal', 'performed', 'task'):
        for uid in sources:
            result[f'{key}_{uid}'] = answer('yes' if uid in support else 'no', .4 if uid in weak else .95)
    for uid in sources[:-1]:
        result[f'withdraw_{uid}'] = answer('yes' if uid in withdraw else 'no')
    return result


class Fake:
    def __init__(self, rows):
        self.rows, self.calls = list(rows), []
        self.gap_label = 'not_explained'

    def ask(self, state, questions):
        self.calls.append((copy.deepcopy(state), copy.deepcopy(questions)))
        if all('not_explained' in q['criteria'] for q in questions.values()):
            value = {k: answer(self.gap_label) for k in questions}
        else:
            value = self.rows.pop(0)
        if isinstance(value, Exception):
            raise value
        assert set(value) == set(questions), (list(value), list(questions))
        return {'answers': value, 'usage': {'input_tokens': 100, 'output_tokens': 10}}


class GroundedTests(unittest.TestCase):
    def setUp(self):
        self.case = {'facet': 'role', 'units': ['전시 운영을 도왔습니다.', '이 전시에서 안내문은 동료가 작성했습니다.'],
            'current_index': 1, 'question': '본인이 한 업무는 무엇인가요?',
            'sufficient': '개인이 실제로 한 구체적 업무', 'insufficient': '팀 업무만 있음'}
        self.link = {'scope': answer('same'), 'topic': answer('related'), 'unlinked': answer('no')}

    def test_role_contract_cannot_be_expanded_by_generated_method_requirements(self):
        self.case['sufficient'] = 'UNRELATED_METHOD_REQUIREMENT'
        self.case['insufficient'] = 'UNRELATED_QUALIFICATION_REQUIREMENT'
        fake = Fake([self.link, facts(['u0', 'u1'], support=['u1']), {'complete': answer('yes'), 'invalidated': answer('no')}])
        self.assertEqual(GroundedJev(fake).decide(self.case)['label'], 'complete')
        self.assertNotIn('UNRELATED_', json.dumps(fake.calls))
        self.assertIn('같은 행동', fake.calls[-1][1]['complete']['instructions'])

    def test_role_binding_cannot_pool_different_actions_or_actors(self):
        raw = facts(['u0', 'u1'])
        raw['personal_u0'] = raw['performed_u0'] = answer('yes')
        raw['task_u1'] = answer('yes')
        fake = Fake([self.link, raw, {'complete': answer('no'), 'invalidated': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'unknown')
        self.assertEqual(result['evidence'], [])
        self.assertEqual(len(fake.calls[-1][0]['proposed_evidence']), 2)

    def test_named_plan_and_later_execution_keep_both_sources_in_bound_proof(self):
        self.case['units'] = ['작업을 도왔습니다.', '검수를 제가 맡을 예정이었습니다.', '그 검수를 제가 마쳤습니다.']
        self.case['current_index'] = 2
        raw = facts(['u0', 'u1', 'u2'])
        raw['personal_u1'] = raw['task_u1'] = raw['performed_u2'] = answer('yes')
        fake = Fake([self.link, self.link, raw, {'complete': answer('yes'), 'invalidated': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'complete')
        self.assertEqual([u['id'] for u in result['evidence']], ['u1', 'u2'])

    def test_role_threshold_override_does_not_weaken_scope_or_validity(self):
        for binding, valid, expected in [(.74, .95, 'complete'), (.69, .95, 'unknown'), (.95, .74, 'unknown')]:
            fake = Fake([self.link, facts(['u0', 'u1'], support=['u1']),
                         {'complete': answer('yes', binding), 'invalidated': answer('no', valid)}])
            self.assertEqual(GroundedJev(fake, thresholds={'role_binding': .7}).decide(self.case)['label'], expected)
        weak_link = {**self.link, 'scope': answer('same', .74)}
        fake = Fake([weak_link, {'scope': weak_link['scope']}])
        self.assertEqual(GroundedJev(fake, thresholds={'role_binding': .7}).decide(self.case)['label'], 'unknown')
        self.assertEqual(GroundedJev(None).thresholds['role_binding'], .75)

    def test_threshold_policy_rejects_unknown_nonfinite_and_bool_values(self):
        for values in [[], {'other': .7}, {'role_binding': float('nan')},
                       {'scope': float('inf')}, {'validity': True}, {'withdrawal': -.1}, {'basis': 1.01}]:
            with self.assertRaisesRegex(ValueError, 'invalid_decision_thresholds'):
                GroundedJev(None, thresholds=values)

    def test_partial_has_specific_feedback_without_inventing_ability(self):
        fake = Fake([self.link, facts(['u0', 'u1'])])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'partial')
        self.assertEqual(result['feedback']['kind'], 'supplement')
        self.assertIn('본인이 담당한 업무', result['feedback']['text'])

    def test_future_labels_and_metadata_never_sent(self):
        self.case.update(expected=['secret_expected'], expected_facts={'secret': 1}, secret='metadata')
        self.case['units'].append('FUTURE_SECRET')
        fake = Fake([self.link, facts(['u0', 'u1'])])
        GroundedJev(fake).decide(self.case)
        serialized = json.dumps(fake.calls)
        for secret in ('secret_expected', 'FUTURE_SECRET', 'metadata', 'expected'):
            self.assertNotIn(secret, serialized)

    def test_explicit_ambiguity_cannot_be_overridden_by_facts(self):
        fake = Fake([{**self.link, 'scope': answer('unclear')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual((result['label'], result['feedback']['kind']), ('unknown', 'clarify'))
        self.assertEqual(len(fake.calls), 1)

    def test_explicit_unlinked_and_uncertain_link_veto_confident_same(self):
        for unlinked in (answer('yes'), answer('no', .4)):
            fake = Fake([{**self.link, 'unlinked': unlinked}] +
                        ([{'unlinked': unlinked}] if unlinked['confidence'] < .75 else []))
            result = GroundedJev(fake).decide(self.case)
            self.assertEqual(result['label'], 'unknown')

    def test_actual_withdrawal_requires_second_source_check(self):
        fake = Fake([self.link, facts(['u0', 'u1'], withdraw=['u0']), {'u0': answer('yes')}, {'u0': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'unknown')
        self.assertEqual(result['reason'], 'withdrawal_unproven')
        self.assertEqual(result['missing'], [])

    def test_focused_scope_keeps_full_experience_and_outcome_policy(self):
        fake = Fake([{**self.link, 'scope': answer('different', .03)}, {'scope': answer('different')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'unrelated')
        for _, questions in fake.calls:
            self.assertIn(SCOPE_BOUNDARY, questions['scope']['instructions'])

    def test_verified_conflict_preserves_two_quotes(self):
        fake = Fake([self.link, facts(['u0', 'u1'], withdraw=['u0']), {'u0': answer('yes')}, {'u0': answer('yes')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'conflict')
        self.assertEqual([e['text'] for e in result['evidence']], self.case['units'])

    def test_already_withdrawn_claim_is_not_a_new_conflict(self):
        fake = Fake([self.link, facts(['u0', 'u1'], withdraw=['u0']), {'u0': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'partial')
        self.assertEqual(fake.calls[2][0]['sources'], [{'id': 'u0', 'text': self.case['units'][0]}])
        self.assertNotIn('current_source_id', fake.calls[2][0])

    def test_new_independently_valid_answer_can_replace_withdrawn_old_answer(self):
        self.case['units'].append('새로 설명하는 실제 업무')
        self.case['current_index'] = 2
        raw = facts(['u0', 'u1', 'u2'], support=['u0', 'u2'], withdraw=['u0'])
        fake = Fake([self.link, self.link, raw, {'complete': answer('yes'), 'invalidated': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'complete')
        self.assertEqual(result['evidence'], [{'id': 'u2', 'text': self.case['units'][2]}])
        self.assertEqual(result['facts']['personal']['source_ids'], ['u0', 'u2'])  # diagnostics only

    def test_context_restriction_vetoes_otherwise_complete_proposal(self):
        fake = Fake([self.link, facts(['u0', 'u1'], support=['u1']),
                     {'complete': answer('yes'), 'invalidated': answer('yes')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'unknown')
        self.assertEqual(result['evidence'], [])

    def test_uncertain_source_fact_does_not_become_missing(self):
        fake = Fake([self.link, facts(['u0', 'u1'], weak=['u1'])])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'unknown')
        self.assertEqual(result['missing'], [])

    def test_complete_requires_all_facts_and_blinded_confirmation(self):
        fake = Fake([self.link, facts(['u0', 'u1'], support=['u1']), {'complete': answer('yes'), 'invalidated': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'complete')
        self.assertEqual(result['evidence'], [{'id': 'u1', 'text': self.case['units'][1]}])
        self.assertNotIn('facts', fake.calls[-1][0])
        self.assertNotIn('draft', fake.calls[-1][0])

    def test_multiple_valid_sources_do_not_compete_for_confidence(self):
        self.case['units'].append('이 전시에서 제가 안내문을 썼습니다.')
        self.case['current_index'] = 2
        fake = Fake([self.link, self.link, facts(['u0', 'u1', 'u2'], support=['u1', 'u2']), {'complete': answer('yes'), 'invalidated': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'complete')
        self.assertEqual(result['facts']['personal']['source_ids'], ['u1', 'u2'])

    def test_weak_withdrawal_recheck_keeps_original_and_exact_source(self):
        raw = facts(['u0', 'u1'])
        raw['withdraw_u0'] = answer('no', .4)
        fake = Fake([self.link, raw, {'u0': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'partial')
        recheck_state, recheck_questions = fake.calls[2]
        self.assertEqual(recheck_state['current'], self.case['units'][1])
        self.assertEqual(recheck_state['original'], self.case['units'][0])
        self.assertEqual(recheck_state['prefix_before_current'], [{'id': 'u0', 'text': self.case['units'][0]}])
        self.assertIn(self.case['units'][0], recheck_questions['u0']['instructions'])

    def test_complete_check_focuses_newest_evidence_and_keeps_full_context(self):
        self.case['units'] = ['original', 'older', 'background', 'context-a', 'context-b', 'new answer', 'later correction']
        self.case['current_index'] = 6
        ids = [f'u{i}' for i in range(7)]
        fake = Fake([self.link] * 6 + [facts(ids, support=['u1', 'u5']), {'complete': answer('no'), 'invalidated': answer('yes')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'unknown')
        verification = fake.calls[-1][0]
        self.assertEqual([u['id'] for u in verification['proposed_evidence']], ['u5'])
        self.assertEqual([u['id'] for u in verification['sources']], ids)
        self.assertEqual(verification['sources'][-1]['text'], 'later correction')

    def test_uncertain_filter_does_not_become_missing(self):
        self.case['units'].insert(1, '대상이 불확실한 앞선 설명')
        self.case['current_index'] = 2
        fake = Fake([self.link, {**self.link, 'scope': answer('unclear')}, facts(['u0', 'u1', 'u2'], weak=['u1'])])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'unknown')
        self.assertEqual(result['uncertain_source_ids'], ['u1'])
        self.assertEqual(result['missing'], [])

    def test_error_stops_and_budget_stops_before_call(self):
        fake = Fake([ProviderError('jev_http_429')])
        with self.assertRaisesRegex(ProviderError, 'jev_http_429'):
            GroundedJev(fake).decide(self.case)
        self.assertEqual(len(fake.calls), 1)
        with self.assertRaisesRegex(ProviderError, 'jev_call_budget_exceeded'):
            GroundedJev(Fake([]), max_calls=0).decide(self.case)

    def test_rejected_provider_response_counts_available_usage_and_stops(self):
        error = ProviderError('invalid_answer_distribution_argmax', {'input_tokens': 123, 'output_tokens': 4})
        fake, records = Fake([error]), []
        reader = GroundedJev(fake, records.append)
        with self.assertRaises(ProviderError):
            reader.decide(self.case)
        self.assertEqual((reader.calls, reader.input_tokens, reader.output_tokens), (1, 123, 4))
        self.assertEqual(records[0]['error'], 'invalid_answer_distribution_argmax')
        self.assertNotIn('answers', records[0])
        self.assertEqual(len(fake.calls), 1)

    def test_non_string_provider_choice_retains_validated_usage(self):
        from unittest.mock import MagicMock, patch
        from decision_providers import JevProvider
        with patch.dict('os.environ', {'TYPESAFE_API_KEY': 'synthetic-test-key'}):
            provider = JevProvider(True)
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            'model': 'jev-1.13.0', 'usage': {'input_tokens': 10, 'output_tokens': 3},
            'answers': {'q': {'type': 'choice', 'choice': [],
                             'probabilities': {'yes': .8, 'no': .2}, 'confidence': .6}}
        }).encode()
        with patch.object(provider.opener, 'open', return_value=response):
            with self.assertRaises(ProviderError) as raised:
                provider.ask({}, {'q': {'criteria': {'yes': 'Yes', 'no': 'No'}}})
        self.assertEqual(str(raised.exception), 'invalid_answer_distribution_label')
        self.assertEqual(raised.exception.usage, {'input_tokens': 10, 'output_tokens': 3})

    def test_cache_reuses_only_same_text_and_question(self):
        fake = Fake([self.link, facts(['u0', 'u1']), facts(['u0', 'u1'])])
        reader = GroundedJev(fake)
        first = reader.decide(self.case)
        second = reader.decide(self.case)
        self.assertEqual((first['calls'], second['calls']), (3, 2))

    def test_link_sees_preceding_context_and_cache_distinguishes_it(self):
        first = copy.deepcopy(self.case)
        first['units'] = [self.case['units'][0], '별개인 학교 행사를 도왔습니다.', '그 행사에서 안내문을 썼습니다.']
        first['current_index'] = 2
        unrelated = {**self.link, 'scope': answer('different')}
        fake = Fake([unrelated, unrelated, unrelated, unrelated])
        reader = GroundedJev(fake)
        reader.decide(first)
        second = copy.deepcopy(first)
        second['units'][1] = '해당 전시를 도왔습니다.'
        reader.decide(second)
        self.assertEqual(len(fake.calls), 2)  # unrelated current never retrieves old candidates
        self.assertEqual(fake.calls[0][0]['preceding_context'][1]['text'], first['units'][1])
        self.assertEqual(fake.calls[1][0]['preceding_context'][1]['text'], second['units'][1])

    def test_origin_framing_and_distant_experience_boundary_reach_link(self):
        self.case.update(units=['센터 활동', '센터에 참여했습니다.', '별개 도서관 활동', '다른 안내 업무', '기록 정리', '제가 도서관 문의를 받았습니다.'], origin_index=1, current_index=5)
        fake = Fake([{**self.link, 'scope': answer('different')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'unrelated')
        self.assertEqual([u['text'] for u in fake.calls[0][0]['original_context']], self.case['units'][:2])
        self.assertEqual([u['text'] for u in fake.calls[0][0]['preceding_context']], self.case['units'][:5])

    def test_unconfirmed_role_binding_never_adopts_pooled_partial_support(self):
        for binding in [answer('no'), answer('unclear'), answer('yes', .74)]:
            for invalidated in [answer('yes'), answer('no'), answer('unclear'), answer('no', .74)]:
                fake = Fake([self.link, facts(['u0', 'u1'], support=['u1']),
                             {'complete': binding, 'invalidated': invalidated}])
                result = GroundedJev(fake).decide(self.case)
                self.assertEqual(result['label'], 'unknown')
                self.assertEqual(result['missing'], [])
                self.assertEqual(result['evidence'], [])

    def test_period_requirement_is_explicit_and_cached_per_question(self):
        self.case['facet'] = 'basis'
        fake = Fake([{'periods': answer('yes')}, {'periods': answer('no')}, {'periods': answer('unclear')}, {'periods': answer('unclear')}])
        reader = GroundedJev(fake)
        self.assertIn('periods', reader.conditions(self.case, 'canonical'))
        self.assertIn('periods', reader.conditions(self.case, 'canonical'))
        self.assertEqual(len(fake.calls), 1)
        self.case['sufficient'] = '기간은 선택 예시일 뿐 필수가 아님'
        self.assertNotIn('periods', reader.conditions(self.case, 'canonical'))
        self.case['question'] = '다른 비교 질문'
        self.assertNotIn('periods', reader.conditions(self.case, 'canonical'))

    def test_partial_fact_audit_cannot_promote_uncertain_or_invalid_support(self):
        raw = facts(['u0', 'u1'])
        raw['personal_u1'] = answer('yes')
        for audited in [answer('yes'), answer('no'), answer('yes', .74)]:
            fake = Fake([self.link, raw, {'personal': audited}])
            result = GroundedJev(fake).decide(self.case)
            self.assertEqual(result['label'], 'partial' if audited['label'] == 'yes' and audited['confidence'] >= .75 else 'unknown')
            if result['label'] == 'unknown':
                self.assertEqual(result['evidence'], [])
                self.assertEqual(result['missing'], [])

    def test_partial_audit_never_switches_to_a_new_unaudited_source(self):
        self.case['units'] = ['원래 경험', '앞선 담당 업무 설명', '뒤의 다른 담당 설명']
        self.case['current_index'] = 2
        raw = facts(['u0', 'u1', 'u2'], support=['u1'])
        raw['personal_u2'] = answer('yes')
        raw['task_u1'] = answer('unclear')
        fake = Fake([self.link, self.link, raw, {'personal': answer('yes'), 'performed': answer('no')}])
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['label'], 'partial')
        self.assertEqual(result['evidence'], fake.calls[-1][0]['proposed_evidence'])
        self.assertEqual(result['facts']['personal']['source_ids'], ['u1'])

    def test_weak_period_requirement_is_rechecked_without_lowering_threshold(self):
        self.case['facet'] = 'basis'
        for second in [answer('yes'), answer('yes', .74), answer('no')]:
            fake = Fake([{'periods': answer('yes', .71)}, {'periods': second}])
            conditions = GroundedJev(fake).conditions(self.case, 'canonical')
            self.assertEqual('periods' in conditions, second['label'] == 'yes' and second['confidence'] >= .75)

    def test_cover_keeps_all_facts_including_periods_within_anchor_budget(self):
        source = [{'id': f'u{i}', 'text': f'fact{i}'} for i in range(9)]
        required = {key: {'label': 'supported', 'source_ids': ids} for key, ids in {
            'before': ['u7'], 'after': ['u7'], 'method': ['u2', 'u5'],
            'comparable': ['u2', 'u6'], 'periods': ['u3']}.items()}
        result = compact_support(required, source, ('u0', 'u8'))
        self.assertEqual([u['id'] for u in result], ['u2', 'u3', 'u7'])
        self.assertTrue(all(set(f['source_ids']) & {u['id'] for u in result} for f in required.values()))
        required['method']['source_ids'] = ['u0', 'u5']
        required['comparable']['source_ids'] = ['u8', 'u6']
        result = compact_support(required, source, ('u0', 'u8'))
        self.assertEqual({u['id'] for u in result}, {'u0', 'u3', 'u7', 'u8'})

    def test_journal_matches_sent_option_order(self):
        fake = Fake([{**self.link, 'scope': answer('unclear')}])
        records = []
        GroundedJev(fake, records.append).decide(self.case, 'reversed')
        self.assertEqual(records[0]['order'], 'reversed')
        self.assertEqual(list(records[0]['questions']['scope']['criteria']),
                         list(fake.calls[0][1]['scope']['criteria']))

    def test_source_limit_is_explicit_without_silent_drop(self):
        self.case['units'] = self.case['units'] * 33
        self.case['current_index'] = 65
        fake = Fake([self.link] * 65)
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['reason'], 'selected_context_limit')
        self.assertEqual(result['missing'], [])

    def test_incomparable_feedback_does_not_request_already_stated_difference(self):
        fake = Fake([self.link, facts(['u0', 'u1'])])
        fake.gap_label = 'different_conditions'
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['missing'], [])
        self.assertIn('차이를 반영해', result['feedback']['text'])
        self.assertNotIn('확인할 수 있도록 설명을 보완', result['feedback']['text'])

    def test_absence_classification_cannot_invent_nonperformance(self):
        fake = Fake([self.link, facts(['u0', 'u1'])])
        fake.gap_label = 'explicit_absence'
        result = GroundedJev(fake).decide(self.case)
        self.assertNotIn('하지 않았', result['feedback']['text'])
        self.assertNotIn('설명은 있어요', result['feedback']['text'])

    def test_uncertain_gap_reason_still_names_confirmed_review_conditions(self):
        fake = Fake([self.link, facts(['u0', 'u1'])])
        fake.gap_label = 'unclear'
        result = GroundedJev(fake).decide(self.case)
        self.assertEqual(result['missing'], [])
        self.assertIn('확인할 항목: 본인이 담당한 업무', result['feedback']['text'])
        self.assertNotIn('하지 않았', result['feedback']['text'])

    def test_explicit_measurement_limit_adjusts_claim_instead_of_asking_if_measured(self):
        case = {**self.case, 'facet': 'basis',
                'units': ['만족도를 크게 높였습니다.', '만족도를 측정한 적은 없으며 보호자의 감사 인사를 듣고 쓴 표현입니다.'],
                'question': '무엇과 비교하고 어떻게 확인했나요?',
                'sufficient': '전후 값, 방법, 비교 조건', 'insufficient': '측정 없는 개선 주장'}
        raw = {f'{key}_{uid}': answer('no') for key in ('before', 'after', 'method', 'comparable') for uid in ('u0', 'u1')}
        raw['withdraw_u0'] = answer('no')
        for reason in ('explicit_absence', 'not_explained', 'unclear'):
            fake = Fake([self.link, {'periods': answer('no')}, raw])
            fake.gap_label = reason
            result = GroundedJev(fake).decide(case)
            self.assertEqual(result['label'], 'partial')
            text = result['feedback']['text']
            self.assertEqual('원문에 밝힌' in text, reason == 'explicit_absence')
            if reason == 'explicit_absence':
                self.assertIn('개선 주장의 표현을 조정', text)
                self.assertNotIn('실측한 결과라면', text)
                self.assertNotIn('예시라면', text)

    def test_partial_update_does_not_undo_resolved_answer(self):
        from jev_stream_eval import next_status
        self.assertEqual(next_status('resolved', 'partial'), 'resolved')
        self.assertEqual(next_status('resolved', 'conflict'), 'reopened')

    def test_adopted_audit_keeps_full_prefix_and_rejects_unavailable_evidence(self):
        evidence = [{'id': 'u0', 'text': self.case['units'][0]}]
        fake = Fake([{'valid': answer('no')}])
        reader = GroundedJev(fake)
        self.assertEqual(reader.audit_adopted(self.case, evidence)['label'], 'no')
        self.assertEqual([u['text'] for u in fake.calls[0][0]['sources']], self.case['units'])
        with self.assertRaisesRegex(ValueError, 'invalid_adopted_evidence'):
            reader.audit_adopted(self.case, [{'id': 'u2', 'text': 'future'}])

    def test_missed_withdrawal_recovers_when_old_evidence_is_invalidated_later(self):
        from unittest.mock import patch
        from jev_stream_eval import stream
        class Predicted:
            input_tokens, output_tokens, calls = 0, 0, 0
            def __init__(self, *args, **kwargs):
                self.decisions = 0
            def decide(self, case):
                self.decisions += 1
                self.calls += 1
                return {'label': ['complete', 'unknown', 'partial'][self.decisions - 1],
                        'elapsed_ms': 1, 'evidence': [{'id': 'u1', 'text': 'answer'}]}
            def audit_adopted(self, case, evidence):
                self.calls += 1
                assert evidence == [{'id': 'u1', 'text': 'answer'}]
                return answer('unclear' if self.decisions == 2 else 'no')
        seed = {k: self.case[k] for k in ('facet', 'question', 'sufficient', 'insufficient')}
        seed.update(id='q', origin=0, expected_states={'1': 'resolved', '2': 'resolved', '3': 'reopened'},
                    expected_labels={'1': 'complete', '2': 'unknown', '3': 'partial'})
        data = {'units': ['original', 'answer', 'withdrawal', 'repeated withdrawal'], 'seeds': [seed]}
        with patch('jev_stream_eval.GroundedJev', Predicted):
            result = stream(data, None, None)
        self.assertEqual(result['states']['q'], 'reopened')
        self.assertEqual(result['rows'][-1]['recovery_reason'], 'adopted_evidence_invalidated')
        self.assertEqual(result['calls'], 5)

    def test_stream_carries_predictions_without_future_or_labels(self):
        from unittest.mock import patch
        from jev_stream_eval import stream
        cases = []
        class Predicted:
            input_tokens, output_tokens, calls = 0, 0, 0
            def __init__(self, *args, **kwargs):
                pass
            def decide(self, case):
                cases.append(copy.deepcopy(case))
                self.calls += 1
                return {'label': ['complete', 'conflict', 'unknown'][self.calls - 1], 'elapsed_ms': 1}
        seed = {k: self.case[k] for k in ('facet', 'question', 'sufficient', 'insufficient')}
        seed.update(id='q', origin=0, expected_states={'1':'resolved','2':'reopened','3':'reopened'},
                    expected_labels={'1':'complete','2':'conflict','3':'unknown'})
        data = {'units':['original','answer','withdrawal','uncertain'], 'seeds':[seed]}
        with patch('jev_stream_eval.GroundedJev', Predicted):
            result = stream(data, None, None)
        self.assertEqual([len(c['units']) for c in cases], [2, 3, 4])
        self.assertTrue(all('expected_states' not in c and 'expected_labels' not in c for c in cases))
        self.assertEqual(result['states']['q'], 'reopened')
        self.assertTrue(result['rows'][-1]['uncertain_update'])
        self.assertEqual(result['check_matches'], 3)


if __name__ == '__main__':
    unittest.main()
