import type { EventPayload, JobPosting, ResumeDocument } from "./contracts.js";
import type { Reasoner } from "./codex.js";
import { openJev, type JevOptions } from "./jev.js";
import { readSemanticDocument } from "./semantic-pipeline.js";

/** Integration seam; public activation requires the matching engine/consent contract. */
export async function readJevDocument(
  document: ResumeDocument,
  job: JobPosting,
  reasoner: Pick<Reasoner, "report" | "reassessRole">,
  emit: (event: EventPayload) => void,
  signal: AbortSignal,
  options: JevOptions,
) {
  const reader = await openJev(signal, {
    ...options,
    ...(reasoner.reassessRole ? { reassessRole: reasoner.reassessRole } : {}),
  });
  try {
    const result = await readSemanticDocument(
      document,
      job,
      {
        readStep: (input, stepSignal) => reader.readStep(input, stepSignal),
        report: (...args) => {
          if (args[5])
            args[5].context_reviews = structuredClone(
              reader.contextReviews ?? [],
            );
          return reasoner.report(...args);
        },
      },
      emit,
      signal,
      { engine: "jev", timeoutMs: 10 * 60 * 1000 },
    );
    return { ...result, model: reader.metadata, usage: { ...reader.metrics } };
  } finally {
    reader.close();
  }
}
