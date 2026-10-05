# Laya 추가 개선 · 실제 학습 실험

2026-10-04 KST. 기본 모델의 과도한 보류를 줄이기 위해 실제 파라미터 학습과 비교 평가를 진행했다. 운영 가중치는 그대로이며 아래 후보는 **합성 자료로 학습한 오프라인 실험용**이다. 사람 검수, 대표 이력서 성능, 채용 판단 정확도, 운영 파인튜닝 승인을 뜻하지 않는다.

## 구현

- `python/experiment.py`: 학습/train, 체크포인트 선택/dev, 온도 보정/calibration, 분리 평가/test. dev의 음의 로그 우도(NLL)가 가장 낮은 체크포인트를 고르되 기본 모델도 후보로 유지한다. test는 그 뒤에 평가한다.
- 매 epoch의 실제 선택지 순서를 섞고, 섞인 위치에 맞춰 정답도 이동한다. 평가에서 원래 순서와 역순의 선택 변경을 기록한다. 잘못된 높은 확신, 0.75 이상 선택 수, 질문 해소 후보의 오류를 따로 센다.
- 출력 판단부만 학습하는 모드와 인코더 마지막 두 층까지 학습하는 모드를 비교한다. 인코더 학습률은 판단부의 1/5이다. 인코더 모드의 `head.safetensors`에는 마지막 인코더 층도 포함되므로 기존 head 전용 파일과 혼용하면 안 된다.
- `candidate_probe.py`: 저장한 후보를 별도 프로세스에만 로드해 실제 `runtime.predict`와 같은 입력·선택 기준으로 이전 8개 사례와 문장 진단을 비교한다. 서비스 파일이나 기본 가중치는 수정하지 않는다.
- `data_validation.py`, 기존 `train.py`: ID·그룹 이름만 바꾼 동일 내용의 split 누출을 차단하고, 선언된 문장 계열도 교차를 금지한다. SDK `option_order`를 쓰면 정답 slot을 다시 계산한다. 학습과 실행이 `runtime.encode_checked`의 동일한 토큰/질문 잘림 검사를 사용한다.

이 실험은 일부 head만 라벨이 있는 자료도 사용할 수 있다. 라벨이 없는 head를 자동으로 정답 처리하지 않는다. 생산용 학습의 사람 검수 조건은 유지하고, 별도 실험 경로는 `synthetic=true`, `human_reviewed=false`, `provisional_agent_authored`만 받는다.

## 자료와 해석 범위

`laya-curriculum-v1.jsonl`은 223행이다. 학습 184행/328개 head 판단과 dev·calibration·test 각각 13행/22개 판단으로 시작했다. 독립 검토에서 dev의 “작성자는 동료”를 self로 표시한 라벨 오류와 평가 항목 누락을 발견했다. v1 파일·실행 결과를 수정해 성과처럼 보이지 않고 그대로 보존했다.

`laya-curriculum-v2.jsonl`은 해당 라벨을 other로 고치고, 공통 포괄 주장 문구를 변형했다. 분리 평가마다 두 번째 경험 그룹을 추가해 비교 근거·결과·계획·배경·타인·경험 불명의 관계도 포함했다. 총 260행이며, 학습 200행과 dev·calibration·test 각 20행이다. 데이터 재생성 결과와 버전 보존은 테스트로 확인한다.

내용 fingerprint는 정확한 내용 중복을 정규화해 찾는다. 의미가 비슷한 문장을 모두 찾는 장치는 아니다. 같은 입력에 서로 모순되는 정답을 붙이는 것도 거부한다. 경험 그룹은 분리했지만 반복되는 조건 설명과 합성 문장 특성이 남으며, 각 평가 split은 두 경험뿐이다. actuality/role/method/basis/result/check의 unknown, result missing, 평가 split의 check irrelevant와 relevance mentions는 여전히 없다. v1에서 관찰한 사례 계열이 v2에도 있으므로 **새로운 비공개 평가셋의 제품 정확도로 발표하지 않는다.**

## 실행 기록

