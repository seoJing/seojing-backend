# Posting-grounded sequential reader

Codex creates a reader profile from the complete posting before receiving the resume. Jev then sees only the prefix through the current unit. Codex writes the final report from the complete document and reading history, with exact-citation and semantic checks.

The profile can ask about role, method, result, and applicable measurement/comparison claims. Checks are conditional on the posting and the applicant's claim. A qualitative outcome or a stated plan can count where the posting calls for it; numbers, technical vocabulary, leadership, and complete ownership are not universal requirements. `ReaderCheck.question` is optional for existing profiles and required when generating new profiles.

Reading produces both questions and posting-linked explanations. A positive note connects a written explanation to a criterion; it does not certify competence or predict a recruiter's private thoughts. Questions are not created to fill a quota. Silence can mean no applicable candidate, abstention, or a bounded note limit.

Standalone evidence corrections are append-only observations with `retracted_note_id`. The original note stays in history; the client excludes it from current evidence counts once playback reaches the correction. Reports receive the same withdrawal ledger and cannot cite a withdrawn note as current support. Withdrawal requires an accepted full-prefix invalidation decision and an accepted later correction source; a merely related sentence or a correction to a separate experience does not suffice.

Report generation and repair use document-specific reference enums. The model can select only existing units, active notes, and evaluative requirement IDs. `other` items remain in the input as interpretation context (for example, “numeric results are not mandatory”), but cannot become an assessed requirement. Exact quotations, note-to-source links, duplicate/reference checks, citation support, and full-source semantic review still run after generation.

Source proofs remain exact and bounded. Method/result checks preserve distributed supporting sentences instead of reducing a multi-part explanation to a single sentence. Uncertain experience links still abstain. The `.75` decision threshold is an uncalibrated policy, not a claimed accuracy or hiring probability.

`README reading summary` logs contain only fixed fields: opaque job ID, phase/status, counts, durations, fixed error codes, token/call metrics, and decision counters. Source text, filenames, model prose, and credentials are not included. The pipeline's optional diagnostics are internal; existing public event shapes remain compatible.

## Verification

- `pnpm test`, `pnpm build`, `pnpm lint`
- `python3 -m unittest discover -s test -p 'readme_jev*test.py'`
- All Python regressions additionally require the existing Laya/Torch environment: `.local/readme-laya/venv/bin/python -m unittest discover -s test -p 'readme_*test.py'`
- Synthetic fixtures live under `test/fixtures/readme/jev-occupations*`, `jev-occupation-boundaries-v1.json`, and `jev-evidence*`. Expected outcomes must never enter model inputs. These small, development-used cases do not establish accuracy on real resumes or all occupations.

The frontend consumer maintains replay-specific evidence history, requirement links, and mobile detail state. Its regression tests exercise the served HTML's actual state functions. Keep interface changes coordinated on the shared README board.

## Reader v8 development evidence, 2026-10-06 KST

Synthetic, development-used fixtures exercised four occupations with actual Jev reading and Codex reports. The final reader replay produced:

| Case               | Units | Questions | Notes | Observed behavior                                               |
| ------------------ | ----: | --------: | ----: | --------------------------------------------------------------- |
| Development        |     6 |         2 |     6 | Later explanations resolved both questions.                     |
| Customer support   |     5 |         1 |     2 | A later explanation resolved the question.                      |
| Program operations |     5 |         0 |     2 | Posting-linked explanations remained visible without questions. |
| Content            |     6 |         0 |     1 | The FAQ example produced a posting-linked explanation.          |

These are case observations, not an accuracy estimate. Four final reader replays reused previously generated real Codex reports only after complete `reportInput` equality; their elapsed times are **not** fresh end-to-end report measurements. A subsequent fresh operations read/report with bounded reference schemas took 42.2 seconds, excluding preparation of the cached validated posting profile.

The subsequent 42-unit customer-support run also generated a fresh report: 30.4 seconds reading plus 131.0 seconds reporting, 161.4 seconds total excluding posting preparation. It produced one reading note, no questions, and 12 report items through 14 Codex calls, without a repair request. This is a successful single run, not a measured reliability rate or a guarantee for all 40-line resumes.

The actual authorship-correction case withdrew the old note, and a separately generated Codex report preserved the correction without citing the retired note. Six controlled prior-note tests distinguished corrections from unrelated dates, compatible refinements, separate activities, and a later clarification. The last case checks current note validity; it does not establish automatic restoration of a previously withdrawn note.

Known limits: the implicit continuity case in `jev-occupation-boundaries-v1.json` still abstains when method evidence spans several sentences without an explicit task link. Long-report runs have also included a semantic rejection and a generic CLI output failure as well as separate successful regenerations. The observed invalid `other` reference was fixed at the generation boundary; this does not establish the cause or resolution of the separate CLI failure. Do not describe successful reruns as proof that earlier failures disappeared. No real applicant document was reused for these evaluations.

