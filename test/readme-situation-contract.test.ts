import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Unit } from "../src/services/readme-lab/contracts.js";
import type { FocusStep } from "../src/services/readme-lab/focus-contract.js";
import {
  SITUATION_VERSION,
  createSituationLedger,
  projectSituationExpectation,
  situationFinishSchema,
  situationStepSchema,
  validateSituationFinish,
  validateSituationStep,
  type SituationEntity,
  type SituationExpectation,
  type SituationFinish,
  type SituationLedger,
  type SituationStep,
} from "../src/services/readme-lab/situation-contract.js";

interface Case {
  id: string;
  units: string[];
  steps: SituationStep[];
  finish: SituationFinish;
}
const fixture = JSON.parse(
  readFileSync("test/fixtures/readme/situation-contract-v1.json", "utf8"),
) as { provenance: string; cases: Case[] };
const cases = fixture.cases;
function unitsFor(texts: string[]): Unit[] {
  return texts.map((text, i) => ({
    id: `u${i + 1}`,
    block_id: `b${i + 1}`,
    scope_id: "s1",
    order: i,
    text,
    start: 0,
    end: text.length,
  }));
}
function replay(name: string, count?: number) {
  const c = cases.find((c) => c.id === name)!;
  const units = unitsFor(c.units),
    state = createSituationLedger(units);
  for (const [i, step] of c.steps.slice(0, count).entries())
    validateSituationStep(step, units.slice(0, i + 1), state);
  return { c, units, state };
}
function rejectStep(
  name: string,
  index: number,
  edit: (s: SituationStep) => void,
) {
  const { c, units, state } = replay(name, index),
    before = structuredClone(state),
    step = structuredClone(c.steps[index]!);
  edit(step);
  expect(() =>
    validateSituationStep(step, units.slice(0, index + 1), state),
  ).toThrow("engine_output_invalid");
  expect(state).toEqual(before);
}
function updateOf(s: SituationStep) {
  return s.events.find((e) => e.type === "expectation_updated")!;
}
function attentionOf(s: SituationStep) {
  return s.events.find((e) => e.type === "attention_created")!;
}
function emptyStep(u: Unit): SituationStep {
  return {
    version: SITUATION_VERSION,
    at_unit_id: u.id,
    active_expectation_id: null,
    events: [],
    focus: {
      version: "focus-reader-v1",
      at_unit_id: u.id,
      context_id: null,
      active_question_id: null,
      events: [],
    },
  };
}
function pending(u: Unit, n: number) {
  const origin = { unit_id: u.id, quote: u.text, start: 0, end: u.text.length };
  const entity: SituationEntity = {
    id: `e${n}`,
    kind: "project",
    canonical_name: u.text,
    aliases: [],
    introduced_at_unit_id: u.id,
    context_id: null,
    origin,
    status: "noticed",
    definition_unit_ids: [],
  };
  const expectation: SituationExpectation = {
    id: `x${n}`,
    kind: "entity_definition",
    origin_unit_id: u.id,
    origin,
    context_id: null,
    entity_ids: [entity.id],
    prompt: "설명 확인",
    sufficient: "동일 대상의 정의",
    status: "pending",
    evidence: [],
    withdrawn_evidence: [],
    correction_evidence: [],
    state_version: 1,
    focus: "parked",
  };
  return {
    type: "attention_created" as const,
    at_unit_id: u.id,
    entity,
    expectation,
  };
}
function finalFrom(state: SituationLedger): SituationFinish {
  return {
    version: SITUATION_VERSION,
    at_unit_id: state.source_units.at(-1)!.id,
    final_events: [],
    snapshot: {
      entities: structuredClone(state.entities),
      expectations: structuredClone(state.expectations),
      questions: structuredClone(state.focus.questions),
    },
  };
}