v1 판단부만 4epoch 학습: 분리 사례의 임시 라벨 일치 6/22 → 6/22. 높은 확신의 잘못된 선택은 줄었지만, 의미 선택이 개선됐다고 볼 수 없었다.

v1 판단부와 마지막 인코더 2층을 4epoch 학습: 6/22 → 14/22. dev 라벨 오류와 작은 평가 범위가 확인됐으므로 방향 탐색용 기록이다. 이를 운영 성능으로 채택하지 않고 수정한 v2 실험으로 이어갔다.

v2는 기본 모델부터 시작해 seed24, 8epoch, batch4, 판단부 학습률 0.0001 / 인코더 0.00002로 고정했다. epoch마다 dev로 선택하며, calibration 온도는 미리 고정한 0.5–4.0 격자에서 고른다. 0.75 gate는 그대로 둔다. 실제로 24,801,793개 파라미터를 학습했고, 검증 NLL로 4번째 epoch를 선택했다. 총 174.408초, 저장 뒤 기본 가중치로 복원했다가 후보를 다시 로드한 logits 검증도 통과했다.

| 분리된 합성 test의 head 판단 39개 | 기본 모델            | 선택 후보          |
| --------------------------------- | -------------------- | ------------------ |
| 임시 라벨 일치                    | 14/39 (35.9%)        | 20/39 (51.3%)      |
| NLL / Brier (낮을수록 좋음)       | 2.695 / 0.986        | 1.164 / 0.609      |
| 점수 0.75 이상 선택               | 15개, 그중 오답 10개 | 2개, 그중 오답 0개 |
| 선택지 역순에서 라벨 변경         | 10/39                | 15/39              |
| 실제 관계 후보 조건을 통과한 사례 | 0/6                  | 0/6                |

**의미 선택과 과신 일부는 개선됐지만 보류 감소와 순서 안정성에는 실패했다.** 오답 후보 0이라는 숫자는 거의 아무것도 채택하지 않은 결과이며 안전한 해소 능력을 입증하지 않는다. calibration에서 선택한 온도 2.0을 test에 적용하면 일치는 그대로 20/39, NLL은 1.180으로 약간 나빠지고 0.75 이상 선택은 0개다. 이 보정도 운영에 채택하지 않았다.

저장 후보 SHA256: `8b75bdeb2a16a71c11a02478d9359fc7aa27eeac2432a1ac62ec5c66ab52f54a`. v2 학습 데이터는 train 360개 head 판단, dev/calibration/test 각 39개 판단이다. 위 비율은 개별 head 판단 기준이며 이력서 수나 사람 검수 정확도가 아니다.

실제 `runtime.predict` 재검사에서도 앞서 관찰한 8개 prefix의 0.75 gate 결과는 기본·후보 모두 unknown 8/8이었다. 임시 허용 라벨 일치는 unknown을 허용한 사례 하나뿐이다. 문장 진단에서는 팀 주체·실제 수행·미래 계획의 일부 선택이 나아졌지만, 명확한 본인 수행 문장을 타인으로 읽거나 포괄적 참여 주장에 역할 설명이 있다고 고르는 실패가 남았다. 이는 `.local/readme-laya/curriculum-v2-runtime-probe.json`에 모두 보존했다.

수치 연산 문제인지도 한 문장에서 점검했다. MPS 자동 혼합 정밀도/FP32, 여러 head 동시/개별 실행 네 조합에서 선택 라벨이 같았고 점수만 조금 달랐다. `.local/readme-laya/reader-numerics-diagnostic.json`의 단일 사례 확인이며 모든 수치 문제를 배제한 검증은 아니다. 현재 실패를 단순 배치·정밀도 설정 문제로 결론내리지 않았다.

로컬 기록:

- `.local/readme-laya/curriculum-v1-seed24/`: 판단부만 학습한 config/history/metrics/predictions와 체크포인트.
- `.local/readme-laya/curriculum-v1-encoder2-seed24/`: 인코더 일부까지 학습한 v1 기록.
- `.local/readme-laya/curriculum-v2-encoder2-seed24/`: 수정한 v2 학습 기록.
- `.local/readme-laya/curriculum-v2-runtime-probe.json`: 실제 런타임 기본/후보·선택지 순서·문장 진단.
- 각 디렉터리와 같은 이름의 `.log`: 실제 표준 출력과 실행 오류 기록.

