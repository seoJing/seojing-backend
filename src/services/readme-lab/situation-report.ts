import { isDeepStrictEqual } from "node:util";
import type { JobPosting, ResumeDocument } from "./contracts.js";
import { focusSourceUnit } from "./focus-contract.js";
import { focusReportState } from "./focus-report.js";
import type { SituationLedger } from "./situation-contract.js";
import { publicSituationExpectation } from "./situation-public.js";
import { LabError } from "./errors.js";

/** Neutral source-reading memory, never synthesized deficiency questions. */
export function situationReportState(
  document: ResumeDocument,
  job: JobPosting,
  ledger: SituationLedger,
) {
  if (
    !ledger.complete ||
    !ledger.focus.complete ||
    ledger.steps.length !== document.units.length ||
    !isDeepStrictEqual(
      ledger.source_units,
      document.units.map(focusSourceUnit),
    ) ||
    ledger.expectations.some(
      (q) => q.status === "pending" || q.status === "partially_satisfied",
    )
  )
    throw new LabError("reader_not_complete", 503);
  const state = focusReportState(document, job, ledger.focus);
  state.memory.situation = {
    version: ledger.version,
    entities: structuredClone(ledger.entities),
    expectations: ledger.expectations.map(publicSituationExpectation),
    is_deficiency: false,
  };
  return state;
}