describe("authored situation protocol (not actual-model accuracy)", () => {
  for (const c of cases)
    it(`replays and finishes ${c.id}`, () => {
      expect(fixture.provenance).toBe("authored_synthetic_not_model_output");
      for (const step of c.steps)
        expect(situationStepSchema.safeParse(step).success).toBe(true);
      expect(situationFinishSchema.safeParse(c.finish).success).toBe(true);
      const { state } = replay(c.id);
      const steps = structuredClone(state.steps);
      validateSituationFinish(c.finish, state);
      expect(state.complete).toBe(true);
      expect(state.focus.complete).toBe(true);
      expect(state.entities).toEqual(c.finish.snapshot.entities);
      expect(state.expectations).toEqual(c.finish.snapshot.expectations);
      expect(state.focus.questions).toEqual(c.finish.snapshot.questions);
      expect(state.steps).toEqual(steps); // finish never rewrites reading history
      expect(state.final_events).toEqual(c.finish.final_events);
    });
  it("keeps a basis inquiry alongside a newly satisfied definition", () => {
    const { state } = replay("definition_and_focus");
    expect(state.expectations[0]?.status).toBe("satisfied");
    expect(state.focus.questions[0]).toMatchObject({
      facet: "basis",
      status: "open",
      focus: "active",
    });
  });
  it("keeps three separate same-origin expectations with one active", () => {
    const { state } = replay("three_attentions", 1);
    expect(state.expectations.map((q) => [q.origin_unit_id, q.focus])).toEqual([
      ["u1", "active"],
      ["u1", "parked"],
      ["u1", "parked"],
    ]);
    expect(new Set(state.expectations.map((q) => q.entity_ids[0])).size).toBe(
      3,
    );
  });
  it("can directly park a partially explained expectation while discovering a new one", () => {
    const { state } = replay("partial_and_new");
    expect(state.expectations.map((q) => [q.status, q.focus])).toEqual([
      ["partially_satisfied", "parked"],
      ["pending", "active"],
    ]);
  });
  it("derives entity state and withdraws old definitions before re-explanation", () => {
    const { state } = replay("correction_reexplained", 3);
    expect(state.entities[0]).toMatchObject({
      status: "noticed",
      definition_unit_ids: [],
    });
    const { state: later } = replay("correction_reexplained");
    expect(later.entities[0]).toMatchObject({
      status: "explained",
      definition_unit_ids: ["u4"],
    });
    expect(
      later.expectations[0]?.withdrawn_evidence.map((p) => p.unit_id),
    ).toEqual(["u2"]);
  });
  it("uses UTF-16 for emoji before a heading name", () => {
    const { c } = replay("utf16_heading", 1);
    expect(attentionOf(c.steps[0]!).entity.origin.start).toBe(4);
    rejectStep("utf16_heading", 0, (s) => {
      attentionOf(s).entity.origin.start = 3;
    });
  });
});

