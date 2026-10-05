# README Jev validation · 2026-10-05 KST

## Scope

User authorized long-document quality/latency, concurrent use and operating-path validation. Only synthetic agent-authored inputs were submitted. Source baseline: `codex/readme-laya-runtime` at `f8addbf07d8666ddc986b21a233034746e9fa3f1` plus prior uncommitted Lab work. Production release and frontend PRs were not changed. No real resume, valid production invitation or credential was written to artifacts.

A current source and input snapshot is saved before each model run. These are development probes with provisional expectations, not human-reviewed accuracy estimates. A complete request is a transport result, not a semantic quality pass. Each measured duration is one observation, not a percentile or service promise.

## Existing long regression: completed, semantic gate not passed

Artifact: `.local/readme-laya/jev-integration-long-run2-v11/{freeze,prepared,run,process-memory}.json` and frozen source copies. This uses the existing 44 authored entries parsed into 47 units, fresh Codex criteria, `jev-grounded-v11` and `jev-reader-v3`. It is the internal pipeline runner, not HTTP/browser.

- Whole run: **181.3s**. Preparation 57.7s; reading completed at 117.1s; report 64.2s (rounded from saved artifacts). Jev: 250 calls, 634,817 input and 58,260 output tokens; no omitted proof and no budget failure.
- Sampled peak sum of runner/descendant process RSS: **613.4 MiB**, at one-second intervals. This sum can include shared memory more than once and is not the Mac's total memory peak or an OOM capacity test.
- Role: other-event school work did not answer the visitor-center question. Concrete role resolved at u16, was reopened after withdrawal at u29, and resolved from the new booking-lookup/wayfinding duties at u36. The explicit original role was already present at u14, so immediate resolution at its first appearance was not achieved.
- Final report: correctly identifies actual booking lookup/wayfinding, treats authorship as withdrawn, uses replacement 12→10 rather than obsolete 12→9, and asks for the still-missing comparison periods. Independent review verified all 12 citations.
- **Remaining failure:** basis question still references only u15. Its last feedback asks for the after measurement even though 9 appears at u19 and replacement10 at u41. The final report is current, but the reading feedback remains stale. Merely leaving the question unresolved is not the defect: the generated criterion requires comparison periods that the source does not supply.
- **Presentation weakness:** u20's disclaimer that improvement is a team result gets another role-resolved note although the concrete role comes from earlier u16. The final role is supported, but the displayed new anchor can mislead.

Acceptance was reviewed before looking at the new result: distinguish events and actors, do not resolve with future plans, invalidate genuinely withdrawn proof, adopt the replacement measurement, and do not request values already written. The fixture's seed-based expected states were not blindly reused because serving uses a freshly generated sufficient condition, including comparison periods.

## Queue repair and HTTP probe

Independent review reproduced an implementation defect: with one active and three queued operations, cancelling a queued operation left its closure counted against capacity until the active operation ended. A new request still received `queue_full` despite the cancellation.

`service.ts` now tags queue entries with their abort signal, removes cancelled waiting entries before checking room, and skips them when pumping. An active operation continues occupying its slot until it settles. Regression checks cover both preparation and reading cancellation, replacement admission, the remaining cap, active-abort ownership, and absence of late execution from the cancelled waiting item. No public contract or processing concurrency was changed: one operation runs at a time, four active-plus-waiting operations are accepted.

New explicit opt-in tool: `src/services/readme-lab/tools/jev-http-eval.ts`. It runs compiled real routes/service on a random loopback port with real parser, Jev and Codex. It submits the new 50-body-sentence synthetic Markdown fixture and the previous 13-body-sentence launch fixture as simultaneous users, fills the queue, checks overflow, cancels queued work, admits a replacement, checks cross-session GET/DELETE denial, concurrently duplicates job starts, and polls cursors to completion. Access tokens and synthetic invitation values stay in memory. `transport_passed` is separate from manual semantic review. Model-stage intervals and HTTP durations are recorded.

The first socket attempt, `.local/readme-laya/jev-http-capacity-run1`, failed before Jev inference because the harness attached application/json to an empty DELETE; Fastify correctly rejected it with400. This was a probe error, not evidence of broken service cancellation. The runner now only sends Content-Type when it sends a JSON body. Failed artifacts are preserved. A preparation failure also explicitly keeps the required completed-client assertions false, preventing a false pass from missing job checks.

