"""Pinned Laya decision worker. One JSON request per line; never logs source text."""
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time

MODEL_ID = "convaiinnovations/laya-multilingual"
REVISION = "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67"
QUESTIONS = {
    "signal": {
        "type": "choice",
        "instructions": "현재 이력서 문장의 서술 구체성을 판단한다. 기록 밖의 사실을 추측하지 않는다.",
        "criteria": {
            "concrete": "지원자의 구체적인 역할, 행동, 산출물 또는 측정 근거가 있다",
            "claim": "참여, 기여, 역량, 성과를 주장하지만 구체적인 설명이 부족하다",
            "context": "제목, 기간, 배경 등 맥락이며 역량 주장은 아니다",
            "unclear": "의미나 주체를 판단하기 어렵다",
        },
    },
    "missing": {
        "type": "choice",
        "instructions": "현재 문장의 주장을 이해하기 위해 가장 먼저 확인할 누락 정보를 고른다. 이미 설명된 내용을 묻지 않는다.",
        "criteria": {
            "role": "팀 성과와 구별되는 본인의 역할",
            "method": "구체적으로 한 행동이나 방법",
            "basis": "수치나 성과의 비교 기준과 측정 근거",
            "none": "추가 확인이 필요 없거나 역량 주장이 아니다",
        },
    },
}
RELATION = {
    "relation": {
        "type": "choice",
        "instructions": "이전에 보류한 질문과 현재 문장을 비교한다. 같은 경험임이 확인되고 질문에 직접 답해야 해소 후보이다.",
        "criteria": {
            "answers": "동일 경험의 현재 문장이 질문에 직접 답한다",
            "partial": "일부 설명은 있으나 질문에 충분히 답하지 않는다",
            "unrelated": "다른 경험이거나 질문과 무관하다",
            "uncertain": "동일 경험 또는 질문 해소 여부를 알 수 없다",
        },
    },
}
RELEVANCE = {
    "relevance": {
        "type": "choice",
        "instructions": "현재 문장이 공고 요건과 연결되는 구체적인 경험 근거인지 판단한다. 단어만 겹치는 것은 근거가 아니다.",
        "criteria": {
            "supports": "현재 문장의 구체적인 행동이 이 요건과 직접 관련된다",
            "mentions": "요건을 언급하나 행동 근거는 부족하다",
            "unrelated": "요건과 관련 없거나 판단할 수 없다",
        },
    },
}

def choice(instructions, criteria):
    return {"type": "choice", "instructions": instructions, "criteria": criteria}


READER_UNIT = {
    "actor": choice("현재 문장에서 수행한 사람을 고른다. 팀의 행동을 본인 행동으로 바꾸지 않는다.", {
        "self": "지원자 본인이 수행", "team": "팀 전체가 수행", "other": "다른 사람이 수행", "unknown": "주체 불명확"}),
    "actuality": choice("현재 문장이 설명하는 경험의 수행 상태를 고른다.", {
        "performed": "수행한 행동 또는 성과 주장", "planned": "앞으로 할 계획", "negated": "수행하지 않았거나 앞선 설명 정정", "context": "제목 또는 배경 정보", "unknown": "판단 불가"}),
}
for facet, name in (("role", "본인이 맡은 역할"), ("method", "실제로 한 행동과 방법"),
                    ("result", "행동으로 얻은 결과"), ("basis", "비교 성과의 측정 대상과 전후 기준")):
    READER_UNIT[facet] = choice(f"현재 주장과 같은 경험의 {name} 설명을 확인한다. 제공된 과거 설명도 인정한다.", {
        "present": "필요한 설명이 현재 또는 같은 경험의 과거에 있음",
        "missing": "현재 주장을 이해하는 데 필요하지만 설명이 없음",
        "irrelevant": "현재 주장에는 이 확인 항목이 필요하지 않음", "unknown": "맥락이나 의미가 불명확"})