describe("source identity and atomic step rejection", () => {
  it("freezes a copy of the canonical source manifest", () => {
    const units = unitsFor(["달고리"]),
      state = createSituationLedger(units);
    units[0]!.text = "changed";
    expect(state.source_units[0]!.text).toBe("달고리");
    expect(() =>
      Object.assign(state.source_units[0]!, { text: "changed" }),
    ).toThrow();
  });
  it("rejects empty, duplicated, unordered or invalid source identity", () => {
    expect(() => createSituationLedger([])).toThrow("engine_input_invalid");
    for (const mutate of [
      (u: Unit[]) => {
        u[1]!.id = u[0]!.id;
      },
      (u: Unit[]) => {
        u[1]!.order = u[0]!.order;
      },
      (u: Unit[]) => {
        u[0]!.text = "";
      },
      (u: Unit[]) => {
        u[0]!.end = 0;
      },
    ]) {
      const units = unitsFor(["달고리", "해바퀴"]);
      mutate(units);
      expect(() => createSituationLedger(units)).toThrow(
        "engine_input_invalid",
      );
    }
  });
  for (const key of [
    "text",
    "id",
    "block_id",
    "scope_id",
    "start",
    "end",
    "order",
  ] as const)
    it(`rejects changed prefix ${key}`, () => {
      const { c, units, state } = replay("definition_and_focus", 1),
        before = structuredClone(state);
      const u = units[0]!;
      if (key === "start" || key === "end" || key === "order") u[key] += 1;
      else u[key] += "changed";
      expect(() => validateSituationStep(c.steps[1], units, state)).toThrow(
        "engine_output_invalid",
      );
      expect(state).toEqual(before);
    });
  it("binds the first unit and the unread next unit, not only previous history", () => {
    const { c, units, state } = replay("definition_and_focus", 0);
    const changed = structuredClone(units);
    changed[0]!.text = "違う";
    expect(() =>
      validateSituationStep(c.steps[0], changed.slice(0, 1), state),
    ).toThrow();
    validateSituationStep(c.steps[0], units.slice(0, 1), state);
    changed[0] = units[0]!;
    changed[1]!.text = "別の文";
    expect(() => validateSituationStep(c.steps[1], changed, state)).toThrow();
  });
  it("rejects replay, skipped windows, policy mixing and unknown state events", () => {
    const { c, units, state } = replay("definition_and_focus", 1),
      before = structuredClone(state);
    expect(() =>
      validateSituationStep(c.steps[0], units.slice(0, 1), state),
    ).toThrow();
    const fresh = createSituationLedger(units);
    expect(() => validateSituationStep(c.steps[1], units, fresh)).toThrow();
    expect(() =>
      validateSituationStep(
        { ...c.steps[1], version: "focus-reader-v1" },
        units,
        state,
      ),
    ).toThrow();
    expect(() =>
      validateSituationStep(
        { ...c.steps[1], events: [{ type: "new_state", at_unit_id: "u2" }] },
        units,
        state,
      ),
    ).toThrow();
    expect(state).toEqual(before);
  });
  const invalidUpdates: Array<[string, (s: SituationStep) => void]> = [
    [
      "fabricated quote",
      (s) => {
        updateOf(s).expectation.evidence[0]!.quote = "없는 근거";
      },
    ],
    [
      "future proof",
      (s) => {
        updateOf(s).expectation.evidence[0]!.unit_id = "u9";
      },
    ],
    [
      "no new proof",
      (s) => {
        updateOf(s).expectation.evidence = [];
      },
    ],
    [
      "duplicate proof",
      (s) => {
        updateOf(s).expectation.evidence.push(
          structuredClone(updateOf(s).expectation.evidence[0]!),
        );
      },
    ],
    [
      "changed origin",
      (s) => {
        updateOf(s).expectation.origin_unit_id = "u2";
      },
    ],
    [
      "changed prompt",
      (s) => {
        updateOf(s).expectation.prompt += "변경";
      },
    ],
    [
      "changed context",
      (s) => {
        updateOf(s).expectation.context_id = "another";
      },
    ],
    [
      "changed entity",
      (s) => {
        updateOf(s).expectation.entity_ids = ["e2"];
      },
    ],
    [
      "skipped version",
      (s) => {
        updateOf(s).expectation.state_version++;
      },
    ],
    [
      "wrong previous status",
      (s) => {
        updateOf(s).previous_status = "satisfied";
      },
    ],
    [
      "satisfied remains active",
      (s) => {
        updateOf(s).expectation.focus = "active";
      },
    ],
    [
      "missing revisit",
      (s) => {
        s.events = s.events.filter((e) => e.type !== "source_revisit");
      },
    ],
    [
      "orphan revisit",
      (s) => {
        s.events = s.events.filter((e) => e.type !== "expectation_updated");
      },
    ],
    [
      "reversed revisit order",
      (s) => {
        s.events.reverse();
      },
    ],
    [
      "duplicate revisit",
      (s) => {
        s.events.splice(1, 0, structuredClone(s.events[0]!));
      },
    ],
    [
      "current revisit target",
      (s) => {
        const e = s.events.find((e) => e.type === "source_revisit")!;
        e.target_unit_ids.push("u2");
      },
    ],
    [
      "future revisit target",
      (s) => {
        const e = s.events.find((e) => e.type === "source_revisit")!;
        e.target_unit_ids.push("u3");
      },
    ],
    [
      "duplicate revisit target",
      (s) => {
        const e = s.events.find((e) => e.type === "source_revisit")!;
        e.target_unit_ids.push("u1");
      },
    ],
    [
      "target disagreement",
      (s) => {
        updateOf(s).target_unit_ids = ["u2"];
      },
    ],
    [
      "wrong reason",
      (s) => {
        const e = s.events.find((e) => e.type === "source_revisit")!;
        e.reason = "correction";
      },
    ],
    [
      "mismatching at",
      (s) => {
        updateOf(s).at_unit_id = "u1";
      },
    ],
    [
      "early finish status",
      (s) => {
        updateOf(s).expectation.status = "unresolved_at_end";
      },
    ],
    [
      "incorrect active pointer",
      (s) => {
        s.active_expectation_id = "x1";
      },
    ],
  ];
  for (const [name, edit] of invalidUpdates)
    it(`rejects ${name} without leaking valid focus changes`, () =>
      rejectStep("definition_and_focus", 1, edit));
  it("does not commit a valid situation update when focus validation fails", () => {
    rejectStep("definition_and_focus", 1, (s) => {
      s.focus.active_question_id = null;
    });
  });
  it("does not alias accepted state through the input, return value or prefix", () => {
    const { c, units, state } = replay("definition_and_focus", 0),
      step = structuredClone(c.steps[0]!);
    const result = validateSituationStep(step, units.slice(0, 1), state),
      before = structuredClone(state);
    attentionOf(step).expectation.prompt = "changed";
    attentionOf(result).expectation.prompt = "changed";
    units[0]!.text = "changed";
    expect(state).toEqual(before);
  });
});

