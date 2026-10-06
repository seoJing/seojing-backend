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

## Action-oriented final report

New grounded reports select at most five useful editing directions, including at most two representative explanations to preserve. These are upper bounds, not quotas. The writer groups notes that lead to the same editing action and prioritizes ambiguities affecting the posting's core work, responsibility boundaries, and unsupported claims. Each open/improve item must supply a concrete suggestion; the existing full-source audit also checks whether the action is specific, feasible, and avoids asking for information already present. A later explanation can be moved or linked closer to an earlier claim. Missing facts must not become invented achievements or compulsory numeric results.

The public ReportItem contract is unchanged: text carries the grounded observation/gap, reason carries the suggested action, and citations/note_ids retain their evidence links. Initial synthesis selects and groups directions; targeted repairs still cannot rewrite approved siblings or delete partially overlapping items with unique facts. Revision-plan limits are rechecked after repairs. Citation checks and the complete-source semantic audit remain mandatory for nonempty output; this adds no separate model-call stage.

The client shows “먼저 고칠 부분” before “고칠 때 유지할 설명”. Historical questions and per-requirement evidence remain available behind “판단 근거와 읽기 기록”, closed initially. Opening a source and returning preserves the disclosure and focused control. Old stored reports are not truncated to the new generation limit. An empty revision section does not assert a perfect document or complete qualifications.

### Report-only development checks, 2026-10-06 KST

Five synthetic cases received fresh actual Codex CLI reports. Four reused the complete v9 reading artifacts above; the claim-gap case used a new synthetic document, a cached operations posting profile, and no reading notes. No reader calls or real applicant documents were used in this report-only evaluation.

| Case                            | Report time | Items | Observed result                                                                                                                        |
| ------------------------------- | ----------: | ----: | -------------------------------------------------------------------------------------------------------------------------------------- |
| Operations                      |      28.0 s |     2 | Preserved concrete coordination actions and the decision-maker boundary; no forced revision.                                           |
| Content                         |      32.6 s |     2 | Suggested merging the colleague-attributed sentences and placing the applicant's FAQ work next to them; preserved that work.           |
| Customer support                |      34.6 s |     2 | Preserved response-priority and situation-specific guidance; the partial reading question stayed historical.                           |
| Customer support, 42 units      |      33.0 s |     2 | Selected representative handling/hand-off explanations instead of enumerating all memo observations.                                   |
| Unsupported role/outcome claims |      32.3 s |     2 | Narrowed “overall leadership” to the stated responsibilities and removed the unsupported satisfaction claim without inventing metrics. |

Each completed through four CLI calls and no repair request. These are single development runs, not a reliability rate, a coverage benchmark, or a paired speed comparison with earlier reader versions. The reader's v9 recall/cap limits above remain unchanged. Prior report failures remain part of the historical evidence.

Restricted local evidence: `.local/readme-lab-production/revision-report-v1/` contains the report harness, explicit cached-input provenance, output and source hashes, and local desktop/mobile UI captures. Browser checks replayed these synthetic results and verified closed-history defaults, source navigation, return focus, and 390px layout without horizontal overflow. Implementation, independent review, and production release status are recorded separately on the board.

## Public good-writing evaluation corpus

Three publicly published Korean application essays were selected at the user's request: LG Electronics HR internship (2019 first half), Robert Bosch Korea logistics/SCM internship (2019 second half), and SK hynix Device process development (2017 second half). JobKorea's expert overall score of 5 was the selection rationale, not ground truth that every sentence is complete. The source page categorizes the Bosch case as new-hire materials management and the Hynix case as quality management; the evaluation role labels follow the original internship questions and stated Device process-development application respectively.

`test/fixtures/readme/public-good-writing-v1.json` records source URLs, source/input hashes, extraction details, and source-question counts. The `expected_questions` field means original application questions (2/3/4), not an expected count of generated reader questions. After removing editorial labels and the site's character-count UI, the three documents contain 28/32/48 reading units, including question headings, and 1,462/1,545/2,710 answer characters. All nine answers are retained without rewriting, translating or truncation.

