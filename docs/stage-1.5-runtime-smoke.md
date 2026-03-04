## Stage 1.5 Runtime Smoke (post-restart)

Run from repo root:

```bash
npm run -s smoke:jobs
```

Optional:

```bash
npm run -s smoke:jobs -- --minutes=60
npm run -s smoke:jobs -- --job-id=<JOB_ID>
```

### What it checks
- recent job lifecycle health (`queued -> start -> end`)
- terminal state visibility
- provider diagnostic event presence (`[provider:*]`)
- quick log tail probe for watchdog/stall signals

### Exit codes
- `0` PASS
- `1` FAIL (missing lifecycle transitions in window)

### If FAIL
1. Inspect `.claudegram/jobs/jobs.jsonl`
2. Run `/devops status job_id:<id>` in Discord
3. Check `logs/discord.prod.log` for provider/send errors
4. Verify service restarted on latest branch/commit
