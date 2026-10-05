"""Reproducible provisional synthetic curriculum, never human-approved training.

Experience groups do not cross splits. V1 retains shared held-out scaffolding;
v2 varies that prose and corrects/expands labels after review. These are small
agent-authored development experiments, not a representative hiring benchmark.
Only explicitly labelled heads are taught. Neither corpus is human-approved.
"""
import argparse
import json
from pathlib import Path


def dataset():
    rows = []

    def add(split, family, group, kind, state, labels):
        rows.append({"id": f"{split}-{len(rows) + 1}", "group_id": f"{split}:{group}",
                     "template_family": family, "split": split, "kind": kind,
                     "state": state, "labels": labels, "synthetic": True,
                     "human_reviewed": False, "label_status": "provisional_agent_authored"})

    domains = [
        ("독서 모임", "참가자 명단", "등록 자료", "도서관", "접수 누락"),
        ("박람회", "부스 배치도", "참가 신청서", "전시장", "대기 시간"),
        ("상담 센터", "예약 현황표", "예약 기록", "상담실", "예약 중복"),
        ("물류 창고", "재고 보고서", "입출고 내역", "창고", "재고 오류"),
        ("온라인 강의", "학습 안내서", "수강 신청 내역", "교육장", "수강 문의"),
        ("연구실", "실험 기록지", "관측 자료", "실험실", "입력 오류"),
        ("동아리 공연", "공연 안내장", "좌석 신청서", "공연장", "입장 지연"),
        ("급식 봉사", "배식 일정표", "신청 인원표", "식당", "배식 대기"),
    ]
    for name, output, source, place, measure in domains:
        def put(kind, state, labels):
            add("train", "train-direct-and-contrast", name, kind, state, labels)
        for text, actor, actual in [
            (f"{name}에서 제가 {output}를 직접 작성했습니다.", "self", "performed"),
            (f"{name}의 팀원 전체가 함께 {output}를 작성했습니다.", "team", "performed"),
            (f"{name}에서 동료 민수가 {output}를 작성했습니다.", "other", "performed"),
            (f"{name}에서는 제가 다음 달에 {output}를 작성할 계획입니다.", "self", "planned"),
            (f"{name}에서 제가 {output}를 작성했다는 설명은 잘못됐습니다. 저는 작성하지 않았습니다.", "self", "negated"),
            (f"{name} 장소는 {place}이고 기간은 3월입니다.", "unknown", "context"),
        ]:
            put("reader_unit", {"current": text, "previous": [], "context_limited": False}, {"actor": actor, "actuality": actual})
        for current, previous, labels in [
            (f"{name}의 성공적인 운영에 기여했습니다.", [], {"role": "missing", "method": "missing"}),
            (f"{name}의 운영에 기여했습니다.", [{"id": "u1", "text": f"{name}에서 저는 {source}를 대조해 {output}의 틀린 항목을 수정했습니다."}], {"role": "present", "method": "present"}),
            (f"{name}에서 {measure}를 20% 줄였습니다.", [], {"basis": "missing", "result": "present"}),
            (f"{name}에서 같은 조건의 전월 50건과 이번 달 40건을 {source}에서 집계해 {measure}가 20% 줄었음을 확인했습니다.", [], {"basis": "present", "result": "present"}),
            (f"{name}의 장소는 {place}입니다.", [], {"role": "irrelevant", "method": "irrelevant", "result": "irrelevant", "basis": "irrelevant"}),
        ]:
            put("reader_unit", {"current": current, "previous": previous, "context_limited": False}, labels)
        question = f"{name}에서 본인이 맡은 일은 무엇인가요?"
        original = f"{name} 운영을 지원했습니다."
        sufficient = f"{name}에서 본인이 수행한 구체적인 업무"
        insufficient = "팀 전체 업무, 다른 경험 또는 계획만 제시"
        for current, scope, relation, evidence in [
            (f"그 {name}에서 제가 {output}의 초안을 작성하고 {source}와 대조했습니다.", "same", "complete", []),
            (f"그 {name}에서 우리 팀이 {output}를 작성했지만 개인의 담당은 구분하지 않았습니다.", "same", "partial", []),
            (f"{name}과 별개인 여행에서 제가 숙소 예약을 맡았습니다.", "different", "unrelated", []),
            (f"그 {name}의 개최 장소는 {place}였습니다.", "same", "unrelated", []),
            (f"{name}의 {output}를 제가 썼다는 앞의 설명을 정정합니다. 다른 사람이 작성했습니다.", "same", "conflict", [f"제가 {output}를 작성했습니다."]),
        ]:
            put("reader_relation", {"question": question, "sufficient": sufficient, "insufficient": insufficient,
                                   "original": original, "current": current, "evidence": evidence}, {"scope": scope, "relation": relation})
        for current, label in [
            (f"제가 {source}를 확인하면서 {output}를 작성했습니다.", "supports"),
            (f"{output} 작성 업무에 관심이 있습니다.", "mentions"),
            ("취미로 수영을 합니다.", "unrelated"),
        ]:
            put("relevance", {"current": current, "requirement": f"{name} {output} 작성 경험"}, {"relevance": label})
        check = {"facet": "role", "trigger": f"{name}에 기여했다고 주장하지만 개인 역할 설명이 없음",
                 "sufficient": sufficient, "insufficient": insufficient}
        for current, previous, label in [
            (original, [], "needed"),
            (original, [f"그 {name}에서 제가 {output}를 작성했습니다."], "explained"),
            (f"그 {name}에서 제가 {output}를 작성했습니다.", [], "explained"),
            (f"{name} 장소는 {place}였습니다.", [], "irrelevant"),
        ]:
            put("reader_check", {"current": current, "previous": previous, "check": check}, {"check": label})

    # Separate prose families, domains and experience groups. Their labels are
    # independently explicit; no answer from a later unit labels an earlier prefix.
    suites = [
        ("dev", "박물관 도슨트", "관람 동선표", "회차별 신청 인원", "교통 지도", [
            "관람 동선표를 쓴 사람은 저입니다. 회차별 신청 인원을 확인하며 표를 완성했어요.",
            "관람 동선표는 우리 조 공동 작업이고 사람별 분량은 밝히지 않았습니다.",
            "앞에서 제 작품이라고 했던 관람 동선표의 작성자는 동료였어요. 제 설명을 바로잡습니다.",
            "그 프로젝트와는 관계없는 등산에서 교통 지도를 제작했습니다.",
        ]),
        ("calibration", "환경 캠페인", "수거 구역도", "신청 주소", "음악회 포스터", [
            "제 담당은 신청 주소를 분류해서 수거 구역도로 옮기는 일이었습니다.",
            "여러 사람이 수거 구역도를 함께 만들었다는 것 외에 내 작업은 따로 적지 않았어요.",
            "수거 구역도를 제가 제작했다는 기술을 취소합니다. 제작에 참여하지 않았어요.",
            "다른 시기에 진행한 음악회에서 포스터를 그린 경력입니다. 캠페인과는 다른 활동입니다.",
        ]),
        ("test", "보건소 예방접종", "접종 예약표", "방문 희망 시간", "장학금 신청서", [
            "저에게 배정된 작업은 방문 희망 시간을 받아 겹치는 시간을 조정하고 접종 예약표에 반영하는 것이었어요.",
            "접종 예약표는 보건소 직원들이 공동으로 작성했고 제가 쓴 부분은 구분하지 않았어요.",
            "접종 예약표를 작성했다는 앞 문장의 주어가 틀렸습니다. 저는 작성 담당자가 아니었습니다.",
            "접종 활동이 아닌 별도의 장학 사업에서 신청서를 정리한 일입니다.",
        ]),
    ]
    for split, name, output, source, other, texts in suites:
        def put(kind, state, labels):
            add(split, f"{split}-independent-prose", name, kind, state, labels)
        original = f"{name}에 힘을 보탰습니다."
        question = f"{name}에서 직접 담당한 일의 범위가 궁금합니다."
        sufficient = "해당 활동에서 지원자가 실제로 한 업무를 구체적으로 밝힘"
        insufficient = "집단 성과, 차후 계획, 별개 활동은 개인 담당의 답이 아님"
        for text, scope, relation, evidence in [
            (texts[0], "same", "complete", []), (texts[1], "same", "partial", []),
            (texts[2], "same", "conflict", [texts[0]]), (texts[3], "different", "unrelated", []),
        ]:
            put("reader_relation", {"question": question, "sufficient": sufficient, "insufficient": insufficient,
                                   "original": original, "current": text, "evidence": evidence}, {"scope": scope, "relation": relation})
        # A role can be explained before the generic claim. Retain prior raw text.
        put("reader_unit", {"current": original, "previous": [{"id": "u1", "text": texts[0]}], "context_limited": False}, {"role": "present", "method": "present"})
        put("reader_unit", {"current": original, "previous": [], "context_limited": False}, {"role": "missing", "method": "missing"})
        put("reader_unit", {"current": texts[0], "previous": [], "context_limited": False}, {"actor": "self", "actuality": "performed"})
        put("reader_unit", {"current": texts[1], "previous": [], "context_limited": False}, {"actor": "team", "actuality": "performed"})
        put("reader_unit", {"current": texts[2], "previous": [], "context_limited": False}, {"actor": "self", "actuality": "negated"})
        check = {"facet": "role", "trigger": "활동 기여 주장에 개인 역할이 빠짐", "sufficient": sufficient, "insufficient": insufficient}
        put("reader_check", {"current": original, "previous": [], "check": check}, {"check": "needed"})
        put("reader_check", {"current": original, "previous": [texts[0]], "check": check}, {"check": "explained"})
        put("relevance", {"current": texts[0], "requirement": f"{output} 작성 경험"}, {"relevance": "supports"})
        put("relevance", {"current": texts[3], "requirement": f"{output} 작성 경험"}, {"relevance": "unrelated"})
    return rows


