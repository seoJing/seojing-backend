import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJev } from "../src/services/readme-lab/jev.js";
import { validateProfile } from "../src/services/readme-lab/codex.js";
import { validateReaderProfile } from "../src/services/readme-lab/profile.js";
import {
  buildDocument,
  textBlocks,
} from "../src/services/readme-lab/document.js";
import { readJevDocument } from "../src/services/readme-lab/jev-pipeline.js";
import { validateGroundedReport } from "../src/services/readme-lab/report-v2.js";
import { createMemory } from "../src/services/readme-lab/reader.js";
import {
  readSemanticPrefix,
  type SemanticStep,
} from "../src/services/readme-lab/semantic-reader.js";
import type {
  EventPayload,
  Note,
  Question,
} from "../src/services/readme-lab/contracts.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
function fixture() {
  const job = validateProfile(
    {
      requirements: [
        { kind: "duty", label: "안내문 작성", quote: "안내문 작성" },
      ],
    },
    "업무: 안내문 작성",
  );
  job.reader_profile = validateReaderProfile(
    {
      criteria: [
        {
          requirement_id: "r1",
          checks: [
            {
              facet: "role",
              trigger: "참여 주장",
              sufficient: "본인이 직접 수행한 업무",
              insufficient: "참여만 있음",
            },
          ],
        },
      ],
    },
    job,
  );
  const document = buildDocument(
    textBlocks(
      "행사 안내문에 기여했습니다. 제가 행사 안내문을 직접 작성했습니다.",
    ),
    "txt",
  );
  return {
    job,
    document,
    input: {
      job,
      prefix: document.units.slice(0, 1),
      questions: [],
      notes: [],
    },
  };
}
async function worker(mode = "normal") {
  const dir = await mkdtemp(join(tmpdir(), "readme-jev-test-"));
  directories.push(dir);
  const script = join(dir, "worker.py");
  await writeFile(
    script,
    `import json, sys, time, os
config = json.loads(sys.stdin.readline())
assert 'TYPESAFE_API_KEY' not in os.environ
assert config['allow_remote'] is True
print(json.dumps({'ready': {'model': 'jev-1.13.0', 'provider': 'typesafe', 'execution': 'remote', 'calibrated_for_readme': False}}), flush=True)
review_count = 0
for line in sys.stdin:
 msg = json.loads(line)
 if '${mode}' == 'stall':
  time.sleep(60)
 if '${mode}' == 'error':
  print(json.dumps({'id': msg['id'], 'error': 'private detail must not escape'}), flush=True)
  continue
 if '${mode}' == 'budget':
  print(json.dumps({'id': msg['id'], 'error': 'engine_budget_exceeded'}), flush=True)
  continue
 if '${mode}' in ('diagnostic', 'diagnostic_private'):
  reason = 'jev_http_503' if '${mode}' == 'diagnostic' else 'private source must not escape'
  print(json.dumps({'id': msg['id'], 'error': 'engine_unavailable', 'diagnostic_code': reason, 'metrics': {'calls': 3, 'input_tokens': 200, 'output_tokens': 9, 'omitted_proofs': 0}}), flush=True)
  continue
 prefix = msg['input']['prefix']; current = prefix[-1]
 step = {'questions': [], 'updates': [], 'evidence': [], 'retractions': []}
 if len(prefix) == 1:
  step['questions'] = [{'criterion_id': 'c_r1', 'facet': 'role', 'text': '이 경험에서 본인이 직접 수행한 업무는 무엇인가요?', 'evidence': [{'unit_id': current['id'], 'quote': current['text']}]}]
 else:
  step['updates'] = [{'question_id': 'q1', 'relation': 'complete', 'text': '본인이 안내문을 직접 작성했다고 설명했습니다.', 'evidence': [{'unit_id': u['id'], 'quote': u['text']} for u in prefix]}]
 if '${mode}'.startswith('reassess') and len(prefix) > 1:
  review_count += 1
  nonce = 'r9' if '${mode}' == 'reassess_nonce' else 'r' + str(review_count)
  print(json.dumps({'id': msg['id'], 'reassessment': {'nonce': nonce, 'question_id': 'q1', 'current_unit_id': current['id']}}), flush=True)
  reply = json.loads(sys.stdin.readline())
  assert reply['nonce'] == nonce and reply['id'] == msg['id']
  if reply['reassessment_result'] is None: step['updates'] = []
 if '${mode}' == 'fabricated': step['questions'][0]['evidence'][0]['quote'] = '문서에 없는 인용'
 print(json.dumps({'id': msg['id'], 'result': step, 'metrics': {'calls': len(prefix), 'input_tokens': 100, 'output_tokens': 5, 'omitted_proofs': 0}}), flush=True)
`,
  );
  return {
    apiKey: "synthetic-test-key-only",
    script,
    python: "/usr/bin/python3",
  };
}