The new 50-sentence fixture was frozen before inference with six acceptance conditions: immediate personal-role detail, unsupported center satisfaction not answered by another activity, fully specified library12→9 comparison, absolute180 visitors not converted to growth, colleague work not attributed to applicant, and plans/qualifications not counted as achievements. Five heading units are additional. Survey49/54 is re-participation intention, not observed re-participation.

## Completed two-user HTTP run: overall failure

Artifact: `.local/readme-laya/jev-http-capacity-run2/{freeze,run,client-0,client-1,process-memory}.json` and 48 frozen source files. All source hashes match; current service source matches its running snapshot. This is a compiled loopback route/service probe, not a browser or public deployment check.

| Client                         | Preparation and queue                                                           | Reading              | Report             | End-to-end observed result                                        |
| ------------------------------ | ------------------------------------------------------------------------------- | -------------------- | ------------------ | ----------------------------------------------------------------- |
| 50 body sentences + 5 headings | profile82.901s; reading waits behind second profile until155.287s               | 125.701s, all55units | 159.339s, rejected | **Failed: engine_output_invalid; report null at440.842s (7m21s)** |
| 13 body sentences + 8 headings | initial wait83.1s; profile72.137s; reading waits behind first job until440.328s | 13.291s, all21units  | 105.204s           | Completed at559.213s (9m19s)                                      |

The short client's own parse/profile/reading/report time is about190.7s; roughly368.5s is waiting. This is serial scheduling, not two simultaneous model pipelines. The long client's failure correctly releases the active worker, allowing the short client to complete. The short report has seven items and one unresolved satisfaction-basis question; unlike the earlier standalone/browser run, this run did not create the initial personal-role question. Question creation is not repeat-stable across fresh profiles/runs.

Queue capacity, fifth-request rejection, cancelled-slot reuse, no execution of cancelled queued work, cross-owner preparation/job GET and DELETE denial, simultaneous duplicate starts returning one job, ordered unique event cursors, and maximum one active model phase all passed. **Overall transport_passed=false**, because only one of two clients completed. No rate-limited polling or session leakage occurred. Across1026 HTTP requests, sampled response p50 was2ms, p95 was4ms and max18ms; these local timings exclude model completion latency. Sampled descendant RSS sum peaked at493.9MiB, with the same measurement limitations as above.

Jev long-document usage was530calls /1,243,943input /126,764output tokens, with1 omitted proof. That is88.3% of the600call budget on this single50-body-sentence example. Short usage was57calls /122,360input /10,855output, no omitted proof. The long failure occurred in final Codex reporting after reading completed, not because of a Jev request-budget rejection.

Independent semantic review of the long client's partial events found:

- The first center-role question correctly resolves at the next sentenceu4. It is subsequently refreshed four times with another experience's facts: libraryu35 and festivalu41/u43/u44. Its final support is only festivalu44 even though the question belongs to the center experience. This fails the experience boundary.
- Center satisfaction q2 receives a partial update using library measurement sourcesu25–u28. It is not falsely marked fully resolved, but the attached supporting facts concern a different result.
- An unnecessary new role question q3 appears at u22 even though that sentence already attributes booking reception and answer-draft work to the applicant.
- Library basis q4 remains partial and repeats a request for before/after values although u31 already supplies12/9 after the metric/method/period/sample descriptionu25–u30.
- All22 note IDs, spans and prefix ordering are structurally valid. Correct offsets therefore do not establish correct attribution of meaning. Maximum source length is48UTF16 units, far below the400-character envelope.
- The six-citation envelope cannot block a complete basis result here: grounded completion chooses at most four fact sources, and the adapter adds origin/current, at most six total. It can suppress larger partial evidence lists. The observed one omitted proof does not justify attributing q4's missed completion to the envelope without raw model decisions.
- Absolute180 visitors,49/54 intentions and future qualifications were not turned into extra basis questions. Final report-level criteria cannot be evaluated because no report was returned. No whole-document quality pass is claimed.

