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

## Development evidence, 2026-10-06 KST

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