Reproducible local evidence lives in the ignored, restricted-permission `.local/readme-lab-production/occupations-v1/` directory: versioned source hashes, separate failed/successful runs, actual reports, and synthetic desktop/mobile replay screenshots. Production logs retain aggregate counters only. The task board records independent review, exact commits, gates, and release status; these implementation results alone are not deployment evidence.

## Reader v9 memo progression

Standalone notes now distinguish described experience, personal work, approach, observed response, responsibility boundaries, and explicit plans. These are source-reading labels, not qualification grades. The current quotation and posting criterion remain visible. Routing prefers a more specific category among accepted labels within 0.1 of the strongest score; this only selects wording. Final factual and relevance decisions still require the existing 0.75 threshold.

Question sufficiency checks do not enter the memo relevance input. A memo can explain one aspect of a criterion without answering every question about it. Novelty is compared against an explicit ledger of previously displayed notes and their source passages; simply appearing earlier in the document does not make a fact already conveyed by a note.

An optional earlier context and one prior note anchor may join the current source, for at most three exact passages. Prior interpretations are never factual proof, and a previous note's full proof is not recursively inherited. Context and same-experience clarification receive separate final audits. The contradiction audit checks both the proposed wording and the actual quoted claims as currently valid support. An uncertain or contradicted proposal is omitted. Question updates and withdrawals still take precedence, and the standalone-note cap remains 12.

The client shows these passages under “함께 읽은 원문” in desktop details and mobile inline notes. Source buttons preserve document order, remove duplicates and unavailable/future references, and move keyboard focus even to a passage with no memo of its own. Existing public note/event fields and visual styling are unchanged.

### Measured development cases, 2026-10-06 KST

The final-v4 run used real Jev calls with cached validated posting profiles. Its report functions were explicitly replaced by a reading-only stub; operations and content subsequently received fresh, actual Codex CLI reports.

| Case                   | Units | Questions | Notes | Reading time |
| ---------------------- | ----: | --------: | ----: | -----------: |
| Development            |     6 |         2 |     6 |        7.2 s |
| Customer support       |     5 |         1 |     4 |        5.5 s |
| Program operations     |     5 |         0 |     3 |        5.4 s |
| Content                |     6 |         0 |     3 |        5.0 s |
| Customer support, long |    42 |         0 |    12 |       38.7 s |

The two development questions resolved. The customer-support question finished partial in this run, although earlier runs resolved it; useful source explanations can still fail the uncalibrated confidence gate. Operations retained three explanations (versus two in v8); the separately linked responsibility-boundary card seen in earlier development runs was omitted in this final run. This variation must not be described as consistently complete understanding.

The content case exposed a blocking defect in an earlier candidate: a generic method note survived a later correction assigning its supporting work to a colleague. Retraction checks now receive the original note's exact source ledger and separately confirm the later correction. The final run withdrew that note at the correction sentence and retained the applicant's separate FAQ work. Six real-Jev controlled prior-note cases matched their expected correction/non-correction outcomes, including compatible detail, separate experience and a subsequently reinstated claim; these controls are not full-pipeline accuracy measurements.

The long case increased from one to 12 notes and reached the cap at u25; 17 later steps did not evaluate new standalone explanations. Eleven notes address the same criterion. Its 153 calls consumed 761,720 input tokens versus the earlier run's 126 calls and 384,414 tokens. More notes do not establish balanced coverage or greater usefulness. A stricter novelty experiment suppressed useful operations details and was not adopted.

Fresh actual Codex CLI reports produced three operations items in 41.2 seconds and two content items in 32.2 seconds, with no repair requests. The content report used the correction and subsequent FAQ evidence, not the retired note as current support. The posting profiles were cached, and the report calls were measured separately from reading. Long-document reporting was not rerun for v9. Earlier final-v1/v2 report reuse experiments are retained as separate artifacts and are not the final-v4 measurements.

The new `jev-memo-transitions-v1.json` fixtures also expose remaining recall limits: `memo_progression` produced only one note, and `memo_correction` withdrew the original authorship note but omitted the later independent role explanation. Another actor's work and unrelated/instruction-like content produced no applicant-achievement notes. These are small development-used cases, not held-out accuracy measurements or an all-pass semantic benchmark. Category wording can still be repetitive, and this change does not establish an actual recruiter's thoughts.

Restricted local artifacts: `.local/readme-lab-production/memos-v2/final-v4/` contains source hashes, real reading outputs, usage/counters, and the two actual reports. `retraction-controls.json` records the controlled cases. Earlier attempts and failures are retained separately; final-v3 is explicitly marked unsuitable as frozen release evidence. UI screenshots use a clearly labeled synthetic replay fixture, not a real applicant document or model-quality measurement. Source text remains absent from production aggregate diagnostics. The board records review and deployment status separately.
