/** Authored UI examples only. Never a classifier, model result, or runtime fallback. */
import { buildDocument } from "../document.js";
import { validateProfile, validateReport } from "../codex.js";
import type {
  Block,
  EventPayload,
  JobView,
  Note,
  PrepareView,
  Question,
  ReadingEvent,
} from "../contracts.js";

const jobText =
  "필수: 참여자 일정 조정, 안내문 작성, 프로그램 결과 보고서 작성 경험. 우대: 협력 기관과 업무 조율 경험.";
const job = validateProfile(
  {
    requirements: [
      { kind: "required", label: "일정 조정", quote: "참여자 일정 조정" },
      { kind: "required", label: "안내문 작성", quote: "안내문 작성" },
      {
        kind: "required",
        label: "결과 보고",
        quote: "프로그램 결과 보고서 작성 경험",
      },
      {
        kind: "preferred",
        label: "기관 간 조율",
        quote: "협력 기관과 업무 조율 경험",
      },
    ],
  },
  jobText,
);
const blocks: Array<Pick<Block, "type" | "text" | "level">> = [
  { type: "heading", level: 1, text: "# 지역 문화 행사 운영" },
  {
    type: "paragraph",
    text: "지역 행사 운영을 지원했습니다. 행사는 주말마다 세 차례 열렸습니다. 신청자들은 전화와 온라인으로 접수했습니다. 제가 참여자 일정 조정과 안내문 작성을 담당했습니다. 신청 가능 시간을 표로 정리했습니다. 일정이 겹친 참여자에게 대체 회차를 안내했습니다. 변경 사항은 담당자에게 매일 전달했습니다.",
  },
  {
    type: "list_item",
    text: "- 참여자 만족도를 높였습니다. 종료 후 종이 설문을 배포했습니다. 응답은 익명으로 받았습니다. 설문에는 운영 시간과 안내 내용에 관한 항목이 있었습니다. 안내가 이해하기 쉬웠다는 의견을 결과 보고서에 정리했습니다. 이전 행사와 같은 문항을 사용했는지는 기록하지 않았습니다. 행사 사진 정리는 다른 담당자가 맡았습니다.",
  },
  { type: "heading", level: 1, text: "# 청년 교육 프로그램" },
  {
    type: "paragraph",
    text: "협력 기관과 일정 충돌을 해결했습니다. 두 기관이 같은 교육실을 요청한 상황이었습니다. 저는 각 기관의 필수 사용 시간을 확인했습니다. 변경 가능한 시간을 표로 공유하고 양쪽 담당자와 조정안을 합의했습니다. 확정 일정은 공동 달력에 반영했습니다. 교육실 사용 안내도 수정했습니다. 프로그램은 네 주 동안 진행됐습니다.",
  },
  {
    type: "list_item",
    text: "- 운영 보고서 초안은 팀이 함께 작성했습니다. 저는 출석 기록과 회차별 운영 일지를 정리했습니다. 회의에서는 진행 중인 문제를 공유했습니다. 보고서의 다른 부분은 역할을 나눠 작성했습니다. 전체 문서의 최종 검토는 팀장이 맡았습니다. 배포용 안내문에는 장소와 준비물을 넣었습니다. 문의가 반복된 항목은 다음 회차 안내에 추가했습니다.",
  },
  { type: "heading", level: 1, text: "# 마을 도서관 활동" },
  {
    type: "paragraph",
    text: "제가 독서 모임의 신청 안내문을 작성했습니다. 신청 기간과 참여 조건을 표로 배치했습니다. 안내문은 도서관 게시판에 붙였습니다. 팀 전체의 활동으로 신규 참여자가 늘었습니다. 같은 기간 도서관에서 홍보 행사도 열렸습니다. 저는 모임의 장소를 예약했습니다. 진행자에게 참석 예정 명단을 전달했습니다. 모임은 월말에 마무리됐습니다. 다음 분기에도 활동을 이어갈 계획입니다.",
  },
];
type AuthoredNote = {
  at: string;
  kind: Note["kind"];
  text: string;
  question?: string;
  requirements?: string[];
};
type AuthoredItem = {
  category: "explained" | "open" | "improve";
  text: string;
  reason: string;
  note_ids: string[];
  requirement_ids: string[];
};
const shortNotes: AuthoredNote[] = [
  {
    at: "지역 행사 운영을 지원했습니다.",
    kind: "question",
    question: "q1",
    text: "행사 운영에서 직접 맡은 업무는 무엇이었을까?",
    requirements: ["r1", "r2"],
  },
  {
    at: "참여자 일정 조정과 안내문 작성을 담당했습니다.",
    kind: "hold",
    question: "q1",
    text: "일정 조정과 안내문 작성이 담당 업무로 나온다. 앞선 역할 질문에 답하는 설명 후보다.",
    requirements: ["r1", "r2"],
  },
  {
    at: "참여자 만족도를 높였습니다.",
    kind: "question",
    question: "q2",
    text: "어떤 조사와 비교 자료로 만족도가 높아졌다고 판단했을까?",
    requirements: ["r3"],
  },
];
const longNotes: AuthoredNote[] = [
  shortNotes[0]!,
  {
    ...shortNotes[1]!,
    at: "제가 참여자 일정 조정과 안내문 작성을 담당했습니다.",
  },
  {
    at: "일정이 겹친 참여자에게 대체 회차를 안내했습니다.",
    kind: "evidence",
    text: "일정이 겹친 참여자에게 대체 회차를 안내했다는 구체적인 조정 행동이 적혀 있다.",
    requirements: ["r1"],
  },
  { ...shortNotes[2]!, at: "- 참여자 만족도를 높였습니다." },
  {
    at: "종료 후 종이 설문을 배포했습니다.",
    kind: "hold",
    question: "q2",
    text: "설문으로 의견을 수집한 점은 보인다. 만족도가 이전보다 높아졌는지 비교할 정보는 아직 없다.",
    requirements: ["r3"],
  },
  {
    at: "협력 기관과 일정 충돌을 해결했습니다.",
    kind: "question",
    question: "q3",
    text: "두 기관의 일정 충돌을 어떤 절차로 조정했을까?",
    requirements: ["r4"],
  },
  {
    at: "변경 가능한 시간을 표로 공유하고 양쪽 담당자와 조정안을 합의했습니다.",
    kind: "hold",
    question: "q3",
    text: "변경 가능 시간을 공유하고 양쪽 담당자와 합의했다는 조정 절차가 나왔다.",
    requirements: ["r4"],
  },
  {
    at: "- 운영 보고서 초안은 팀이 함께 작성했습니다.",
    kind: "question",
    question: "q4",
    text: "팀이 만든 보고서에서 본인이 직접 작성한 부분은 어디일까?",
    requirements: ["r3"],
  },
  {
    at: "저는 출석 기록과 회차별 운영 일지를 정리했습니다.",
    kind: "hold",
    question: "q4",
    text: "본인이 정리한 자료는 출석 기록과 운영 일지다. 보고서에서 맡은 작성 범위까지 설명됐는지는 더 확인해야 한다.",
    requirements: ["r3"],
  },
  {
    at: "제가 독서 모임의 신청 안내문을 작성했습니다.",
    kind: "evidence",
    text: "독서 모임의 신청 안내문을 직접 작성했다고 명시했다.",
    requirements: ["r2"],
  },
  {
    at: "팀 전체의 활동으로 신규 참여자가 늘었습니다.",
    kind: "question",
    question: "q5",
    text: "신규 참여자는 어느 기간에 얼마나 늘었으며, 본인이 기여한 부분은 무엇일까?",
    requirements: ["r3"],
  },
];

