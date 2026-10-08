import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateFocusStep,
  type FocusLedger,
  type FocusStep,
} from "../src/services/readme-lab/focus-contract.js";
import { openFocusJev } from "../src/services/readme-lab/focus-jev.js";
import { focusReportState } from "../src/services/readme-lab/focus-report.js";
import type {
  Unit,
  ResumeDocument,
  JobPosting,
} from "../src/services/readme-lab/contracts.js";

const cases = (
  JSON.parse(
    readFileSync("test/fixtures/readme/focus-recorded-v1.json", "utf8"),
  ) as { cases: { id: string; units: string[]; trace: FocusStep[] }[] }
).cases;
function unitsFor(texts: string[]): Unit[] {
  let scope = 0;
  return texts.map((text, i) => {
    if (text.startsWith("#")) scope++;
    return {
      id: `u${i + 1}`,
      block_id: `b${i + 1}`,
      order: i,
      scope_id: `s${scope}`,
      text,
      start: 0,
      end: text.length,
    };
  });
}
const ledger = (): FocusLedger => ({
  version: "focus-reader-v1",
  steps: [],
  questions: [],
  units: [],
  complete: false,
});
function replay(name: string, end?: number) {
  const item = cases.find((c) => c.id === name)!;
  const units = unitsFor(item.units),
    state = ledger();
  for (let i = 0; i < (end ?? item.trace.length); i++)
    validateFocusStep(item.trace[i], units.slice(0, i + 1), state);
  return { item, units, state };
}
describe("focus source-bound protocol", () => {
  const logicTraces = JSON.parse(
    readFileSync("test/fixtures/readme/focus-logic-recorded-v1.json", "utf8"),
  ) as {
    cases: {
      id: string;
      units: string[];
      trace: FocusStep[];
      questions: FocusLedger["questions"];
    }[];
  };
  for (const c of logicTraces.cases)
    it(`accepts v1 discovery/recheck trace ${c.id} without rewriting history`, () => {
      const units = unitsFor(c.units),
        state = ledger();
      for (let i = 0; i < c.trace.length; i++)
        validateFocusStep(c.trace[i], units.slice(0, i + 1), state);
      expect(state.questions).toEqual(c.questions);
      expect(state.steps).toEqual(c.trace);
    });
  for (const c of cases)
    it(`accepts actual Jev trace ${c.id}`, () => {
      const { state } = replay(c.id);
      expect(state.steps).toHaveLength(c.units.length);
    });
  it("rejects resolution without newly read proof atomically", () => {
    const { item, units, state } = replay("role_then_answer", 2),
      before = structuredClone(state);
    const next = structuredClone(item.trace[2]!);
    const update = next.events.find((e) => e.type === "updated")!;
    if (update.type !== "updated") throw new Error("fixture");
    update.question.evidence = [
      {
        unit_id: "u2",
        quote: units[1]!.text,
        start: 0,
        end: units[1]!.text.length,
      },
    ];
    expect(() => validateFocusStep(next, units, state)).toThrow(
      "engine_output_invalid",
    );
    expect(state).toEqual(before);
  });
  it("rejects changed prefix and future target", () => {
    const { item, units, state } = replay("role_then_answer", 2);
    const altered = structuredClone(units);
    altered[0]!.text = "다른 경험";
    expect(() => validateFocusStep(item.trace[2], altered, state)).toThrow();
    const next = structuredClone(item.trace[2]!);
    const revisit = next.events.find((e) => e.type === "revisit")!;
    if (revisit.type !== "revisit") throw new Error("fixture");
    revisit.target_unit_ids.push("u99");
    expect(() => validateFocusStep(next, units, state)).toThrow();
  });
  it("keeps the other active inquiry when a parked question is answered", () => {
    const { state } = replay("active_question_survives_return");
    expect(state.questions.find((q) => q.origin_unit_id === "u4")?.focus).toBe(
      "active",
    );
    expect(state.questions.find((q) => q.origin_unit_id === "u2")?.status).toBe(
      "resolved",
    );
  });
  it("requires withdrawn original evidence for corrections and retractions", () => {
    const r = replay("resolved_then_corrected", 3),
      next = structuredClone(r.item.trace[3]!);
    const update = next.events.find((e) => e.type === "updated")!;
    if (update.type !== "updated") throw new Error("fixture");
    update.question.withdrawn_evidence = [];
    expect(() => validateFocusStep(next, r.units, r.state)).toThrow();
    const n = replay("corrected_observation", 2),
      correction = structuredClone(n.item.trace[2]!);
    const retract = correction.events.find((e) => e.type === "retracted")!;
    if (retract.type !== "retracted") throw new Error("fixture");
    retract.evidence = retract.evidence.filter((p) => p.unit_id === "u3");
    expect(() => validateFocusStep(correction, n.units, n.state)).toThrow();
  });
  it("binds reports to completed original source", () => {
    const { units, state } = replay("role_then_answer");
    const document: ResumeDocument = {
      doc_id: "test",
      source_kind: "txt",
      units,
      blocks: [],
      warnings: [],
      truncated: false,
    };
    const job: JobPosting = {
      source: "user_paste",
      text: "개발",
      requirements: [],
      warnings: [],
      reader_profile: { id: "p1", version: "reader-profile-v2", criteria: [] },
    };
    expect(() => focusReportState(document, job, state)).toThrow(
      "reader_not_complete",
    );
    state.complete = true;
    expect(focusReportState(document, job, state).questions[0]?.status).toBe(
      "resolved",
    );
    const changed = structuredClone(document);
    changed.units[1]!.text = "다른 원문";
    expect(() => focusReportState(changed, job, state)).toThrow(
      "reader_not_complete",
    );
  });
});
describe("focus worker lifecycle", () => {
  const options = {
    apiKey: "synthetic-test-key-never-remote",
    script: resolve("test/fixtures/readme/focus-worker-stub.py"),
    timeoutMs: 3000,
  };
  it("finishes only after all source windows and confirms the final ledger", async () => {
    const reader = await openFocusJev(new AbortController().signal, 3, options);
    try {
      await expect(reader.finish()).rejects.toThrow("reader_not_complete");
      const units = unitsFor(cases[0]!.units);
      for (let i = 1; i <= 3; i++)
        await reader.readStep(units.slice(0, i), "test");
      await reader.finish();
      expect(reader.ledger.complete).toBe(true);
      expect(reader.diagnostics).toBeNull(); // older worker compatibility
    } finally {
      reader.close();
    }
  });
  it("validates count-only internal diagnostics across reading and finish", async () => {
    const reader = await openFocusJev(new AbortController().signal, 3, options);
    try {
      const units = unitsFor(cases[0]!.units);
      for (let i = 1; i <= 3; i++)
        await reader.readStep(units.slice(0, i), "diagnostics");
      await reader.finish();
      expect(reader.diagnostics?.fallback_rechecks).toBe(1);
      expect(Object.values(reader.diagnostics!)).toEqual(
        expect.arrayContaining([0, 1]),
      );
      expect(JSON.stringify(reader.ledger)).not.toContain("fallback_rechecks");
    } finally {
      reader.close();
    }
  });
  it("rejects non-allowlisted diagnostic fields before committing a window", async () => {
    const reader = await openFocusJev(new AbortController().signal, 3, options);
    try {
      await expect(
        reader.readStep(
          unitsFor(cases[0]!.units).slice(0, 1),
          "invalid-diagnostics",
        ),
      ).rejects.toThrow("engine_output_invalid");
      expect(reader.ledger.steps).toHaveLength(0);
      expect(reader.diagnostics).toBeNull();
    } finally {
      reader.close();
    }
  });
  it("provider failure leaves the interrupted window uncommitted", async () => {
    const reader = await openFocusJev(new AbortController().signal, 3, options),
      units = unitsFor(cases[0]!.units);
    try {
      await reader.readStep(units.slice(0, 1), "fail");
      await expect(reader.readStep(units.slice(0, 2), "fail")).rejects.toThrow(
        "engine_unavailable",
      );
      expect(reader.ledger.steps).toHaveLength(1);
      expect(reader.ledger.complete).toBe(false);
    } finally {
      reader.close();
    }
  });
  it("cancels an in-flight worker without committing source", async () => {
    const controller = new AbortController(),
      reader = await openFocusJev(controller.signal, 3, options);
    const pending = reader.readStep(
      unitsFor(cases[0]!.units).slice(0, 1),
      "stall",
    );
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(reader.ledger.steps).toHaveLength(0);
  });
});
