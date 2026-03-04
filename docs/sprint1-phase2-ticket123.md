# Sprint 1 — Phase 2 Tickets 1/2/3

Implemented on `feature/portable-jobs-stage01`.

## Ticket 1 — Live Job Card UX controls
- Added Retry action to live job card buttons.
- Existing controls retained: Show logs, Cancel.
- Retry only shown for terminal non-success states (failed/timeout/canceled).

## Ticket 2 — Cancel/Retry actions
- Cancel action already wired via `jobRunner.cancel(jobId)`.
- Added retry action via new `jobRunner.retry(jobId)`.
- Retry re-enqueues original handler/spec with preserved origin.

## Ticket 3 — `/jobs` command list view
- Added new `/jobs` slash command with optional filters:
  - `state`: queued|running|succeeded|failed|canceled|timeout
  - `limit`: 1-25
- Added command handling and command list documentation update.

## Notes
- No service restart executed in this patch.
- Typecheck passes.