첫 실행의 relation_gate.accepted에는 unrelated/unknown을 포함하는 집계 결함이 있었다. 해당 v1 초기 결과는 보존했고, 이후부터 실제 리더처럼 complete/partial/conflict만 세며 scope 오판도 오류로 집계한다. 처음 두 실험의 동작을 재현할 소스는 각 로컬 디렉터리에 별도로 보존했다. v2 실행 당시 소스와 데이터는 해당 디렉터리의 `source/`에 저장했다. 이후 수정은 동일 입력의 모순 라벨 거부, 내용 fingerprint 공용화, 향후 실행의 소스 자동 보존이며 이미 실행한 모델 결과를 바꾸지 않는다.

## 재현

```sh
# 출력은 기존 결과를 덮어쓰지 않는 새 경로를 지정한다.
.local/readme-laya/venv/bin/python src/services/readme-lab/python/experiment.py \
  --model .local/readme-laya/model \
  --data test/fixtures/readme/laya-curriculum-v2.jsonl \
  --out .local/readme-laya/curriculum-v2-new \
  --epochs 8 --lr 0.0001 --encoder-layers 2

.local/readme-laya/venv/bin/python src/services/readme-lab/python/candidate_probe.py \
  --model .local/readme-laya/model --run .local/readme-laya/curriculum-v2-new \
  --cases .local/readme-laya/reader-v2-eval-20261004/run.json \
  --out .local/readme-laya/candidate-probe-new.json

.local/readme-laya/venv/bin/python -m unittest discover -s test -p 'readme*test.py'
```

실험이 끝났다는 이유로 이 파일을 기본 모델 디렉터리에 덮어쓰지 않는다. 운영 승격에는 실제 검수 자료, 그룹별 오류 분석, 유용한 판단 범위와 잘못된 해소율, 모델/가중치 식별 계약이 필요하다. 새로운 학습 후보를 만들었으며 실제 제품 독해 품질의 완료 여부는 별도 문제다.

다음 실험은 규모 확대보다 정답 경계와 반례의 다양성을 먼저 개선해야 한다. 본인/팀/타인의 주체, 역할 설명이 이미 있는 경우, 부분 답과 충분한 답, 후속 정정에 대해 사람이 확인한 기준 사례를 만들고 선택지 순서 변화도 체크포인트 선택 지표에 포함한다. 이번 결과만으로 threshold를 낮추거나 학습 횟수를 계속 늘리는 방식을 채택하지 않는다.

[기준 사례 30개 검수지](readme-label-review-v1.md)에는 현재 원문·조건·선택지와 검수 공란을 준비했다. 임시 모델 라벨은 보이지 않으며 검수 완료·학습 승인으로 등록하지 않았다. 이미 개발 평가에 사용한 사례들이므로 향후 학습으로 옮기면 평가에서는 제외해야 한다.

## 구현 검증

typecheck/lint/format/build 통과, Vitest 137개 통과·DB 의존 6개 생략, Python 17개 통과, `git diff --check` 통과. 빌드는 `.local/readme-lab-build`에 한정했다. 로그는 `.local/readme-laya/curriculum-final-{typecheck,lint,format,build,test,python}.log`다. 이후 추가한 검수지와 결과 기록은 별도 포맷 검사를 거쳤다.

독립 읽기 전용 검토에서 데이터·원시 logits·체크포인트/소스 해시·실제 probe와 위 수치를 재계산했다. 발견된 정답 slot/토큰 검사/내용 누출/후보 집계/라벨 오류/재현 소스 누락을 수정해 재확인했다. 코드 검토를 모델 품질 승인이나 사람의 라벨 검수로 기록하지 않았다. 기본 가중치·HTTP 계약·프론트 디자인·배포는 바꾸지 않았다.
