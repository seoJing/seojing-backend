# Posting-grounded sequential reader

Codex creates a reader profile from the complete posting before receiving the resume. Jev then sees only the prefix through the current unit. Codex writes the final report from the complete document and reading history, with exact-citation and semantic checks.

The profile can ask about role, method, result, and applicable measurement/comparison claims. Checks are conditional on the posting and the applicant's claim. A qualitative outcome or a stated plan can count where the posting calls for it; numbers, technical vocabulary, leadership, and complete ownership are not universal requirements. `ReaderCheck.question` is optional for existing profiles and required when generating new profiles.

Reading produces both questions and posting-linked explanations. A positive note connects a written explanation to a criterion; it does not certify competence or predict a recruiter's private thoughts. Questions are not created to fill a quota. Silence can mean no applicable candidate, abstention, or a bounded note limit.

Standalone evidence corrections are append-only observations with `retracted_note_id`. The original note stays in history; the client excludes it from current evidence counts once playback reaches the correction. Reports receive the same withdrawal ledger and cannot cite a withdrawn note as current support. Withdrawal requires an accepted full-prefix invalidation decision and an accepted later correction source; a merely related sentence or a correction to a separate experience does not suffice.

Source proofs remain exact and bounded. Method/result checks preserve distributed supporting sentences instead of reducing a multi-part explanation to a single sentence. Uncertain experience links still abstain. The `.75` decision threshold is an uncalibrated policy, not a claimed accuracy or hiring probability.

`README reading summary` logs contain only fixed fields: opaque job ID, phase/status, counts, durations, fixed error codes, token/call metrics, and decision counters. Source text, filenames, model prose, and credentials are not included. The pipeline's optional diagnostics are internal; existing public event shapes remain compatible.

## Verification

- `pnpm test`, `pnpm build`, `pnpm lint`
- `python3 -m unittest discover -s test -p 'readme_jev*test.py'`
- All Python regressions additionally require the existing Laya/Torch environment: `.local/readme-laya/venv/bin/python -m unittest discover -s test -p 'readme_*test.py'`
- Synthetic fixtures live under `test/fixtures/readme/jev-occupations*`, `jev-occupation-boundaries-v1.json`, and `jev-evidence*`. Expected outcomes must never enter model inputs. These small, development-used cases do not establish accuracy on real resumes or all occupations.

The frontend consumer maintains replay-specific evidence history, requirement links, and mobile detail state. Its regression tests exercise the served HTML's actual state functions. Keep interface changes coordinated on the shared README board.
