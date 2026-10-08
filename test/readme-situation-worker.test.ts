import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ResumeDocument,
  JobPosting,
  Unit,
} from "../src/services/readme-lab/contracts.js";
import { openSituationJev } from "../src/services/readme-lab/situation-jev.js";
import {
  publicSituationEvent,
  publicSituationExpectation,
} from "../src/services/readme-lab/situation-public.js";
import { situationReportState } from "../src/services/readme-lab/situation-report.js";
import { reportInput } from "../src/services/readme-lab/report-v2.js";
const fixture = JSON.parse(
  readFileSync("test/fixtures/readme/situation-contract-v1.json", "utf8"),
) as { cases: { id: string; units: string[] }[] };
const options = {
  apiKey: "synthetic-worker-key-not-remote",
  script: resolve("test/fixtures/readme/situation-worker-stub.py"),
  timeoutMs: 1000,
};
function source(name = "partial_and_new"): Unit[] {
  return fixture.cases
    .find((c) => c.id === name)!
    .units.map((text, i) => ({
      id: `u${i + 1}`,
      block_id: `b${i + 1}`,
      scope_id: "s1",
      order: i,
      start: 0,
      end: text.length,
      text,
    }));
}
async function completed(name = "partial_and_new") {
  const units = source(name),
    reader = await openSituationJev(
      new AbortController().signal,
      units,
      options,
    );
  try {
    for (let i = 1; i <= units.length; i++)
      await reader.readStep(units.slice(0, i), name);
    await reader.finish();
    return { units, ledger: reader.ledger };
  } finally {
    reader.close();
  }
}
describe("situation worker lifecycle", () => {
  for (const mode of ["duplicate-step", "unsolicited-step"])
    it(`rejects same-chunk ${mode} before committing`, async () => {
      const units = source(),
        reader = await openSituationJev(
          new AbortController().signal,
          units,
          options,
        );
      try {
        await expect(
          reader.readStep(units.slice(0, 1), `partial_and_new:${mode}`),
        ).rejects.toThrow("engine_output_invalid");
        expect(reader.ledger.steps).toHaveLength(0);
        expect(reader.ledger.focus.steps).toHaveLength(0);
      } finally {
        reader.close();
      }
    });
  it("rejects duplicate finish response before applying any final event", async () => {
    const units = source(),
      reader = await openSituationJev(
        new AbortController().signal,
        units,
        options,
      );
    try {
      for (let i = 1; i <= units.length; i++)
        await reader.readStep(
          units.slice(0, i),
          "partial_and_new:duplicate-finish",
        );
      const before = structuredClone(reader.ledger);
      await expect(reader.finish()).rejects.toThrow("engine_output_invalid");
      expect(reader.ledger).toEqual(before);
    } finally {
      reader.close();
    }
  });

  it("binds read/finish and exposes only allowlisted counts", async () => {
    const units = source(),
      reader = await openSituationJev(
        new AbortController().signal,
        units,
        options,
      );
    try {
      await expect(reader.finish()).rejects.toThrow("reader_not_complete");
      for (let i = 1; i <= units.length; i++)
        await reader.readStep(units.slice(0, i), "partial_and_new");
      const finish = await reader.finish();
      expect(finish.final_events).toHaveLength(2);
      expect(reader.ledger.complete).toBe(true);
      expect(reader.ledger.focus.complete).toBe(true);
      expect(reader.diagnostics?.situation.provider_retries).toBe(0);
      expect(
        Object.values(reader.diagnostics!.situation).every(
          (v) => typeof v === "number",
        ),
      ).toBe(true);
      await expect(reader.finish()).rejects.toThrow();
    } finally {
      reader.close();
    }
  });
  for (const [mode, error] of [
    ["invalid-step", "engine_output_invalid"],
    ["fail", "engine_unavailable"],
    ["stall", "engine_timeout"],
  ])
    it(`keeps both ledgers at prior prefix on ${mode}`, async () => {
      const units = source(),
        reader = await openSituationJev(new AbortController().signal, units, {
          ...options,
          timeoutMs: 100,
        });
      try {
        await reader.readStep(units.slice(0, 1), `partial_and_new:${mode}`);
        const before = structuredClone(reader.ledger);
        await expect(
          reader.readStep(units, `partial_and_new:${mode}`),
        ).rejects.toThrow(error);
        expect(reader.ledger).toEqual(before);
      } finally {
        reader.close();
      }
    });
  it("rejects unallowlisted diagnostics before any state commit", async () => {
    const units = source(),
      reader = await openSituationJev(
        new AbortController().signal,
        units,
        options,
      );
    try {
      await expect(
        reader.readStep(
          units.slice(0, 1),
          "partial_and_new:invalid-diagnostic",
        ),
      ).rejects.toThrow("engine_output_invalid");
      expect(reader.ledger.steps).toHaveLength(0);
    } finally {
      reader.close();
    }
  });
  for (const mode of ["finish-fail", "finish-stall"])
    it(`does not apply partial final events on ${mode}`, async () => {
      const units = source(),
        reader = await openSituationJev(new AbortController().signal, units, {
          ...options,
          timeoutMs: 100,
        });
      try {
        for (let i = 1; i <= units.length; i++)
          await reader.readStep(units.slice(0, i), `partial_and_new:${mode}`);
        const before = structuredClone(reader.ledger);
        await expect(reader.finish()).rejects.toThrow();
        expect(reader.ledger).toEqual(before);
      } finally {
        reader.close();
      }
    });
  it("cancels a pending request and closes the process", async () => {
    const units = source(),
      control = new AbortController(),
      reader = await openSituationJev(control.signal, units, options);
    try {
      await reader.readStep(units.slice(0, 1), "partial_and_new:stall");
      const before = structuredClone(reader.ledger);
      const pending = reader.readStep(units, "partial_and_new:stall");
      const rejection = expect(pending).rejects.toThrow("cancelled");
      control.abort();
      await rejection;
      expect(reader.ledger).toEqual(before);
    } finally {
      reader.close();
    }
  });
  it("rejects overlapping worker requests", async () => {
    const units = source(),
      reader = await openSituationJev(
        new AbortController().signal,
        units,
        options,
      );
    try {
      const first = reader.readStep(units.slice(0, 1), "partial_and_new");
      await expect(
        reader.readStep(units.slice(0, 1), "partial_and_new"),
      ).rejects.toThrow("engine_busy");
      await first;
      expect(reader.ledger.steps).toHaveLength(1);
    } finally {
      reader.close();
    }
  });
});
describe("neutral public/report projection", () => {
  it("strips internal conditions from every snapshot without changing source links", async () => {
    const { ledger } = await completed();
    const events = [
      ...ledger.steps.flatMap((s) => s.events),
      ...ledger.final_events,
    ].map(publicSituationEvent);
    expect(JSON.stringify(events)).not.toContain('"prompt"');
    expect(JSON.stringify(events)).not.toContain('"sufficient"');
    for (const event of events)
      if ("expectation" in event) {
        expect(event.expectation.origin.quote).toBeTruthy();
        expect(event.expectation.state_version).toBeGreaterThan(0);
      }
    const q = ledger.expectations[0]!,
      publicQ = publicSituationExpectation(q);
    publicQ.evidence[0]!.quote = "changed";
    expect(q.evidence[0]!.quote).not.toBe("changed");
  });
  it("source-binds finished report memory and never adds expectation questions", async () => {
    const { units, ledger } = await completed();
    const doc: ResumeDocument = {
      doc_id: "synthetic",
      source_kind: "txt",
      blocks: [],
      units,
      warnings: [],
      truncated: false,
    };
    const job: JobPosting = {
      source: "user_paste",
      text: "합성",
      requirements: [],
      warnings: [],
      reader_profile: { id: "p1", version: "reader-profile-v2", criteria: [] },
    };
    const result = situationReportState(doc, job, ledger);
    expect(result.questions).toEqual([]);
    expect(result.memory.situation?.is_deficiency).toBe(false);
    const input = reportInput(
      doc,
      job,
      result.notes,
      result.questions,
      result.memory,
    );
    expect(input).toHaveProperty("situation_reader");
    expect(input.limitation).toContain("NEVER infer a revision");
    expect(JSON.stringify(result.memory.situation)).not.toContain('"prompt"');
    const changed = structuredClone(doc);
    changed.units[0]!.text = "different";
    expect(() => situationReportState(changed, job, ledger)).toThrow(
      "reader_not_complete",
    );
    const unfinished = structuredClone(ledger);
    unfinished.complete = false;
    expect(() => situationReportState(doc, job, unfinished)).toThrow(
      "reader_not_complete",
    );
  });
});
