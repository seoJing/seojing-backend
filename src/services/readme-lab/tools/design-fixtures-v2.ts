/** Hand-authored state/connector demonstration; not a measured model output. */
import { buildDocument, textBlocks } from "../document.js";
import { validateProfile } from "../codex.js";
import { validateReaderProfile } from "../profile.js";
import type {
  JobView,
  Note,
  PrepareView,
  Question,
  ReadingEvent,
} from "../contracts.js";

export function v2DesignFixture() {
  const document = buildDocument(
    textBlocks(
      "지역 행사 안내문 작성에 기여했습니다. 팀이 안내문을 공동 작성했습니다. 저는 일정과 장소 항목을 직접 작성했습니다. 앞선 담당 범위 설명은 부정확하여 다시 확인이 필요합니다.",
    ),
    "txt",
  );
  const job = validateProfile(
    {
      requirements: [
        { kind: "duty", label: "안내문 작성", quote: "안내문 작성" },
      ],
    },
    "담당업무: 안내문 작성",
  );
  job.reader_profile = validateReaderProfile(
    {
      criteria: [
        {
          requirement_id: "r1",
          checks: [
            {
              facet: "role",
              trigger: "작성 참여 주장",
              sufficient: "직접 작성한 범위",
              insufficient: "팀이 작성했다는 설명만 있음",
            },
          ],
        },
      ],
    },
    job,
  );
  const prepare: PrepareView = {
    prepare_id: "authored-v2",
    input_hash: "synthetic-not-a-real-input-hash",
    status: "ready",
    document,
    job,
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  const question: Question = {
    id: "q1",
    unit_id: "u1",
    scope_id: "b1",
    label: "안내문 · 본인 역할",
    facet: "role",
    criterion_id: "c_r1",
    text: "안내문에서 직접 작성한 범위는 어디인가요?",
    status: "open",
    candidate_unit_ids: [],
    evidence_unit_ids: [],
    state_version: 0,
  };
  const events: ReadingEvent[] = [];
  const notes: Note[] = [];
  const statuses: Question["status"][] = [
    "open",
    "partial",
    "resolved",
    "reopened",
  ];
  const texts = [
    "‘안내문 작성에 기여’했다는 설명에서 직접 맡은 범위가 궁금합니다.",
    "‘팀이 공동 작성’했다는 설명은 있지만 개인의 범위는 남아 있습니다.",
    "‘일정과 장소 항목’을 직접 작성했다는 설명을 찾았습니다.",
    "담당 범위가 ‘부정확’하다는 정정이 나와 앞선 질문을 다시 확인합니다.",
  ];
  for (const [i, unit] of document.units.entries()) {
    events.push({
      seq: events.length + 1,
      type: "window_started",
      window_id: `w${i + 1}`,
      unit_ids: [unit.id],
    });
    const previous = i ? question.status : null;
    question.status = statuses[i]!;
    question.state_version = i + 1;
    if (i) {
      question.candidate_unit_ids.push(unit.id);
      question.evidence_unit_ids!.push(unit.id);
    }
    events.push({
      seq: events.length + 1,
      type: "question_updated",
      question_id: "q1",
      previous_status: previous,
      status: question.status,
      evidence_unit_ids: [...question.evidence_unit_ids!],
      at_unit_id: unit.id,
      state_version: i + 1,
      question: structuredClone(question),
    });
    const note: Note = {
      id: `n${i + 1}`,
      unit_id: unit.id,
      span: { block_id: unit.block_id, start: unit.start, end: unit.end },
      kind: i === 0 ? "question" : i === 2 ? "resolves" : "hold",
      text: texts[i]!,
      question_id: "q1",
      evidence_unit_ids: i ? ["u1", unit.id] : ["u1"],
      requirement_ids: ["r1"],
      review_required: true,
    };
    notes.push(note);
    events.push({ seq: events.length + 1, type: "note", note });
    events.push({
      seq: events.length + 1,
      type: "window_completed",
      window_id: `w${i + 1}`,
      unit_ids: [unit.id],
    });
  }
  events.push({ seq: events.length + 1, type: "reading_completed" });
  const final: JobView = {
    job_id: "authored-v2",
    status: "completed",
    events: [],
    next_seq: 0,
    progress: { read_unit_count: 4, total_unit_count: 4, current_window: null },
    error: null,
    generation: {
      engine: "laya",
      policy_version: "readme-prefix-v2",
      model: null,
      prepare_engine: "codex_cli",
      report_engine: "codex_cli",
      codex_model: "authored_synthetic_not_a_model_run",
    },
    expires_at: prepare.expires_at,
    report: {
      items: [
        {
          id: "report1",
          category: "open",
          text: "직접 작성한 항목을 설명한 뒤 담당 범위가 부정확하다고 정정했습니다.",
          reason:
            "일정·장소 항목에서 실제 맡은 범위를 다시 확인해 일관되게 정리해 주세요.",
          note_ids: ["n3", "n4"],
          requirement_ids: ["r1"],
          citations: document.units.slice(-2).map((unit) => ({
            unit_id: unit.id,
            block_id: unit.block_id,
            start: unit.start,
            end: unit.end,
          })),
        },
      ],
      questions: [structuredClone(question)],
      limitations: [
        "수동 작성 합성 시안입니다. 모델 정확도나 실제 검증을 나타내지 않습니다.",
      ],
    },
  };
  events.push({ seq: events.length + 1, type: "report_completed" });
  final.events = events;
  final.next_seq = events.length;
  const snapshots: JobView[] = document.units.map((_, i) => ({
    ...structuredClone(final),
    status: "reading",
    report: null,
    events: structuredClone(events.slice(i * 4, (i + 1) * 4)),
    next_seq: (i + 1) * 4,
    progress: {
      read_unit_count: i + 1,
      total_unit_count: 4,
      current_window: null,
    },
  }));
  snapshots.push({
    ...structuredClone(final),
    events: structuredClone(events.slice(16)),
  });
  return {
    synthetic: true,
    fixture: true,
    authored: true,
    production_approved: false,
    prepare,
    snapshots,
    final,
  };
}