Historic job advertisements were not available. Each posting input is explicitly labeled as an evaluation brief reconstructed from the published role and original application questions. This limits job-fit conclusions and can create broader reading criteria than a normal job advertisement. Expert comments, grades, selection rationale and author-profile sidebars are excluded from model input. The examples are for local evaluation only: they are not fine-tuning records, prompt demonstrations, or public contest exhibits. Public examples may already be familiar to the underlying models; three selected positive examples cannot establish general accuracy.

Full source texts, locally generated TXT inputs, reconstructed briefs, and model outputs stay in the restricted ignored `.local/readme-lab-production/public-good-writing-v1/` directory. An independent extraction review caught nine site character-count entries in the initial documents. That invalid attempt, including two posting-profile semantic failures and one interrupted run, is preserved under `attempt-1-contaminated/`; it is excluded from reading-quality measurements. The cleaned inputs remove only the `txSpllChk` UI nodes in addition to editorial `sup` labels. Runtime prompts, models and thresholds are unchanged for this evaluation.

### Actual provider runs, 2026-10-06 KST

The clean cases used fresh Codex posting profiles, the default real Jev reader, and fresh Codex reports in sequence. No report stubs or cached profiles were used. Execution used runtime commit `85c11af784d6dd4caa33a6564708b8dd982e0ea1`; source hashes and complete eligible/failed artifacts are under `clean-v1/`, with one unchanged-input Bosch retry under `clean-v1-retry/`.

| Case                      | Units |                                Posting profile | Reading |  Report |    End-to-end | Notes / questions | Final report                                           |
| ------------------------- | ----: | ---------------------------------------------: | ------: | ------: | ------------: | ----------------- | ------------------------------------------------------ |
| LG HR intern              |    28 |                                         42.0 s |  35.1 s |  60.2 s |       137.5 s | 1 / 1 open        | 2 revisions, 1 explanation to preserve                 |
| Bosch logistics intern    |    32 | Failed after 34.8 s; retry failed after 30.1 s | Not run | Not run | Not completed | Not assessed      | Not generated                                          |
| Hynix process development |    48 |                                         51.3 s |  73.3 s | 100.8 s |       225.4 s | 4 / 1 partial     | 2 revisions (one optional), 2 explanations to preserve |

Notes include question/progression cards: LG produced no standalone positive note; Hynix produced two. End-to-end includes posting preparation but excludes source extraction and UI replay. LG reporting made five CLI calls with no rejected draft. Hynix reporting made nine calls and one semantic rejection followed by repair. The stored audit marks the rejected item as unsupported with issue `other`; its more specific internal reason was not recorded. The final item acknowledges the existing experimental effort and makes additional details optional.

Independent review verified all 33 final-report citations and their note/requirement references in the two completed cases. The reports preserve study versus planned qualification, individual versus team contribution, and actual achievements. Some editing judgments are stricter than the publisher's assessment: LG's indirect academic evidence is recognized but an applied-analysis example is suggested; Hynix's goal-setting background is present, while why the goal was personally difficult could be clearer. These are review judgments, not objective proof of a defective essay.

The positive examples expose remaining reader limits. LG's question bundles motivation, strengths and weaknesses. Later passages explain motivation, preparation and remedial study, yet no partial evidence is registered and the question ends open. Complete resolution is debatable because the application example for the claimed strength is limited, but ignoring all later progress is not justified. Hynix captures safety-improvement actions under one criterion while omitting standalone positive notes on research achievement, specialist effort and teamwork; neither the memo cap nor proof omission caused that selection pattern. Exact internal causes were not traced in this evaluation.

Bosch failed before applicant reading on both clean attempts. Extraction classified the essay prompts as `other` submission instructions; the separate audit treated them as content requirements under the reconstructed brief's qualification heading. This is an input-scope/classification conflict, not evidence of poor applicant writing or of Jev failing to understand it. There are only two completed reading/report evaluations. Results must not be described as three successful end-to-end runs or generalized to real-posting reliability.

The manifest and this record are the only tracked additions; full essays and model artifacts remain local. `summary.json`, `protocol.json`, and `extraction-check.json` in the restricted evidence directory record aggregates, retry scope and normalization checks. This adds evaluation material and findings only; it does not fix the observed runtime limits or change production.