One structural hypothesis needs a dedicated future test: the grounding implementation selects sources for four fixed basis facts, while the generated sufficient condition can additionally require periods. It may drop a period-containing source from the proposed proof even though the prefix contains it. Raw heads were not recorded in this serving probe, so this is an implementation hypothesis, not the proven cause of q4's abstention.

## Report-only diagnostic: rejection repeats and repair does not change the draft

Artifact: `.local/readme-laya/jev-report-diagnostic-run1/{input,result,source-freeze}.json` and `runner.mjs`. The unchanged compiled Codex reasoner generated a **new** report from the saved synthetic preparation and reconstructed notes, questions and memory. Public transition records retain their extra `seq` metadata; this is not a byte-identical replay of the original model call. The original HTTP run did not retain report drafts/audits, so its precise rejection reason remains unknown.

The diagnostic failed after **300.251s** with `engine_output_invalid` / `grounded_report_verification_failed`. Both report attempts were rejected by the citation-only audit at item indices 0, 1 and 6. The merged second draft is identical to the first, including the rejected items. The repair call first timed out at 120.014s, then completed on the existing retry after 34.001s. The second audit still rejected the same items; no full-source audit was reached and no report was returned.

- **Confirmed citation omissions (item 6):** the observation says the library improvement is a team result and the suggestion refers to the librarian-approved shared notice. Its citations stop at u31. The supporting team/approved-notice statement exists at u33, and the link to the library at u32 or earlier context, but neither appears in this item's evidence. The source supports the claim; the item does not link that support. This item already reaches the schema's eight-quote cap. Repair must replace redundant citations with the required sources, narrow the observation, or split the item; simply appending more quotes would be invalid.
- **Possible audit false rejections (items 0 and 1):** independent review finds item 0's role and procedure summary covered by its u3/u4/u5/u6/u8 citations. Item 1's intended claim about 48 participants and assigned duties appears in u4, though its Korean phrasing is awkward and could be misread as assigning the duties to the participants. The auditor only returns `other` or `actor`, without a specific unsupported phrase. These rejections should be investigated rather than treated as proof of false generated claims or used to justify lowering validation globally.
- **Observed repair failure:** the returned merged draft changes nothing. The code requests edits only for rejected indices and rechecks rejected citation inputs; it caches only previously approved identical citation inputs. Thus the repeated rejection is not explained by reusing a cached failed audit. The saved diagnostic does not retain the raw repair response, so it does not establish why the repair failed to change the draft.

This separates three problems for follow-up: citation selection, audit calibration, and effective bounded repair. A strict rejection avoids displaying an unverified report, but repeatedly returning no result is still a usability failure.

## Checks and remaining work

The queue repair passes205 TypeScript tests with6 DB-dependent skips,78 Python tests, lint, typecheck, isolated build, full format and tracked diff checks. An independent reviewer also ran the reading-cancellation regression. These checks do not override the real inference failures above.

Before an acquaintance release, prioritize:

1. Keep supporting facts and resolution proof bound to the original experience/outcome; allow cross-section links only when the source establishes that they refer to the same experience.
2. Refresh known facts and remaining gaps even when the full sufficient condition cannot yet be confirmed; never continue requesting an already-supplied value as if it were absent.
3. Fix final-report citation selection, investigate audit false rejections, and make rejected-item repair effective; rerun this frozen50-sentence input without weakening source validation just to obtain a report.
4. Address queue waiting using measured bounded scheduling, then repeat the same simultaneous-client scenario. Current two-user timing is too long to promise a quick result.
5. Prepare/review an actual release before testing the real Lab public path. No deployment action was taken by this validation task.

## Public path: not deployed

Read-only route availability and deliberately invalid synthetic invitation probes at 2026-10-04T16:21:56Z returned:

| Request                                 | Status |
| --------------------------------------- | ------ |
| GET api.seojing.com/health              | 200    |
| GET seojing.com/readme/lab              | 404    |
| POST api.seojing.com/readme/lab/session | 404    |
| POST seojing.com/api/readme/lab/session | 404    |

All responses carry Cloudflare headers. This establishes that the existing API is reachable and the Lab entry points are absent; it does not verify the Lab's Cloudflare→Tunnel→Mac mini workflow. No valid public session was created and no production configuration was modified. Artifact: `.local/readme-laya/jev-public-path-validation-2026-10-05.json`.
