/** Frozen synthetic-only real-provider evaluation. Gold never enters worker inputs. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openSituationJev, type SituationReader } from "../situation-jev.js";
import { projectSituationExpectation } from "../situation-contract.js";
import { errorCode } from "../errors.js";
import type { Unit } from "../contracts.js";

const arg = (key: string) => {
  const exact = process.argv.indexOf(`--${key}`);
  return (
    process.argv
      .find((s) => s.startsWith(`--${key}=`))
      ?.slice(key.length + 3) ??
    (exact >= 0 ? process.argv[exact + 1] : undefined)
  );
};
if (!process.argv.includes("--allow-remote-synthetic") || !arg("out"))
  throw new Error("explicit_synthetic_flags_required");
interface Link {
  origin_unit_id: string;
  answer_unit_id: string;
  status?: string;
  entity_name?: string;
  kind?: string;
}
interface GoldCase {
  id: string;
  units: string[];
  expected_attention_origins: string[];
  forbidden_attention_origins: string[];
  expected_links: Link[];
  forbidden_links: Link[];
  corrections: Link[];
  expected_final_states: Array<{
    origin_unit_id: string;
    status: string;
    is_deficiency: boolean;
    evidence_unit_ids?: string[];
    withdrawn_unit_ids?: string[];
    correction_unit_ids?: string[];
  }>;
  expected_focus_questions: Array<{ origin_unit_id: string; facet: string }>;
  expected_entities?: Array<{
    name: string;
    origin_unit_id: string;
    start?: number;
    end?: number;
  }>;
  forbidden_entity_names?: string[];
  forbidden_expectations?: Array<{ origin_unit_id: string; kind: string }>;
  forbidden_updates?: Link[];
}
const fixturePath = arg("fixture") ?? "test/fixtures/readme/situation-v1.json";
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  provenance: string;
  revision: number;
  cases: GoldCase[];
};
if (fixture.provenance !== "authored_synthetic_not_model_output")
  throw new Error("synthetic_required");
const config = arg("config")
  ? (JSON.parse(await readFile(arg("config")!, "utf8")) as Record<
      string,
      string
    >)
  : process.env;
const apiKey = config.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("provider_key_missing");
const out = resolve(arg("out")!);
await mkdir(out, { recursive: false, mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFile(resolve(out, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      "python/jev_situation_reader.py",
      "python/jev_situation_runtime.py",
      "python/jev_focus_reader.py",
      "python/decision_providers.py",
      "python/jev_reader.py",
      "situation-contract.ts",
      "situation-jev.ts",
    ].map(
      async (p): Promise<[string, string]> => [
        p,
        hash(await readFile(resolve("src/services/readme-lab", p))),
      ],
    ),
  ),
);
await save("provenance.json", {
  synthetic: true,
  fixture: fixturePath,
  fixture_sha256: hash(fixtureBytes),
  fixture_revision: fixture.revision,
  engine_hashes: sourceHashes,
  started_at: new Date().toISOString(),
  actual_provider: "typesafe",
  model: "jev-1.13.0",
  gold_supplied_to_model: false,
});
const selected = fixture.cases.filter(
  (c) => !arg("cases") || arg("cases")!.split(",").includes(c.id),
);
if (
  !selected.length ||
  new Set(selected.map((c) => c.id)).size !== selected.length ||
  selected.some((c) => !/^[a-z0-9_-]+$/u.test(c.id))
)
  throw new Error("invalid_case_selection");
const summaries: unknown[] = [];
let allPass = true;
for (const c of selected) {
  let scope = 0;
  const units: Array<Unit & { block_type: string }> = c.units.map((text, i) => {
    if (text.startsWith("#")) scope++;
    return {
      id: `u${i + 1}`,
      block_id: `b${i + 1}`,
      order: i,
      scope_id: `s${scope}`,
      text,
      start: 0,
      end: text.length,
      block_type: text.startsWith("#") ? "heading" : "paragraph",
    };
  });
  const started = Date.now(),
    controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  let reader: SituationReader | undefined,
    error: string | null = null;
  try {
    reader = await openSituationJev(controller.signal, units, {
      apiKey,
      python:
        config.README_JEV_PYTHON ??
        "/Users/seojing/Projects/seojing-backend/.local/readme-laya/venv/bin/python",
      timeoutMs: 60000,
    });
    for (let i = 1; i <= units.length; i++)
      await reader.readStep(
        units.slice(0, i),
        "합성 문서의 경험 설명을 읽습니다.",
      );
    await reader.finish();
  } catch (e) {
    error = controller.signal.aborted ? "engine_timeout" : errorCode(e);
  } finally {
    clearTimeout(timer);
    reader?.close();
  }
  const ledger = reader?.ledger;
  const events = ledger?.steps.flatMap((s) => s.events) ?? [];
  const situationEventCount =
    events.length + (ledger?.final_events.length ?? 0);
  const focusEventCount =
    ledger?.steps.reduce((sum, step) => sum + step.focus.events.length, 0) ?? 0;
  const updates = events.filter((e) => e.type === "expectation_updated");
  const linkMatches = (link: Link, e: (typeof updates)[number]) =>
    e.expectation.origin_unit_id === link.origin_unit_id &&
    e.at_unit_id === link.answer_unit_id &&
    (!link.status || e.expectation.status === link.status) &&
    (!link.kind || e.expectation.kind === link.kind) &&
    (!link.entity_name ||
      ledger?.entities.some(
        (entity) =>
          entity.canonical_name === link.entity_name &&
          e.expectation.entity_ids.includes(entity.id),
      ));
  const missedLinks = c.expected_links.filter(
    (link) => !updates.some((e) => linkMatches(link, e)),
  );
  const forbiddenLinks = c.forbidden_links.filter((link) =>
    updates.some(
      (e) =>
        ["satisfied", "partially_satisfied"].includes(e.expectation.status) &&
        linkMatches(link, e),
    ),
  );
  const missingAttention = c.expected_attention_origins.filter(
    (id) =>
      !events.some(
        (e) =>
          e.type === "attention_created" && e.expectation.origin_unit_id === id,
      ),
  );
  const forbiddenAttention = c.forbidden_attention_origins.filter((id) =>
    events.some(
      (e) =>
        e.type === "attention_created" && e.expectation.origin_unit_id === id,
    ),
  );
  const missingCorrections = c.corrections.filter(
    (link) =>
      !updates.some(
        (e) => e.expectation.status === "contradicted" && linkMatches(link, e),
      ),
  );
  const missingFinal = c.expected_final_states.filter(
    (expected) =>
      !ledger?.expectations.some(
        (q) =>
          q.origin_unit_id === expected.origin_unit_id &&
          q.status === expected.status &&
          projectSituationExpectation(q).is_deficiency ===
            expected.is_deficiency &&
          (!expected.evidence_unit_ids ||
            JSON.stringify(q.evidence.map((p) => p.unit_id)) ===
              JSON.stringify(expected.evidence_unit_ids)) &&
          (!expected.withdrawn_unit_ids ||
            JSON.stringify(q.withdrawn_evidence.map((p) => p.unit_id)) ===
              JSON.stringify(expected.withdrawn_unit_ids)) &&
          (!expected.correction_unit_ids ||
            JSON.stringify(q.correction_evidence.map((p) => p.unit_id)) ===
              JSON.stringify(expected.correction_unit_ids)),
      ),
  );
  const missingFocus = c.expected_focus_questions.filter(
    (expected) =>
      !ledger?.focus.questions.some(
        (q) =>
          q.origin_unit_id === expected.origin_unit_id &&
          q.facet === expected.facet,
      ),
  );
  const missingEntities = (c.expected_entities ?? []).filter(
    (expected) =>
      !ledger?.entities.some(
        (e) =>
          e.canonical_name === expected.name &&
          e.introduced_at_unit_id === expected.origin_unit_id &&
          (expected.start === undefined || e.origin.start === expected.start) &&
          (expected.end === undefined || e.origin.end === expected.end),
      ),
  );
  const forbiddenEntities = (c.forbidden_entity_names ?? []).filter((name) =>
    ledger?.entities.some((e) => e.canonical_name === name),
  );
  const forbiddenExpectations = (c.forbidden_expectations ?? []).filter(
    (expected) =>
      ledger?.expectations.some(
        (q) =>
          q.origin_unit_id === expected.origin_unit_id &&
          q.kind === expected.kind,
      ),
  );
  const forbiddenUpdates = (c.forbidden_updates ?? []).filter((link) =>
    updates.some((e) => linkMatches(link, e)),
  );
  const pass =
    !error &&
    Boolean(ledger?.complete) &&
    [
      missedLinks,
      forbiddenLinks,
      missingAttention,
      forbiddenAttention,
      missingCorrections,
      missingFinal,
      missingFocus,
      missingEntities,
      forbiddenEntities,
      forbiddenExpectations,
      forbiddenUpdates,
    ].every((a) => !a.length);
  allPass &&= pass;
  const summary = {
    case: c.id,
    completed: Boolean(ledger?.complete),
    semantic_pass: pass,
    error,
    units: units.length,
    read_units: ledger?.steps.length ?? 0,
    elapsed_ms: Date.now() - started,
    source_sha256: hash(JSON.stringify(c.units)),
    metrics: reader?.metrics ?? null,
    diagnostics: reader?.diagnostics ?? null,
    missing_links: missedLinks,
    forbidden_links: forbiddenLinks,
    missing_attention: missingAttention,
    forbidden_attention: forbiddenAttention,
    missing_corrections: missingCorrections,
    missing_final_states: missingFinal,
    missing_focus_questions: missingFocus,
    missing_entities: missingEntities,
    forbidden_entities: forbiddenEntities,
    forbidden_expectations: forbiddenExpectations,
    forbidden_updates: forbiddenUpdates,
    situation_event_count: situationEventCount,
    focus_event_count: focusEventCount,
    event_count: situationEventCount + focusEventCount,
    events_per_unit: (situationEventCount + focusEventCount) / units.length,
    events_per_read_unit: ledger?.steps.length
      ? (situationEventCount + focusEventCount) / ledger.steps.length
      : 0,
    event_density_excludes:
      "window envelopes and reading/report lifecycle events",
  };
  summaries.push(summary);
  await save(`${c.id}.json`, {
    ...summary,
    synthetic_source: c.units,
    metadata: reader?.metadata ?? null,
    steps: ledger?.steps ?? [],
    final_events: ledger?.final_events ?? [],
    snapshot: ledger
      ? {
          entities: ledger.entities,
          expectations: ledger.expectations,
          questions: ledger.focus.questions,
        }
      : null,
  });
  process.stdout.write(
    JSON.stringify({
      case: c.id,
      completed: summary.completed,
      semantic_pass: pass,
      error,
      calls: reader?.metrics.calls,
      elapsed_ms: summary.elapsed_ms,
    }) + "\n",
  );
}
await save("summary.json", {
  actual_provider: true,
  synthetic: true,
  all_pass: allPass,
  cases: summaries,
});
if (!allPass) process.exitCode = 2;