function makeFixture(
  name: string,
  source: typeof blocks,
  authored: AuthoredNote[],
  items: AuthoredItem[],
  failThird = false,
) {
  const document = buildDocument(source, "md");
  const notes: Note[] = [];
  const questions: Question[] = [];
  const events: ReadingEvent[] = [];
  const emit = (event: EventPayload) =>
    events.push({ ...event, seq: events.length + 1 });
  for (const [index, unit] of document.units.entries()) {
    const window_id = `w${index + 1}`;
    emit({ type: "window_started", window_id, unit_ids: [unit.id] });
    if (failThird && index === 2) {
      emit({ type: "failed", error: "engine_timeout", partial: true });
      break;
    }
    for (const entry of authored.filter((n) => n.at === unit.text.trim())) {
      if (entry.kind === "question")
        questions.push({
          id: entry.question!,
          unit_id: unit.id,
          scope_id: unit.scope_id,
          text: entry.text,
          status: "open",
          candidate_unit_ids: [],
        });
      const question = questions.find((q) => q.id === entry.question);
      if (entry.kind === "hold") {
        if (!question) throw new Error("fixture_question_missing");
        question.status = "held";
        question.candidate_unit_ids.push(unit.id);
      }
      const note: Note = {
        id: `n${notes.length + 1}`,
        unit_id: unit.id,
        span: { block_id: unit.block_id, start: unit.start, end: unit.end },
        kind: entry.kind,
        text: entry.text,
        ...(entry.question ? { question_id: entry.question } : {}),
        evidence_unit_ids:
          question && entry.kind === "hold"
            ? [question.unit_id, unit.id]
            : [unit.id],
        requirement_ids: entry.requirements ?? [],
        review_required: true,
      };
      notes.push(note);
      emit({ type: "note", note });
    }
    emit({ type: "window_completed", window_id, unit_ids: [unit.id] });
  }
  if (!failThird) {
    if (notes.length !== authored.length)
      throw new Error("fixture_note_anchor_missing");
    emit({ type: "reading_completed" });
    emit({ type: "report_completed" });
  }
  const report = failThird
    ? null
    : validateReport({ items }, document, job, notes, questions);
  if (report)
    report.limitations = [
      "디자인 검증을 위해 사람이 작성한 합성 예시입니다. 모델 실행·학습·정확도 증거가 아닙니다.",
      "이 예시에서는 뒤에서 찾은 설명을 답변 후보로만 표시했습니다. 질문이 해소됐다고 확정한 결과는 아닙니다.",
    ];
  const expires_at = "2100-01-01T00:00:00.000Z";
  const prepare: PrepareView = {
    prepare_id: `fixture-${name}-prepare`,
    input_hash: "0".repeat(64),
    status: "ready",
    document,
    job,
    expires_at,
  };
  const final: JobView = {
    job_id: `fixture-${name}-job`,
    status: failThird ? "failed" : "completed",
    events,
    next_seq: events.length,
    progress: {
      read_unit_count: events.filter((e) => e.type === "window_completed")
        .length,
      total_unit_count: document.units.length,
      current_window: failThird ? "w3" : null,
    },
    report,
    error: failThird ? "engine_timeout" : null,
    expires_at,
    generation: {
      engine: "laya",
      policy_version: "readme-prefix-v1",
      prepare_engine: "codex_cli",
      report_engine: "codex_cli",
      codex_model: "synthetic_fixture",
      model: {
        model: "convaiinnovations/laya-multilingual",
        revision: "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67",
        sdk: "0.3.25",
        device: "synthetic_fixture",
        weights_sha256: "0".repeat(64),
        finetuned: false,
        calibrated_for_readme: false,
      },
    },
  };
  let read = 0;
  let window: string | null = null;
  const snapshots = events.map((event): JobView => {
    if (event.type === "window_started") window = event.window_id;
    if (event.type === "window_completed") read++;
    if (["reading_completed", "report_completed"].includes(event.type))
      window = null;
    const terminal =
      event.type === "report_completed" || event.type === "failed";
    return {
      ...final,
      events: [event],
      next_seq: event.seq,
      status: terminal
        ? final.status
        : event.type === "reading_completed"
          ? "reporting"
          : "reading",
      report: terminal ? report : null,
      error: terminal ? final.error : null,
      progress: {
        read_unit_count: read,
        total_unit_count: document.units.length,
        current_window: window,
      },
    };
  });
  return {
    synthetic: true,
    fixture: true,
    authored: true,
    prepare_ms: 0,
    total_ms: 0,
    prepare,
    snapshots,
    final,
  };
}