describe("Jev subprocess and existing event/report integration", () => {
  it("aborts an in-flight optional CLI check when the worker step deadline expires", async () => {
    const { document, job } = fixture();
    let reviewAborted = false;
    await expect(
      readJevDocument(
        document,
        job,
        {
          reassessRole: async (_input, _id, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  reviewAborted = true;
                  resolve(null);
                },
                { once: true },
              );
            }),
          report: () => Promise.reject(Error("must not report")),
        },
        () => {},
        new AbortController().signal,
        { ...(await worker("reassess")), timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: "engine_timeout" });
    expect(reviewAborted).toBe(true);
  });
  it("rejects a third reassessment even when the first two could not confirm anything", async () => {
    const { job } = fixture();
    const document = buildDocument(
      textBlocks(
        "행사에 참여했습니다. 역할을 설명했습니다. 업무도 설명했습니다. 결과도 설명했습니다.",
      ),
      "txt",
    );
    let attempts = 0;
    const events: EventPayload[] = [];
    await expect(
      readJevDocument(
        document,
        job,
        {
          reassessRole: () => {
            attempts++;
            return Promise.resolve(null);
          },
          report: () => Promise.reject(Error("must not report")),
        },
        (e) => events.push(e),
        new AbortController().signal,
        await worker("reassess"),
      ),
    ).rejects.toMatchObject({ code: "engine_output_invalid" });
    expect(attempts).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "failed", partial: true });
    expect(events.some((e) => e.type === "report_completed")).toBe(false);
  });
  it.each(["confirmed", "unconfirmed", "failed", "fabricated"])(
    "keeps optional context outcome %s separate from missing evidence",
    async (outcome) => {
      const { document, job } = fixture();
      const result = await readJevDocument(
        document,
        job,
        {
          reassessRole: (input) => {
            if (outcome === "failed")
              return Promise.reject(new Error("private failure"));
            if (outcome === "unconfirmed") return Promise.resolve(null);
            const current = input.prefix.at(-1)!;
            return Promise.resolve({
              verdict: "complete" as const,
              task: "안내문 작성",
              actor: "applicant" as const,
              modality: "performed" as const,
              task_unit_ids: [current.id],
              performance_unit_ids: [current.id],
              evidence: [
                {
                  unit_id: current.id,
                  quote: outcome === "fabricated" ? "없는 인용" : current.text,
                },
              ],
            });
          },
          report: (doc, posting, notes, questions, _signal, memory) => {
            expect(memory?.context_reviews?.[0]?.outcome).toBe(
              outcome === "fabricated" ? "failed" : outcome,
            );
            return Promise.resolve(
              validateGroundedReport(
                { items: [] },
                doc,
                posting,
                notes,
                questions,
                "jev",
                memory?.context_reviews,
              ),
            );
          },
        },
        () => {},
        new AbortController().signal,
        await worker("reassess"),
      );
      expect(result.questions[0]?.status).toBe(
        outcome === "confirmed" ? "resolved" : "open_at_end",
      );
      expect(
        result.report.limitations
          .join(" ")
          .includes("추가 문맥 확인을 완료하지 못했습니다"),
      ).toBe(["failed", "fabricated"].includes(outcome));
    },
  );
  it("rejects a worker reassessment nonce before calling Codex", async () => {
    let called = false;
    await expect(
      readJevDocument(
        fixture().document,
        fixture().job,
        {
          reassessRole: () => {
            called = true;
            return Promise.resolve(null);
          },
          report: () => Promise.reject(Error("must not report")),
        },
        () => {},
        new AbortController().signal,
        await worker("reassess_nonce"),
      ),
    ).rejects.toMatchObject({ code: "engine_output_invalid" });
    expect(called).toBe(false);
  });
  it.each(["diagnostic", "diagnostic_private"])(
    "allowlists private failure diagnostics and preserves failed-call metrics: %s",
    async (mode) => {
      const codes: string[] = [];
      const signal = new AbortController().signal;
      const reader = await openJev(signal, {
        ...(await worker(mode)),
        onFailure: (code) => codes.push(code),
      });
      try {
        await expect(
          reader.readStep(fixture().input, signal),
        ).rejects.toMatchObject({ code: "engine_unavailable" });
        expect(codes).toEqual(mode === "diagnostic" ? ["jev_http_503"] : []);
        expect(reader.metrics).toEqual({
          calls: 3,
          input_tokens: 200,
          output_tokens: 9,
          omitted_proofs: 0,
        });
      } finally {
        reader.close();
      }
    },
  );
  it.each(["- ", "+ ", "* ", "## ", "1. ", "2) ", "- [x] ", ""])(
    "cleans display marker %s while retaining the exact source",
    async (marker) => {
      const { job } = fixture();
      const source = `${marker}참여자 40명의 일정 조정을 직접 맡았습니다.`;
      const document = buildDocument(
        [{ type: "paragraph", text: source }],
        "txt",
      );
      const notes: Note[] = [];
      await readSemanticPrefix(
        document.units,
        job,
        {
          readStep: () =>
            Promise.resolve({
              questions: [
                {
                  criterion_id: "c_r1",
                  facet: "role",
                  text: "본인이 맡은 구체적인 역할은 무엇인가요?",
                  evidence: [{ unit_id: "u1", quote: source }],
                },
              ],
              updates: [],
              evidence: [],
              retractions: [],
            }),
        },
        createMemory(job, "jev"),
        notes,
        [],
        () => undefined,
        new AbortController().signal,
      );
      expect(notes[0]!.text).toMatch(/^“참여자 40명의/);
      expect(notes[0]!.span).toEqual({
        block_id: document.units[0]!.block_id,
        start: 0,
        end: source.length,
      });
      expect(document.blocks[0]!.text).toBe(source);
    },
  );
  it("keeps numeric tokens whole in display excerpts and the full evidence span", async () => {
    const { job } = fixture();
    job.reader_profile!.criteria[0]!.label =
      "행사 운영과 참가자 안내 및 일정 조정 업무를 담당하는 역할";
    const source = `${"설명 ".repeat(21)}12분 동안 직접 안내문을 작성했습니다.`;
    const document = buildDocument(textBlocks(source), "txt");
    const notes: Note[] = [],
      questions: Question[] = [];
    await readSemanticPrefix(
      document.units,
      job,
      {
        readStep: () =>
          Promise.resolve({
            questions: [
              {
                criterion_id: "c_r1",
                facet: "role",
                text: "본인이 맡아서 수행한 구체적인 업무는 무엇인가요?",
                evidence: [{ unit_id: "u1", quote: source }],
              },
            ],
            updates: [],
            evidence: [],
            retractions: [],
          }),
      },
      createMemory(job, "jev"),
      notes,
      questions,
      () => undefined,
      new AbortController().signal,
    );
    expect(notes[0]!.text.split("”")[0]).not.toContain("1…");
    expect(notes[0]!.text).toContain("설명…");
    expect(notes[0]!.span?.end).toBe(source.length);
    expect(Array.from(questions[0]!.label!).length).toBeLessThanOrEqual(24);
    expect(questions[0]!.label).toContain("본인 역할");
  });
  it("preserves a document budget error across the worker boundary", async () => {
    const reader = await openJev(
      new AbortController().signal,
      await worker("budget"),
    );
    try {
      await expect(
        reader.readStep(fixture().input, new AbortController().signal),
      ).rejects.toMatchObject({ code: "engine_budget_exceeded" });
    } finally {
      reader.close();
    }
  });
  it("replaces current partial proof while preserving its historical notes", async () => {
    const { job } = fixture();
    const document = buildDocument(
      textBlocks(
        "행사 안내에 기여했습니다. 처음에는 팀의 안내 업무만 소개했습니다. 이후 제가 직접 한 업무의 일부를 설명했습니다.",
      ),
      "txt",
    );
    const memory = createMemory(job, "jev"),
      notes: Note[] = [],
      questions: Question[] = [];
    for (let i = 0; i < document.units.length; i++) {
      const evidence = [...new Set([0, i])].map((index) => ({
        unit_id: document.units[index]!.id,
        quote: document.units[index]!.text,
      }));
      const step: SemanticStep = {
        questions: [],
        updates: [],
        evidence: [],
        retractions: [],
      };
      if (i === 0)
        step.questions.push({
          criterion_id: "c_r1",
          facet: "role",
          text: "본인이 직접 맡아서 수행한 구체적인 업무는 무엇인가요?",
          evidence,
        });
      else
        step.updates.push({
          question_id: "q1",
          relation: "partial",
          text: "일부 설명을 확인했으며 남은 구체적인 업무를 확인해야 합니다.",
          evidence,
        });
      await readSemanticPrefix(
        document.units.slice(0, i + 1),
        job,
        { readStep: () => Promise.resolve(step) },
        memory,
        notes,
        questions,
        () => undefined,
        new AbortController().signal,
      );
    }
    expect(questions[0]?.evidence_unit_ids).toEqual(["u3"]);
    expect(questions[0]?.state_version).toBe(3);
    expect(notes[1]?.evidence_unit_ids).toEqual(["u1", "u2"]);
    expect(notes[2]?.evidence_unit_ids).toEqual(["u1", "u3"]);
  });
  it("emits sequential source-linked events and a truthfully labeled report", async () => {
    const { job, document } = fixture();
    const events: EventPayload[] = [];
    const result = await readJevDocument(
      document,
      job,
      {
        report(doc, posting, notes, questions, _signal, memory) {
          expect(memory?.engine).toBe("jev");
          expect(memory?.units).toEqual(document.units);
          return Promise.resolve(
            validateGroundedReport(
              { items: [] },
              doc,
              posting,
              notes,
              questions,
              "jev",
            ),
          );
        },
      },
      (e) => events.push(e),
      new AbortController().signal,
      await worker(),
    );
    expect(result.questions[0]?.status).toBe("resolved");
    expect(
      events
        .filter((e) => e.type === "question_updated")
        .map((e) => e.state_version),
    ).toEqual([1, 2]);
    expect(events.at(-1)?.type).toBe("report_completed");
    expect(result.report.limitations.join(" ")).toContain("Typesafe");
    expect(result.report.limitations.join(" ")).not.toContain("Laya");
    expect(result.usage.calls).toBe(2);
  });
  it("rejects fabricated citations before they become UI events", async () => {
    const reader = await openJev(
      new AbortController().signal,
      await worker("fabricated"),
    );
    try {
      await expect(
        reader.readStep(fixture().input, new AbortController().signal),
      ).rejects.toMatchObject({ code: "engine_output_invalid" });
    } finally {
      reader.close();
    }
  });
  it("terminates a stalled child on a per-step deadline", async () => {
    const reader = await openJev(new AbortController().signal, {
      ...(await worker("stall")),
      timeoutMs: 30,
    });
    try {
      await expect(
        reader.readStep(fixture().input, new AbortController().signal),
      ).rejects.toMatchObject({ code: "engine_timeout" });
    } finally {
      reader.close();
    }
  });
  it("propagates caller cancellation without waiting for the provider", async () => {
    const reader = await openJev(
      new AbortController().signal,
      await worker("stall"),
    );
    const controller = new AbortController();
    try {
      const pending = reader.readStep(fixture().input, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      reader.close();
    }
  });
  it("sanitizes unknown child error messages", async () => {
    const reader = await openJev(
      new AbortController().signal,
      await worker("error"),
    );
    try {
      await expect(
        reader.readStep(fixture().input, new AbortController().signal),
      ).rejects.toMatchObject({ message: "engine_unavailable" });
    } finally {
      reader.close();
    }
  });
  it("fails before spawning when no key or already cancelled", async () => {
    await expect(
      openJev(new AbortController().signal, { apiKey: "" }),
    ).rejects.toMatchObject({ code: "engine_unavailable" });
    await expect(
      openJev(AbortSignal.abort(), { apiKey: "synthetic-test-key-only" }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