describe("creation, correction and ordering", () => {
  const invalidCreation: Array<[string, (s: SituationStep) => void]> = [
    [
      "two active expectations",
      (s) => {
        s.events.filter(
          (e) => e.type === "attention_created",
        )[1]!.expectation.focus = "active";
      },
    ],
    [
      "creation with evidence",
      (s) => {
        attentionOf(s).expectation.evidence = [
          attentionOf(s).expectation.origin,
        ];
      },
    ],
    [
      "creation at version2",
      (s) => {
        attentionOf(s).expectation.state_version = 2;
      },
    ],
    [
      "absent alias",
      (s) => {
        attentionOf(s).entity.aliases = ["없던이름"];
      },
    ],
    [
      "renamed entity",
      (s) => {
        attentionOf(s).entity.canonical_name = "다른이름";
      },
    ],
    [
      "pre-explained new entity",
      (s) => {
        attentionOf(s).entity.status = "explained";
      },
    ],
    [
      "duplicate expectation ID",
      (s) => {
        s.events.filter(
          (e) => e.type === "attention_created",
        )[1]!.expectation.id = "x1";
      },
    ],
    [
      "multiple entity IDs",
      (s) => {
        attentionOf(s).expectation.entity_ids.push("e2");
      },
    ],
  ];
  for (const [name, edit] of invalidCreation)
    it(`rejects ${name}`, () => rejectStep("three_attentions", 0, edit));
  it("rejects update after discovery and duplicate mutation after direct parking", () => {
    rejectStep("partial_and_new", 1, (s) => {
      s.events.unshift(s.events.pop()!);
    });
    rejectStep("partial_and_new", 1, (s) => {
      s.events.splice(2, 0, {
        type: "expectation_parked",
        at_unit_id: "u2",
        expectation_id: "x1",
        previous_version: 2,
        state_version: 3,
      });
    });
  });
  it("rejects mutation of an existing entity and duplicate origin/kind/entity", () => {
    rejectStep("existing_entity_new_expectation", 2, (s) => {
      attentionOf(s).entity.canonical_name = "변경";
    });
    rejectStep("three_attentions", 0, (s) => {
      const a = attentionOf(s),
        second = s.events.filter((e) => e.type === "attention_created")[1]!;
      second.entity = structuredClone(a.entity);
      second.expectation.entity_ids = [a.entity.id];
    });
  });
  it("rejects parking with wrong version and reactivation", () => {
    rejectStep("park_then_finish", 1, (s) => {
      const e = s.events.find((e) => e.type === "expectation_parked")!;
      e.state_version = 1;
    });
    rejectStep("three_attentions", 2, (s) => {
      const q = updateOf(s).expectation;
      q.status = "partially_satisfied";
      q.focus = "active";
      s.active_expectation_id = q.id;
    });
  });
  it("requires exact withdrawal and a new correction proof", () => {
    rejectStep("correction_reexplained", 2, (s) => {
      updateOf(s).expectation.withdrawn_evidence = [];
    });
    rejectStep("correction_reexplained", 2, (s) => {
      updateOf(s).expectation.correction_evidence = [];
    });
    rejectStep("correction_reexplained", 2, (s) => {
      const e = s.events.find((e) => e.type === "source_revisit")!;
      e.reason = "definition";
    });
    rejectStep("correction_reexplained", 3, (s) => {
      const q = updateOf(s).expectation;
      q.evidence.push(...q.withdrawn_evidence);
    });
    rejectStep("correction_reexplained", 3, (s) => {
      updateOf(s).expectation.withdrawn_evidence = [];
    });
    rejectStep("correction_reexplained", 3, (s) => {
      updateOf(s).expectation.correction_evidence = [];
    });
  });
  it("enforces per-unit discovery and document expectation caps without partial commits", () => {
    const units = unitsFor(
        Array.from({ length: 25 }, (_, i) => `프로젝트${i}`),
      ),
      state = createSituationLedger(units);
    for (let i = 0; i < 24; i++) {
      const step = emptyStep(units[i]!);
      step.events = [pending(units[i]!, i + 1)];
      validateSituationStep(step, units.slice(0, i + 1), state);
    }
    const before = structuredClone(state),
      extra = emptyStep(units[24]!);
    extra.events = [pending(units[24]!, 25)];
    expect(() => validateSituationStep(extra, units, state)).toThrow();
    expect(state).toEqual(before);
    const one = [units[0]!],
      fresh = createSituationLedger(one),
      four = emptyStep(one[0]!);
    four.events = [1, 2, 3, 4].map((i) => pending(one[0]!, i));
    expect(() => validateSituationStep(four, one, fresh)).toThrow();
    expect(fresh.steps).toHaveLength(0);
  });
});

