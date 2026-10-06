"""Offline protocol/invariant tests. No remote model or credentials."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/services/readme-lab/python"))
from decision_providers import ProviderError
from focus_eval import units_for
from jev_focus_reader import FocusReader, MAX_REQUEST_CHARS
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


if __name__ == "__main__":
    unittest.main()