def dataset_v2():
    rows = dataset()
    # Preserve v1 exactly; v2 corrects the actor named in its dev correction.
    next(r for r in rows if r["id"] == "dev-193")["labels"]["actor"] = "other"
    changes = {
        "dev": ("박물관 도슨트에 힘을 보탰습니다.", "박물관 도슨트 프로그램이 원활하게 진행되도록 도왔어요."),
        "calibration": ("환경 캠페인에 힘을 보탰습니다.", "환경 캠페인의 성사에 일조한 경험을 소개합니다."),
        "test": ("보건소 예방접종에 힘을 보탰습니다.", "보건소 예방접종 업무에 참여하며 운영을 지원한 바 있습니다."),
    }
    def replace(value, old, new):
        if isinstance(value, str):
            return value.replace(old, new)
        if isinstance(value, dict):
            return {k: replace(v, old, new) for k, v in value.items()}
        if isinstance(value, list):
            return [replace(v, old, new) for v in value]
        return value
    for row in rows:
        if row["split"] in changes:
            row["state"] = replace(row["state"], *changes[row["split"]])
        row["corpus_version"] = 2
    def add(split, group, kind, state, labels):
        rows.append({"id": f"v2-{split}-{len(rows)+1}", "group_id": f"{split}:{group}",
                     "template_family": f"{split}-v2-boundaries", "split": split, "kind": kind,
                     "state": state, "labels": labels, "synthetic": True, "human_reviewed": False,
                     "label_status": "provisional_agent_authored", "corpus_version": 2})
    for group in ["독서 모임", "박람회", "상담 센터", "물류 창고", "온라인 강의", "연구실", "동아리 공연", "급식 봉사"]:
        common = {"question": f"{group}에서 본인이 한 구체적인 업무는?", "sufficient": "같은 활동에서 직접 수행한 일",
                  "insufficient": "다른 활동, 주체 불명 또는 차후 계획", "original": f"{group}에서 운영 지원을 했습니다.", "evidence": []}
        add("train", group, "reader_relation", {**common, "current": "문서가 일부 지워져 이 내용이 어느 활동인지, 담당자가 누구인지 확인할 수 없습니다."}, {"scope": "unknown", "relation": "unknown"})
        add("train", group, "reader_relation", {**common, "current": f"그 {group}에서는 참여만 했고 직접 문서를 작성하지 않았습니다. 다음에는 작성할 계획입니다."}, {"scope": "same", "relation": "partial"})
    extras = {
        "dev": {
            "group": "번역 봉사", "claim": "번역 봉사에서 교정 시간을 절반으로 줄였습니다.",
            "basis": "같은 분량의 문서 열 건을 처리하는 시간을 재니 이전에는 60분, 개선 뒤에는 30분이 걸렸어요.",
            "planned": "다음 학기에 제가 번역 봉사 일정표를 만들 예정이에요.",
            "context": "번역 봉사 활동 기간: 8월 한 달.",
            "other": "번역 봉사 결과물의 최종 검수는 지도 교수가 했어요.",
            "unknown": "두 활동에 대한 설명이 섞였으며 어느 쪽의 일인지는 알 수 없어요.",
        },
        "calibration": {
            "group": "사진 전시", "claim": "사진 전시의 접수 처리 속도를 두 배 높였다고 적었습니다.",
            "basis": "동일한 사진 40장의 접수 완료까지 걸린 시간을 비교했고, 변경 전 20분이던 작업이 변경 후 10분이었습니다.",
            "planned": "아직 실행 전이며, 사진 전시의 다음 회차에서 제가 접수 안내를 맡기로 했어요.",
            "context": "사진 전시는 시청 1층에서 열린 행사였어요.",
            "other": "사진 전시의 접수 프로그램을 고친 담당자는 동료예요.",
            "unknown": "행사가 여럿이라 이 후속 기록이 어떤 행사에 속하는지 자료상으로 구별되지 않습니다.",
        },
        "test": {
            "group": "기부 물품 분류", "claim": "기부 물품 분류에 소요되는 시간이 50% 감소했다고 주장합니다.",
            "basis": "전후 모두 물품 100개의 분류가 끝날 때까지 초시계로 측정했으며 변경 전 80분, 변경 후 40분을 기록했습니다.",
            "planned": "기부 물품 분류표 작성을 제 향후 업무로 정했지만 아직 시작하지 않았어요.",
            "context": "기부 물품 분류 장소는 주민센터 지하 회의실이에요.",
            "other": "기부 물품 분류 기준을 설계한 이는 외부 담당자이고 저는 설계자가 아닙니다.",
            "unknown": "연결 대상 경험을 식별할 이름이나 시기가 빠져 어느 경험의 후속 설명인지 특정할 수 없습니다.",
        },
    }
    for split, case in extras.items():
        def unit(text, labels, previous=None):
            add(split, case["group"], "reader_unit", {"current": text, "previous": previous or [], "context_limited": False}, labels)
        unit(case["claim"], {"basis": "missing", "result": "present"})
        unit(case["basis"], {"basis": "present", "result": "present"}, [{"id": "u1", "text": case["claim"]}])
        unit(case["planned"], {"actor": "self", "actuality": "planned"})
        unit(case["context"], {"actor": "unknown", "actuality": "context", "role": "irrelevant", "method": "irrelevant", "result": "irrelevant", "basis": "irrelevant"})
        unit(case["other"], {"actor": "other"})
        add(split, case["group"], "reader_relation", {"original": case["claim"], "current": case["unknown"],
            "question": "그 업무에서 본인이 직접 맡은 부분은 무엇인가요?", "sufficient": "같은 경험의 개인 담당 업무",
            "insufficient": "어느 경험인지 불명확한 설명", "evidence": []}, {"scope": "unknown", "relation": "unknown"})
        add(split, case["group"], "reader_relation", {"original": case["claim"], "current": case["basis"],
            "question": "시간 변화는 어떤 기준으로 비교했나요?", "sufficient": "같은 대상의 변경 전후 측정 시간과 측정 방법",
            "insufficient": "비교 전 기준 없이 개선 숫자만 반복", "evidence": []}, {"scope": "same", "relation": "complete"})
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", type=int, choices=[1, 2], default=1)
    args = parser.parse_args()
    rows = dataset() if args.version == 1 else dataset_v2()
    with args.out.open("x") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"rows": len(rows), "human_reviewed": False}))