describe("composed focus capacity", () => {
  it("rejects the seventeenth focus question before either ledger commits", () => {
    const units = unitsFor(
      Array.from({ length: 17 }, (_, i) => `합성 활동 ${i + 1}`),
    );
    const state = createSituationLedger(units);
    for (let i = 0; i < units.length; i++) {
      const u = units[i]!,
        step = emptyStep(u);
      const q = {
        id: `q${i + 1}`,
        origin_unit_id: u.id,
        context_id: "c1",
        facet: "role" as const,
        text: "직접 수행한 역할은 무엇인가요?",
        status: "open" as const,
        evidence: [],
        focus: "active" as const,
        state_version: 1,
        withdrawn_evidence: [],
        correction_evidence: [],
      };
      step.focus.context_id = "c1";
      step.focus.active_question_id = q.id;
      if (i)
        step.focus.events.push({
          type: "parked",
          at_unit_id: u.id,
          context_id: "c1",
          question_id: `q${i}`,
        });
      step.focus.events.push({
        type: "inquiry",
        at_unit_id: u.id,
        context_id: "c1",
        question: q,
        state_version: 1,
      });
      if (i < 16) validateSituationStep(step, units.slice(0, i + 1), state);
      else {
        // A valid new situation expectation must not escape this rejected window either.
        step.events = [pending(u, 1)];
        const before = structuredClone(state);
        expect(() => validateSituationStep(step, units, state)).toThrow(
          "engine_output_invalid",
        );
        expect(state).toEqual(before);
        expect(state.focus.questions).toHaveLength(16);
        expect(state.expectations).toHaveLength(0);
      }
    }
  });
});

