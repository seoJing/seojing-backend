"""Controlled invariants only; these tests do not measure Jev meaning accuracy."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/services/readme-lab/python"))
from decision_providers import ProviderError
from focus_eval import units_for
from jev_situation_reader import SituationReader, spans


class Provider:
    def __init__(self, relation="complete", identity=True, boundary=True, proof=True, fail_focus=False, kind="entity_definition", claim=True):
        self.requests = []
        self.relation, self.identity, self.boundary, self.proof = relation, identity, boundary, proof
        self.fail_focus = fail_focus
        self.kind, self.claim = kind, claim

    def ask(self, state, heads):
        self.requests.append(deepcopy((state, heads)))
        if self.fail_focus and "context" in heads:
            raise ProviderError("jev_timeout")
        labels = {k: "no" if "no" in h["criteria"] else "none" if "none" in h["criteria"] else "unclear" for k, h in heads.items()}
        if state.get("stage") == "situation_route":
            for k, h in heads.items():
                if k.startswith("s_name_") and any(repr(name) in h["instructions"] for name in ["달고리", "해바퀴", "모래빛"]):
                    labels[k] = "project"
                elif k.startswith("s_recheck_"):
                    labels[k] = "correction" if self.relation == "correction" else "answer"
        elif state.get("stage") == "situation_discovery_audit":
            labels.update(s_grounded="yes", s_expectation=self.kind, s_already_explained="no",
                          s_entity=state["existing_entities"][0]["id"] if state["existing_entities"] else "new")
        elif state.get("stage") == "situation_new_source_audit":
            labels.update(s_grounded="yes", s_unanswered="yes", s_claim="yes" if self.claim else "no")
        elif state.get("stage") == "situation_source_audit":
            labels.update(s_identity="yes" if self.identity else "no", s_boundary="yes" if self.boundary else "no",
                          s_relation=self.relation, s_proof="yes" if self.proof else "no")
        return {"answers": {k: {"label": labels[k], "confidence": .99, "probabilities": {c: float(c == labels[k]) for c in h["criteria"]}} for k, h in heads.items()},
                "usage": {"input_tokens": 10, "output_tokens": 2}}


class SituationTest(unittest.TestCase):
    def test_exact_span_offsets_are_utf16_and_generic(self):
        values = spans('🚀달고리는 반납 알림 서비스입니다.')
        item = next(c for c in values if c['name'] == '달고리')
        self.assertEqual((item['start'], item['end']), (2, 5))
        self.assertTrue(any(c['name'] == 'Unknown-7' for c in spans('Unknown-7 프로젝트')))
        self.assertTrue(any(c['name'] == '오케이징' for c in spans('오케이징이 서비스입니다.')))
        self.assertTrue(any(c['name'] == '달고리' for c in spans('달고리가 서비스입니다.')))

    def test_name_without_selected_claim_does_not_create_overview_expectation(self):
        provider = Provider(kind="overview_detail", claim=False)
        reader = SituationReader(provider)
        result = reader.step({'prefix': units_for(['# 달고리']), 'role_context': ''})
        self.assertEqual(result['events'], [])
        self.assertEqual(reader.expectations, [])
        self.assertEqual(reader.diagnostics['new_claim_rejected'], 1)
        audit_heads = next(heads for state, heads in provider.requests if state.get('stage') == 'situation_new_source_audit')
        self.assertIn('개요 주장', audit_heads['s_claim']['instructions'])

    def test_single_budget_source_bound_update_and_finish(self):
        provider = Provider(); reader = SituationReader(provider)
        units = units_for(['달고리 프로젝트입니다.', '달고리는 반납 알림 서비스입니다.'])
        first = reader.step({'prefix': units[:1], 'role_context': ''})
        self.assertEqual(first['events'][0]['type'], 'attention_created')
        self.assertEqual(reader.provider, reader.focus.provider)
        result = reader.step({'prefix': units, 'role_context': ''})
        self.assertEqual([e['type'] for e in result['events']], ['source_revisit', 'expectation_updated'])
        self.assertEqual(reader.expectations[0]['evidence'][0]['quote'], units[1]['text'])
        self.assertEqual(reader.entities[0]['status'], 'explained')
        self.assertEqual(reader.metrics()['calls'], len(provider.requests))
        self.assertEqual(reader.metrics()['input_tokens'], 10 * len(provider.requests))
        finished = reader.finish(2)
        self.assertEqual(finished['final_events'], [])
        with self.assertRaises(ValueError): reader.finish(2)

    def test_focus_failure_restores_both_ledgers_but_keeps_spend(self):
        p = Provider(fail_focus=True); reader = SituationReader(p)
        before = reader.snapshot()
        with self.assertRaisesRegex(ProviderError, 'jev_timeout'):
            reader.step({'prefix': units_for(['달고리 프로젝트입니다.']), 'role_context': ''})
        self.assertEqual(reader.snapshot(), before)
        self.assertEqual(reader.prefix, [])
        self.assertEqual(reader.focus.prefix, [])
        self.assertTrue(all(v == 0 for v in reader.diagnostics.values()))
        self.assertGreaterEqual(reader.metrics()['calls'], 3)
        self.assertGreater(reader.metrics()['input_tokens'], 0)

    def test_source_audit_gates_identity_actor_plan_and_actual_proof(self):
        for options, counter in [({'identity': False}, 'rejected_identity'), ({'boundary': False}, 'rejected_boundary'), ({'proof': False}, 'missing_proof')]:
            reader = SituationReader(Provider(**options))
            units = units_for(['달고리 프로젝트입니다.', '다른 사람이 계획한 작업입니다.'])
            reader.step({'prefix': units[:1], 'role_context': ''})
            result = reader.step({'prefix': units, 'role_context': ''})
            self.assertEqual(result['events'], [])
            self.assertEqual(reader.expectations[0]['status'], 'pending')
            self.assertEqual(reader.diagnostics[counter], 1)
            self.assertEqual(reader.finish(2)['final_events'][0]['expectation']['status'], 'unresolved_at_end')

    def test_correction_withdraws_proof_and_reexplanation_does_not_restore_it(self):
        p = Provider(); reader = SituationReader(p)
        units = units_for(['달고리 프로젝트입니다.', '달고리는 예약 서비스입니다.', '정정합니다. 반납 알림 서비스입니다.', '반납일을 알려 주는 서비스입니다.'])
        for n in (1,2): reader.step({'prefix': units[:n], 'role_context': ''})
        p.relation = 'correction'; reader.step({'prefix': units[:3], 'role_context': ''})
        self.assertEqual(reader.entities[0]['status'], 'noticed')
        self.assertEqual(reader.expectations[0]['withdrawn_evidence'][0]['unit_id'], 'u2')
        p.relation = 'complete'; reader.step({'prefix': units, 'role_context': ''})
        self.assertEqual([p['unit_id'] for p in reader.expectations[0]['evidence']], ['u4'])
        self.assertEqual(reader.expectations[0]['state_version'], 4)

    def test_three_names_create_one_active_and_two_parked(self):
        reader = SituationReader(Provider())
        result = reader.step({'prefix': units_for(['달고리 해바퀴 모래빛 프로젝트입니다.']), 'role_context': ''})
        self.assertEqual([q['focus'] for q in reader.expectations], ['active', 'parked', 'parked'])
        self.assertEqual(len(result['events']), 3)
        self.assertEqual(len(reader.finish(1)['final_events']), 3)

    def test_call_budget_failure_is_atomic(self):
        reader = SituationReader(Provider(), max_calls=1)
        with self.assertRaisesRegex(ProviderError, 'jev_call_budget_exceeded'):
            reader.step({'prefix': units_for(['달고리 프로젝트입니다.']), 'role_context': ''})
        self.assertEqual(reader.snapshot(), {'entities': [], 'expectations': [], 'questions': []})
        self.assertEqual(reader.metrics()['calls'], 1)

    def test_invalid_prefix_or_changed_role_makes_no_provider_call(self):
        p = Provider(); reader = SituationReader(p); units = units_for(['일반 설명입니다.', '다음 설명입니다.'])
        reader.step({'prefix': units[:1], 'role_context': '직무'})
        calls = len(p.requests)
        for changed in [{'prefix': units, 'role_context': '다른 직무'}, {'prefix': [{**units[0], 'text': '조작'}, units[1]], 'role_context': '직무'}]:
            with self.assertRaises(ValueError): reader.step(changed)
        self.assertEqual(len(p.requests), calls)
        with self.assertRaisesRegex(ValueError, 'reader_not_complete'): reader.finish(2)


if __name__ == '__main__': unittest.main()
