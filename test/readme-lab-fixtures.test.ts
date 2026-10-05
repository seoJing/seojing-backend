import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { designFixtures } from "../src/services/readme-lab/tools/design-fixtures.js";
import { v2DesignFixture } from "../src/services/readme-lab/tools/design-fixtures-v2.js";
import {
  emptyReading,
  mergeJob,
} from "../src/services/readme-lab/browser-client.js";

describe("authored design fixtures", () => {
  it("replays the explicit v2 connector example without changing old event snapshots", async () => {
    const fixture = v2DesignFixture();
    const saved: unknown = JSON.parse(
      await readFile(
        new URL(
          "../docs/fixtures/readme-lab/v2-transitions.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(saved).toEqual(fixture);
    let state = emptyReading();
    for (const snapshot of fixture.snapshots) state = mergeJob(state, snapshot);
    expect(state.questions[0]!.status).toBe("reopened");
    expect(state.questions[0]!.unit_id).toBe("u1");
    expect(state.notes.map((n) => n.kind)).toEqual([
      "question",
      "hold",
      "resolves",
      "hold",
    ]);
    const first = fixture.final.events.find(
      (e) => e.type === "question_updated",
    );
    expect(first).toMatchObject({
      status: "open",
      question: { status: "open" },
    });
    for (const item of fixture.final.report!.items) {
      for (const id of item.note_ids) {
        const note = state.notes.find((n) => n.id === id)!;
        expect(
          item.citations.some((c) =>
            note.evidence_unit_ids.includes(c.unit_id),
          ),
        ).toBe(true);
      }
    }
  });
  it("keeps checked-in artifacts reproducible with sparse, anchored notes and distinct reports", async () => {
    for (const [name, fixture] of Object.entries(designFixtures())) {
      const saved: unknown = JSON.parse(
        await readFile(
          new URL(`../docs/fixtures/readme-lab/${name}.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(saved).toEqual(fixture);
      if (!("final" in fixture)) continue;
      let reading = emptyReading();
      for (const snapshot of fixture.snapshots)
        reading = mergeJob(reading, snapshot);
      expect(reading.events).toEqual(fixture.final.events);
      const document = fixture.prepare.document!;
      for (const note of reading.notes) {
        const unit = document.units.find((u) => u.id === note.unit_id)!;
        const block = document.blocks.find((b) => b.id === note.span.block_id)!;
        expect(block.text.slice(note.span.start, note.span.end)).toBe(
          unit.text,
        );
        for (const id of note.evidence_unit_ids)
          expect(
            document.units.find((u) => u.id === id)!.order,
          ).toBeLessThanOrEqual(unit.order);
      }
      if (name === "long") {
        expect(document.units).toHaveLength(40);
        expect(document.blocks).toHaveLength(8);
        expect(reading.notes).toHaveLength(11);
        expect(fixture.final.report?.questions).toHaveLength(5);
        const report = fixture.final.report!;
        expect(new Set(report.items.map((i) => i.text)).size).toBe(
          report.items.length,
        );
        for (const item of report.items)
          expect(reading.notes.map((n) => n.text)).not.toContain(item.text);
      }
      if (name === "partial-failure") {
        expect(fixture.final.progress.read_unit_count).toBe(2);
        expect(fixture.final.report).toBeNull();
        expect(
          fixture.snapshots
            .slice(0, -1)
            .every((s) => s.error === null && s.status !== "failed"),
        ).toBe(true);
      }
    }
  });
});
