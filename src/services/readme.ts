/** Public synthetic-only preview. This is not Laya inference or Work24 data. */
const job = {
  title: "지역 프로그램 운영 지원 담당자 (합성 공고)",
  text: "참여자 일정 조정과 안내문 작성 경험, 운영 기록과 검수 문서 작성 경험을 우대합니다.",
  criteria: [
    {
      id: "c_schedule",
      label: "참여자 일정 조정·안내",
      source_quote: "참여자 일정 조정과 안내문 작성 경험",
    },
    {
      id: "c_record",
      label: "운영 기록·검수 문서",
      source_quote: "운영 기록과 검수 문서 작성 경험",
    },
  ],
} as const;

const units = [
  { id: "u1", index: 0, text: "지역 프로그램 운영을 지원했습니다." },
  {
    id: "u2",
    index: 1,
    text: "참여자 일정 조정과 안내문 작성을 직접 담당했습니다.",
  },
  {
    id: "u3",
    index: 2,
    text: "진행표와 안내문 검수 체크리스트를 작성했습니다.",
  },
  { id: "u4", index: 3, text: "참여자 만족도를 개선했습니다." },
] as const;

type ReadingEvent = {
  seq: number;
  unit_id: string;
  type: "question" | "resolve" | "evidence" | "note";
  message: string;
  criterion_id?: string;
  question_id?: string;
  evidence_unit_ids?: string[];
};

function makeTrace(): ReadingEvent[] {
  const events: ReadingEvent[] = [];
  const add = (event: Omit<ReadingEvent, "seq">) =>
    events.push({ seq: events.length + 1, ...event });

  for (const unit of units) {
    if (unit.id === "u1" && unit.text.includes("운영을 지원")) {
      add({
        unit_id: unit.id,
        type: "question",
        question_id: "q_role",
        criterion_id: "c_schedule",
        message: "직접 맡은 운영 업무의 범위는 무엇일까요?",
        evidence_unit_ids: [unit.id],
      });
    }
    if (unit.id === "u2" && unit.text.includes("직접 담당")) {
      add({
        unit_id: unit.id,
        type: "resolve",
        question_id: "q_role",
        criterion_id: "c_schedule",
        message: "일정 조정과 안내문 작성으로 앞선 역할 질문이 구체화됩니다.",
        evidence_unit_ids: ["u1", unit.id],
      });
    }
    if (unit.id === "u3" && unit.text.includes("체크리스트")) {
      add({
        unit_id: unit.id,
        type: "evidence",
        criterion_id: "c_record",
        message: "운영 기록과 검수 문서의 구체적 산출물이 보입니다.",
        evidence_unit_ids: [unit.id],
      });
    }
    if (unit.id === "u4" && unit.text.includes("만족도")) {
      add({
        unit_id: unit.id,
        type: "question",
        question_id: "q_basis",
        message: "만족도 개선을 확인할 비교 기준이나 자료가 있나요?",
        evidence_unit_ids: [unit.id],
      });
    }
  }
  return events;
}

export function buildReadmePreview() {
  return {
    mode: "rules_preview" as const,
    case_id: "social-program-operator" as const,
    job,
    resume: { units },
    events: makeTrace(),
    report: {
      strengths: [
        {
          text: "일정 조정과 안내문 작성의 직접 담당 범위가 뒤 문장에서 설명됩니다.",
          unit_ids: ["u1", "u2"],
        },
        {
          text: "진행표와 검수 체크리스트라는 산출물이 명시됩니다.",
          unit_ids: ["u3"],
        },
      ],
      open_questions: [
        {
          text: "만족도 개선의 비교 기준·측정 범위는 이 문서에서 확인되지 않습니다.",
          unit_ids: ["u4"],
        },
      ],
      next_steps: [
        {
          text: "실제 측정 근거가 있다면 방법과 기간을, 없다면 단정적 표현을 조정해 보세요.",
          unit_ids: ["u4"],
        },
      ],
    },
    limitations: [
      "합성 사례에 대한 규칙 기반 시연입니다. Laya 모델은 연결되지 않았습니다.",
      "실제 채용담당자의 판단, 합격 가능성, 고용24 경력 인증을 의미하지 않습니다.",
    ],
  };
}

export type ReadmePreview = ReturnType<typeof buildReadmePreview>;