export function designFixtures() {
  const shortBlocks = [
    { type: "paragraph" as const, text: shortNotes.map((n) => n.at).join(" ") },
  ];
  const shortItems: AuthoredItem[] = [
    {
      category: "open",
      text: "행사에서 맡은 두 가지 업무가 뒤 문장에 제시돼 있습니다.",
      reason:
        "일정 조정과 안내문 작성은 앞선 역할 질문에 답하는 후보입니다. 현재 계약에서는 해소 확정 없이 연결을 보여줍니다.",
      note_ids: ["n1", "n2"],
      requirement_ids: ["r1", "r2"],
    },
    {
      category: "improve",
      text: "만족도 변화의 조사 방식과 비교 결과를 보완할 수 있습니다.",
      reason:
        "만족도를 높였다는 문장 뒤에는 이를 확인한 자료가 나오지 않습니다. 실제 자료가 있다면 조사 시점과 비교 기준을 덧붙여 주세요.",
      note_ids: ["n3"],
      requirement_ids: ["r3"],
    },
  ];
  const longItems: AuthoredItem[] = [
    {
      category: "explained",
      text: "일정 충돌에 대체 회차를 안내한 행동이 구체적입니다.",
      reason:
        "공고의 일정 조정 요건과 연결해 읽을 수 있습니다. 실제 업무 수행 사실을 검증했다는 의미는 아닙니다.",
      note_ids: ["n3"],
      requirement_ids: ["r1"],
    },
    {
      category: "explained",
      text: "독서 모임의 안내문 작성은 개인 담당 업무로 명시돼 있습니다.",
      reason: "공고의 안내문 작성 경험을 설명하는 문장이 있습니다.",
      note_ids: ["n10"],
      requirement_ids: ["r2"],
    },
    {
      category: "open",
      text: "설문을 했다는 설명만으로 만족도 상승 여부를 비교하기는 어렵습니다.",
      reason:
        "의견 수집 방법은 나왔지만 이전 조사와의 비교 기준은 남아 있습니다.",
      note_ids: ["n4", "n5"],
      requirement_ids: ["r3"],
    },
    {
      category: "open",
      text: "기관 간 조정은 시간표 공유와 합의 절차로 이어집니다.",
      reason:
        "앞선 방법 질문과 뒤의 설명을 연결해 볼 수 있습니다. 읽는 동안에는 답변 후보로만 표시됐습니다.",
      note_ids: ["n6", "n7"],
      requirement_ids: ["r4"],
    },
    {
      category: "improve",
      text: "보고서에서 직접 작성한 범위를 더 구체화할 수 있습니다.",
      reason:
        "출석 기록과 운영 일지 정리는 드러나지만, 팀 보고서의 어느 부분을 작성했는지는 아직 구분하기 어렵습니다.",
      note_ids: ["n8", "n9"],
      requirement_ids: ["r3"],
    },
    {
      category: "improve",
      text: "신규 참여자 증가의 기간과 비교 근거를 덧붙일 수 있습니다.",
      reason: "팀 성과의 변화량과 본인의 기여를 구분할 자료가 남아 있습니다.",
      note_ids: ["n11"],
      requirement_ids: ["r3"],
    },
  ];
  const short = makeFixture("short", shortBlocks, shortNotes, shortItems);
  return {
    short,
    long: makeFixture("long", blocks, longNotes, longItems),
    "partial-failure": makeFixture(
      "partial-failure",
      shortBlocks,
      shortNotes,
      [],
      true,
    ),
    "prepare-empty-requirements": {
      synthetic: true,
      fixture: true,
      authored: true,
      prepare: {
        ...short.prepare,
        prepare_id: "fixture-empty-requirements",
        job: validateProfile(
          { requirements: [] },
          "지역 활동을 함께할 분을 모집합니다.",
        ),
      },
    },
  };
}
