# Sprint 1 Ticket 4 — Review Output Extraction

## What changed
- Added structured job result event (`job:result`) with:
  - `summary`
  - `artifacts[]`
- Extended job snapshots to include `resultSummary` and `artifacts`.
- CodeRabbit worker now writes artifacts per job:
  - `.claudegram/artifacts/jobs/<jobId>/result.json`
  - `.claudegram/artifacts/jobs/<jobId>/summary.md`
- Job cards now include **Show result** when structured output exists.
- `/jobs` now shows a short result summary snippet.

## Why
Lifecycle alone (`queued/start/end`) was not enough. We now persist and surface actionable review output.

## Notes
- Parser is heuristic for now (stdout/stderr pattern extraction).
- Next iteration can replace heuristics with model-assisted parsing for stronger precision.
