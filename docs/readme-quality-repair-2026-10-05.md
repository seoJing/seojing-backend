# Jev and report quality repair · 2026-10-05 KST

## Scope and evidence boundaries

The user authorized repairs to the failed validation in `readme-validation-2026-10-05.md`: experience/outcome attribution, stale partial feedback, final report reliability and measured waiting time. API-03 owns the backend checkout. Baseline branch is `codex/readme-laya-runtime`, HEAD `f8addbf07d8666ddc986b21a233034746e9fa3f1`, with existing uncommitted Lab work preserved. No frontend schema, production service, deployment or real user document was changed.

All model inputs here are synthetic and agent-authored. Labels are provisional; this is development regression evidence, not a human-reviewed accuracy estimate. Source and input snapshots precede each model invocation. The pre-edit source is preserved under `.local/readme-laya/jev-quality-repair-2026-10-05/baseline/`.

## Reader changes

- Check the current sentence's relationship before retrieving historical support. Retain the original claim's framing and the candidate's entire preceding prefix, including distant section changes. Experience and outcome must both match. Structural scope IDs do not prove that two statements concern the same experience.
- Include a measurement-period fact only when the generated sufficient condition explicitly requires it. Cache this decision by facet, question, sufficient/insufficient condition and option order. One focused retry can clarify a weak requirement decision; the 0.75 threshold is unchanged.
- Select a smallest supporting source cover, accounting for the origin/current anchors already required in public evidence. A newer source does not automatically replace an earlier source that covers more required facts. The six-source and 400-UTF16-per-quote public limits remain; the reader never trims verified evidence to force it through.
- A complete answer that cannot yet be confirmed can update partial knowledge only when its positive proof is valid. Audit partial facts individually; rejecting one fact does not make that detail absent or discard separately verified facts. Neutral partial feedback replaces obsolete requests without declaring the question resolved.
- A resolved question no longer gets a fresh resolution note on background text when the actual positive proof still comes from an earlier sentence.

Independent review found an additional partial-proof hazard: recomputing the source cover after auditing only some facts could switch to a source absent from the audited proposal. The v14 patch keeps the exact audited proposal and restricts surviving support IDs to it. The reproducing regression and independent re-review pass; intermediate v13 measurements precede that correction. A later short-document failure required the v16/reader-v5 corrections described below.

## Frozen focused comparison

Fixture: `test/fixtures/readme/jev-context-repair-v1.json`, eight cases frozen before the first new model run. Six cases derive from the previous serving input/profile; two new controls cover an explicit return to an earlier experience and a different outcome within the same experience. Expected labels never enter inference.

| Version          | Expected-label matches | Accepted wrong labels | False complete | Calls | Input tokens | Elapsed |
| ---------------- | ---------------------: | --------------------: | -------------: | ----: | -----------: | ------: |
| Pre-edit v11     |                    3/8 |                     3 |              2 |   301 |      353,449 | 66.409s |
| Intermediate v12 |                    4/8 |                     1 |              0 |   101 |      231,029 | 22.573s |
| Intermediate v13 |                    7/8 |                     0 |              0 |   105 |      240,388 | 23.606s |
| Final v16        |                    8/8 |                     0 |              0 |   114 |      261,401 | 25.106s |

Artifacts: `.local/readme-laya/jev-context-repair-v11-baseline`, `jev-context-repair-v12-run1`, `jev-context-repair-v13-run1`; each contains input, frozen source, individual outputs, raw synthetic call journals and aggregate usage. In v13, all three sufficient-answer cases complete, the genuinely incomplete comparison remains partial, three unrelated cases are rejected, and one unrelated festival sentence remains conservatively unknown. That last result is a missed classification, not an accepted answer. No release-level pass or general latency improvement is inferred from eight development cases.

## Report changes

The report's eight-quote limit remains. Writer guidance requires each item's own citations to cover its experience, actor and measurement context, replacing redundant citations or splitting a large initial item rather than appending past the cap.

The isolated citation audit now returns an exact disputed phrase and a concrete reason. Validation rejects absent phrases, empty explanations and contradictory approval/rejection fields. Natural paraphrases and clear Korean omitted subjects are permitted, but the judge still sees only that item's own quotations. It cannot fill a missing citation from the rest of the document or another item.

Targeted repair must actually change the rejected observation or citation set. Reordering quotes or changing only a suggestion does not count. Unique items cannot be deleted to make citation rejection disappear; only a full-source duplicate finding permits deletion. Approved neighbors remain server-owned. Citation repair sends all source units and the failed items plus relevant reference metadata, omitting repeated histories and unrelated approved items. The final full-source audit still checks missing-detail claims, scope, actor, suggestions and duplication. Report input also removes duplicated question snapshots from transitions and display offsets from notes without removing source or the current question ledger.