describe("finish boundaries and neutral presentation", () => {
  it("rejects premature finish, duplicate finish and steps after finish", () => {
    const { c, state } = replay("partial_and_new", 1),
      before = structuredClone(state);
    expect(() => validateSituationFinish(c.finish, state)).toThrow();
    expect(state).toEqual(before);
    const complete = replay("partial_and_new");
    validateSituationFinish(c.finish, complete.state);
    const ended = structuredClone(complete.state);
    expect(() => validateSituationFinish(c.finish, complete.state)).toThrow();
    expect(() =>
      validateSituationStep(c.steps[1], complete.units, complete.state),
    ).toThrow();
    expect(complete.state).toEqual(ended);
  });
  const invalidFinish: Array<[string, (f: SituationFinish) => void]> = [
    [
      "missing final event",
      (f) => {
        f.final_events.pop();
      },
    ],
    [
      "duplicate final event",
      (f) => {
        f.final_events.push(structuredClone(f.final_events[0]!));
      },
    ],
    [
      "changed last unit",
      (f) => {
        f.at_unit_id = "u1";
      },
    ],
    [
      "changed event unit",
      (f) => {
        f.final_events[0]!.at_unit_id = "u1";
      },
    ],
    [
      "skipped finish version",
      (f) => {
        f.final_events[0]!.expectation.state_version++;
      },
    ],
    [
      "changed proof at finish",
      (f) => {
        f.final_events[0]!.expectation.evidence = [];
      },
    ],
    [
      "changed identity at finish",
      (f) => {
        f.final_events[0]!.expectation.prompt += "new";
      },
    ],
    [
      "wrong final status",
      (f) => {
        f.final_events[0]!.expectation.status = "satisfied";
      },
    ],
    [
      "active final expectation",
      (f) => {
        f.final_events[0]!.expectation.focus = "active";
      },
    ],
    [
      "missing snapshot expectation",
      (f) => {
        f.snapshot.expectations.pop();
      },
    ],
    [
      "changed snapshot entity",
      (f) => {
        f.snapshot.entities[0]!.canonical_name += "other";
      },
    ],
  ];
  for (const [name, edit] of invalidFinish)
    it(`rejects ${name} atomically`, () => {
      const { c, state } = replay("partial_and_new"),
        finish = structuredClone(c.finish),
        before = structuredClone(state);
      edit(finish);
      expect(() => validateSituationFinish(finish, state)).toThrow();
      expect(state).toEqual(before);
    });
  it("rejects final focus snapshot mismatch and finish events inside a step", () => {
    const { c, state } = replay("definition_and_focus"),
      finish = structuredClone(c.finish);
    finish.snapshot.questions = [];
    expect(() => validateSituationFinish(finish, state)).toThrow();
    const partial = replay("partial_and_new", 1),
      step = structuredClone(partial.c.steps[1]!);
    expect(() =>
      validateSituationStep(
        { ...step, events: partial.c.finish.final_events },
        partial.units,
        partial.state,
      ),
    ).toThrow();
  });
  it("does not finish satisfied or contradicted states again", () => {
    const { state } = replay("correction_reexplained", 3);
    // Bind a three-unit source separately to model a document ending on correction.
    const c = cases.find((c) => c.id === "correction_reexplained")!,
      units = unitsFor(c.units.slice(0, 3)),
      short = createSituationLedger(units);
    c.steps
      .slice(0, 3)
      .forEach((s, i) =>
        validateSituationStep(s, units.slice(0, i + 1), short),
      );
    validateSituationFinish(finalFrom(short), short);
    expect(short.expectations).toEqual(state.expectations);
    expect(short.final_events).toEqual([]);
  });
  it("projects every kind/status without exposing prompts or deficiency", () => {
    const q = replay("partial_and_new").state.expectations[0]!;
    for (const kind of [
      "entity_definition",
      "overview_detail",
      "reference_resolution",
      "causal_explanation",
    ] as const)
      for (const status of [
        "pending",
        "partially_satisfied",
        "satisfied",
        "contradicted",
        "unresolved_at_end",
      ] as const) {
        const projection = projectSituationExpectation({ ...q, kind, status });
        expect(projection.is_deficiency).toBe(false);
        expect(projection).not.toHaveProperty("prompt");
        expect(projection).not.toHaveProperty("sufficient");
        if (status === "unresolved_at_end")
          expect(projection.state).toBe("unresolved_at_end");
      }
  });
});