READER_RELATION = {
    "scope": choice("original과 current가 동일한 경험인지 판단한다. 같은 제목이나 단어만으로 확정하지 않는다.", {
        "same": "동일 경험의 연속 설명", "different": "서로 다른 경험", "unknown": "동일 경험 여부 불명확"}),
    "relation": choice("current가 question의 sufficient 조건에 답하는지 본다. insufficient 반례와 evidence를 고려한다.", {
        "complete": "질문에 필요한 설명을 모두 제공", "partial": "질문의 일부만 설명", "conflict": "기존 답변과 모순 또는 정정",
        "unrelated": "질문에 대한 설명이 아님", "unknown": "판단 불가"}),
}
READER_CHECK = {
    "check": choice("current에 check.trigger가 적용되는지 확인한다. previous의 동일 경험 설명도 고려한다.", {
        "needed": "질문 조건이 적용되며 충분한 설명이 아직 없음", "explained": "충족 조건을 이미 설명함",
        "irrelevant": "현재 주장에 이 질문 조건이 적용되지 않음", "unknown": "판단 불가"}),
}


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_agent(model_dir):
    import laya
    import torch
    if importlib.metadata.version("laya") != "0.3.25":
        raise RuntimeError("sdk_version_mismatch")
    manifest = json.loads((model_dir / "manifest.json").read_text())
    if manifest["revision"] != REVISION:
        raise RuntimeError("model_revision_mismatch")
    for name, sha in manifest["runtime_sha256"].items():
        if digest(model_dir / name) != sha:
            raise RuntimeError("model_digest_mismatch")
    device = os.environ.get("README_LAYA_DEVICE", "mps" if torch.backends.mps.is_available() else "cpu")
    torch.set_num_threads(4)
    with contextlib.redirect_stdout(sys.stderr):
        agent = laya.load(str(model_dir), device=device, backend="eager", fast=False, compile=False)
    return agent, {"model": MODEL_ID, "revision": REVISION, "sdk": "0.3.25", "device": device,
                   "weights_sha256": manifest["runtime_sha256"]["model.safetensors"],
                   "finetuned": False, "calibrated_for_readme": False}


def encode_checked(agent, state, questions, strict_head=False):
    # Inspect the SDK's actual tokenization. Refuse hidden truncation rather than
    # judging a state whose last sentence was silently lost.
    internal = {key: agent._to_internal(q) for key, q in questions.items()}
    if strict_head:
        from laya.common import build_head, render_options, _encode_question_text
        for question in internal.values():
            order = question.get("option_order")
            ids, markers, _ = build_head(agent.tok, question, 256, option_order=order)
            instruction = _encode_question_text(agent.tok, "%s question: %s" % (question["t"], str(question["ins"]).replace(agent.tok.mask_token, " ")), add_special_tokens=False)
            if ids[1:markers[0] - 1] != instruction:
                raise ValueError("context_budget_exceeded")
            options = render_options(question)
            if order is not None:
                options = [options[i] for i in order]
            for index, option in enumerate(options):
                tokens = _encode_question_text(agent.tok, " " + option.replace(agent.tok.mask_token, " "), add_special_tokens=False)
                end = markers[index + 1] if index + 1 < len(markers) else len(ids) - 1
                if ids[markers[index] + 1:end] != tokens:
                    raise ValueError("context_budget_exceeded")
    items = agent._encode_state(state, list(questions), internal, max_len=1024, head_max_len=256)
    if any(item["state_stats"]["truncated"] for item in items):
        raise ValueError("context_budget_exceeded")
    if any(item["options"]["options_distinct"] != item["options"]["options"] for item in items):
        raise ValueError("question_budget_exceeded")
    return items


def predict(agent, state, questions, strict_head=False):
    encode_checked(agent, state, questions, strict_head)
    with contextlib.redirect_stdout(sys.stderr):
        result = agent.predict(state, questions, lang="ko", max_len=1024, head_max_len=256)
    return {key: {"label": value["choice"], "confidence": value["answer_confidence"]}
            for key, value in result["answers"].items()}


def main():
    started = time.monotonic()
    agent, metadata = load_agent(Path(sys.argv[1]).resolve())
    print(json.dumps({"ready": metadata, "load_ms": round((time.monotonic() - started) * 1000)}), flush=True)
    for line in sys.stdin:
        started = time.monotonic()
        request_id = None
        try:
            if len(line) > 32000:
                raise ValueError("request_too_large")
            request = json.loads(line)
            request_id = request["id"]
            kind = request["kind"]
            questions = {"unit": QUESTIONS, "relation": RELATION, "relevance": RELEVANCE,
                         "reader_unit": READER_UNIT, "reader_relation": READER_RELATION, "reader_check": READER_CHECK}[kind]
            result = predict(agent, request["state"], questions, strict_head=kind.startswith("reader_"))
            response = {"id": request_id, "result": result, "elapsed_ms": round((time.monotonic() - started) * 1000)}
        except (ValueError, KeyError) as error:
            code = "context_budget_exceeded" if str(error) in ("context_budget_exceeded", "question_budget_exceeded") else "engine_input_invalid"
            response = {"id": request_id, "error": code}
        except Exception:
            response = {"id": request_id, "error": "engine_unavailable"}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