Fresh report-only generation from the saved original reading results completed in **133.816s**, with nine report items, eleven model calls and no rejection/repair cycle. The earlier diagnostic of that same reconstructed input failed after 300.251s. These are different generations, so this does not prove the old exact drafts would now pass or isolate which change caused the outcome. Artifact: `.local/readme-laya/jev-report-diagnostic-repair1/`, including input, frozen source, result and runner. The original HTTP failure's precise raw draft remains unavailable.

## Final reader/report flow with frozen preparation

`.local/readme-laya/jev-frozen-flow-v14-run1` reuses the document and job profile from the first current-turn HTTP run, with final v14/v4 reader and report code frozen before invocation. `freeze.json` contains both inputs, their origin and source hashes; there is no separate `input.json`. This isolates the reader/report and excludes fresh parsing, profiling and HTTP queue time.

- All 55 units (50 body sentences and five headings) read in **89.169s**; report generation finished at **196.353s** total. Nine report items, eleven Codex calls, no report rejection/repair cycle.
- Jev: **372 calls / 1,326,930 input / 83,798 output tokens / zero omitted proofs**. Calls are fewer than the earlier 530-call HTTP run, but input tokens are higher than its 1,243,943; this is not evidence of a token-cost reduction.
- Center role question q1 opens at u3, is partial at the explicit role statement u4, and first resolves at u5. It remains within the center experience through u14. Strict immediate-next-sentence resolution is not achieved in this run.
- Center satisfaction q2 stays partial. Library and festival measurements never become its proof. Its u18 feedback is still generic despite u16 denying measurement and u17 identifying gratitude as the basis; safe non-resolution does not establish good feedback wording.
- Library comparison q3 updates known facts and resolves when the actual 12-minute to 9-minute values arrive at u31. No later note asks for those already supplied values.
- Final report separates center satisfaction, library response times, personal/team duties, festival absolute counts, a colleague's survey and Excel practice. Its question ledger exactly preserves the reading ledger.

Two independent read-only reviewers verified **47 frozen source hashes, 42 exact report citations, 18 note spans and transitions, three final questions and all 55 read units**. No cross-experience proof, future-text evidence or state-replay mismatch was found. These checks establish this artifact's consistency, not general model accuracy. Actual repair behavior is covered deterministically; neither successful real report run exercised the repair branch.

## Full-service verification

Global scheduling remains one active operation with four total admitted operations; no concurrency contract change has been made.

The first current-turn compiled loopback run, `.local/readme-laya/jev-http-quality-repair-run1`, **failed overall**. The long client failed during reading at 11/55 units, 195.895s after start, with `engine_unavailable`; the short client completed at 304.233s. Eighteen of nineteen transport assertions passed. The exact provider error was not captured, so a transient HTTP error, budget failure or other cause cannot be inferred. Its preparation overlapped the independent report-only diagnostic. Shorter completion than the earlier baseline partly reflects the long client's early failure and cannot establish a queue improvement.

Added opt-in private diagnostics: the Python worker returns fixed local provider codes and known usage on failure; Node independently allowlists the codes before the synthetic probe records them. No provider body, raw exception, credentials or source text enters these diagnostics or public job events. Fake-provider tests verify the allowlist and failed-attempt metrics; this does not recover the first failed run's missing diagnostic.

The v14 compiled two-client rerun is recorded separately in `.local/readme-laya/jev-http-quality-repair-v14-run1`. It executes the Python worker from its frozen source snapshot and ran without another concurrent model experiment. **Transport passed 19/19 checks**, including completion, ownership, idempotency, cancellation capacity, overflow and ordered events. Both clients completed; the saved run elapsed is 512.995s (console 513.000s). No provider failure was observed. Sampled descendant RSS sum peaked at 495.2 MiB, not a system-memory capacity measurement.

| Client | Units | Completion including queue | Reading phase | Report phase | Approximate queue wait | Jev usage: calls / input / output |
| ------ | ----: | -------------------------: | ------------: | -----------: | ---------------------: | --------------------------------- |
| Long   |    55 |                   362.521s |       88.774s |     121.086s |                65.096s | 377 / 1,329,909 / 83,038          |
| Short  |    21 |                   512.991s |       13.377s |     137.162s |               296.266s | 54 / 154,810 / 11,379             |

Queue times use server phase boundaries and request records; completion is observed by polling. Neither reader omitted a proof. Independent review checked all 65 citations, 48 source hashes and both event ledgers. The long client passed all six frozen semantic controls, including adjacent role resolution at u4. **Overall semantic acceptance nevertheless failed:** short-client event 32 attached the festival survey at u15 to the center satisfaction question at u7 as partial evidence. Its final report correctly rejected that association. A successful HTTP response does not establish semantic consistency. No production path, frontend browser or deployment claim follows from loopback HTTP.