describe("preserved focus and frozen semantic matrix", () => {
  for (const file of [
    "focus-recorded-v1.json",
    "focus-logic-recorded-v1.json",
  ]) {
    const recorded = JSON.parse(
      readFileSync(`test/fixtures/readme/${file}`, "utf8"),
    ) as { cases: { id: string; units: string[]; trace: FocusStep[] }[] };
    for (const c of recorded.cases)
      it(`preserves complete existing focus trace ${file}/${c.id}`, () => {
        const units = unitsFor(c.units),
          state = createSituationLedger(units);
        for (const [i, focus] of c.trace.entries())
          validateSituationStep(
            { ...emptyStep(units[i]!), focus },
            units.slice(0, i + 1),
            state,
          );
        expect(state.focus.steps).toEqual(c.trace);
        validateSituationFinish(finalFrom(state), state);
        expect(state.entities).toEqual([]);
        expect(state.expectations).toEqual([]);
      });
  }
  it("keeps semantic expectations authored, source-valid and distinct from model measurements", () => {
    const gold = JSON.parse(
      readFileSync("test/fixtures/readme/situation-v1.json", "utf8"),
    ) as {
      provenance: string;
      revision: number;
      cases: {
        id: string;
        units: string[];
        expected_links: { origin_unit_id: string; answer_unit_id: string }[];
        forbidden_links: { origin_unit_id: string; answer_unit_id: string }[];
        expected_final_states: { status: string; is_deficiency: boolean }[];
        expected_focus_questions: { facet: string }[];
      }[];
    };
    expect(gold.provenance).toBe("authored_synthetic_not_model_output");
    expect(gold.revision).toBe(2);
    expect(gold.cases).toHaveLength(16);
    for (const c of gold.cases)
      for (const link of [...c.expected_links, ...c.forbidden_links]) {
        const origin = Number(link.origin_unit_id.slice(1)),
          target = Number(link.answer_unit_id.slice(1));
        expect(origin).toBeGreaterThan(0);
        expect(target).toBeGreaterThan(origin);
        expect(target).toBeLessThanOrEqual(c.units.length);
      }
    expect(
      gold.cases.find((c) => c.id === "repeated_undefined_name")!
        .expected_final_states[0],
    ).toMatchObject({ status: "unresolved_at_end", is_deficiency: false });
    expect(
      gold.cases.find((c) => c.id === "resolution_and_new_inquiry")!
        .expected_focus_questions[0]!.facet,
    ).toBe("basis");
    expect(
      gold.cases.find((c) => c.id === "long_delayed_definition")!.units,
    ).toHaveLength(82);
  });
});