## Final v16 scope and zero-proof correction

The short failure is frozen in `test/fixtures/readme/jev-short-scope-regression-v1.json`. A focused v15 reproduction (`jev-short-scope-v15-baseline`) also produced the wrong partial result. The primary scope judgment was weak `different`; the focused recheck incorrectly returned confident `same` while using a weaker scope instruction. All source facts were missing or uncertain and `evidence=[]`, yet the adapter added origin/current display anchors and emitted a partial transition.

Final grounded v16 shares the complete experience/outcome policy between primary and focused scope checks. Reader v5 requires nonempty audited positive evidence before a partial transition; display anchors cannot manufacture that proof. Missing-only judgments leave the question ledger unchanged. This deliberately also suppresses a standalone limitation/plan note when no positive answer fact is verified: the final whole-source report still explains those limitations. No new context-note path or public contract was introduced. Positive partial updates and prior-proof withdrawal/reopening remain covered by regressions.

Intermediate v15 changed only the explicit-absence feedback wording: where a partial answer has positive proof, it asks the user to retain the stated limitation and adjust the improvement claim, instead of asking whether an already-disclaimed measurement was performed. This wording remains in v16.

Actual focused v16 results: the original eight-case set passes **8/8**, zero accepted wrong labels; the added short case becomes **unknown**, with no adopted evidence (two calls, 3,020 input tokens, 0.394s). Its exact expected `unrelated` label is still not achieved, so it is not counted as a ninth classification pass. The safety outcome improves from wrong adoption to abstention. Thresholds remain unchanged.

Final v16/reader-v5 full reading/report replays are saved under `.local/readme-laya/jev-frozen-short-v16-run1` and `jev-frozen-long-v16-run1`. They reuse the v14 HTTP preparation/profile and execute frozen worker source. Their model work overlaps, so timings are diagnostic only and do not replace the v14 serial-service measurement.

| Final v16 replay | Units | Reading | Reading + report | Jev calls / input / output | Report items / exact citations |
| ---------------- | ----: | ------: | ---------------: | -------------------------- | ------------------------------ |
| Short            |    21 | 18.389s |         125.941s | 78 / 198,334 / 14,575      | 9 / 20                         |
| Long             |    55 | 85.891s |         215.009s | 363 / 1,293,257 / 80,945   | 8 / 42                         |

Both completed without an omitted proof or recorded report rejection. Short/long report generation recorded eleven/ten Codex calls respectively, each completing on its first attempt. Independent review verified 47 frozen source hashes per replay, exact citations, source-prefix boundaries and question-state replay. Current source hashes match the tested v16 snapshot.

Both satisfaction questions now finish `open_at_end` with empty candidate/evidence IDs. Festival and library measurements are not adopted into them. The short report distinguishes the festival survey from the ungrounded center improvement claim. The long report explains the center's stated measurement limitation and correctly accepts the library's 12→9-minute comparison at u31. It preserves personal/team, absolute count, colleague survey and actual/practice boundaries.

The strict immediate-role checkpoint still fails in these final replays: short u5 is partial until u6; long u4 is partial until u5. Accordingly, the long replay passes five of the six frozen semantic controls, not all six. This is a false negative/delayed recognition, rather than the old wrong-experience adoption, but is still a quality limitation.

To investigate that delay, `jev-role-profile-regression-v1.json` freezes the two exact role/profile prefixes. `.local/readme-laya/jev-role-profile-v16-baseline` shows all role facts supported and a valid proof, but one final completeness head at 0.72 below the unchanged 0.75 threshold. A single focused weak-positive completion retry was tried as v17 (`jev-role-profile-v17-run1`); both versions matched only one of two expected immediate answers, with the missed case changing. That experiment did not demonstrate a stable improvement and was removed. Final serving source is exactly the independently reviewed v16, not v17; the unsuccessful experiment remains reproducible.

## Checks and remaining limits

Final deterministic gates: **210 TypeScript tests pass, six DB-dependent tests skipped, 90 Python tests pass**; lint, typecheck, isolated TypeScript build and full format check pass. Final command logs are under `.local/readme-laya/jev-quality-repair-2026-10-05/final-*.log`. Independent final source review ran 56 Python tests plus three adversarial adopted-proof checks; no blocking code finding remains. Earlier runtime review separately passed 19 TypeScript tests. These are correctness checks, not an accuracy estimate.

The eight-case focused set is development data used during improvement. No independent human-labeled set or general accuracy target has passed. Immediate role recognition varies across runs; the first provider outage is unexplained; real-model repair recovery is not yet measured. The latest full HTTP run used v14 and exposed the short-document failure; final v16 evidence must not be mislabeled as fresh HTTP/browser validation. There is no concurrency or queue-wait reduction claim. Public Lab remains undeployed in this task, and the earlier production-path 404 result has not been changed.
