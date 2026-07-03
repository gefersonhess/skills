# Resumable Implementation Pipelines

## Purpose

Make `skills/implementation-pipeline/pipeline.sh` safely resumable after a user-requested pause.

The first version must support resuming from explicit safe checkpoints only. It must not infer state
from logs, continue arbitrary half-finished agent work, or destroy existing branches/PRs while trying
to recover.

## Current problems

The current pipeline can be paused only while the original process remains alive. It is not safe to
restart from `status.json` because the script:

- initializes `ISSUES_COMPLETED=()`, `ISSUES_SKIPPED=()`, and `ISSUES_REMAINING=("${ISSUES[@]}")` on startup;
- never reads previous `status.json`;
- overwrites status on startup;
- shifts `ISSUES_REMAINING` destructively instead of using a durable cursor;
- treats an existing PR for the branch as a blocker even if that PR was created by the same pipeline;
- can reset an existing worktree to `origin/$BASE_BRANCH` when no PR is found;
- does not encode a resumable checkpoint or config hash;
- cannot distinguish user-paused state from crash recovery.

## Design constraints

- Resume support is checkpoint-based, not arbitrary crash recovery.
- `status.json` is the source of truth for resume metadata.
- Logs are diagnostic only; never parse logs to infer resume state.
- Resume must be idempotent: re-running resume at the same checkpoint must not duplicate completed work.
- Resume must be conservative: refuse when state is ambiguous.
- Existing v1 status files are monitor-only and not resumable.
- Extension UX may help start resume, but script-level support owns correctness.

## Non-goals for first version

Do not support:

- resuming from the middle of an implementation/review/bot-review agent run;
- resuming arbitrary crashed pipelines;
- automatically adopting open PRs unless the checkpoint explicitly records that PR as owned by the pipeline;
- guessing completed/skipped issues from GitHub issue or PR state;
- changing merge strategy or config values during resume.

## Safe checkpoint model

Initial supported checkpoint:

```text
between-issues
```

Meaning:

- no child agent is running;
- no merge is in progress;
- no current issue is partially active;
- completed/skipped issue lists are already persisted;
- the next issue is identified by durable cursor;
- the repo lock is either held by the paused process or reclaimable if that paused process died.

Future checkpoints, out of scope for the first pass:

```text
after-pr-opened
after-self-review
after-bot-review
```

## Status schema v2

Extend `status.json` to schema v2 while preserving existing v1 fields used by the TUI extension.

New fields:

```json
{
  "schema_version": 2,
  "pipeline_state": "running|paused|completed|blocked|aborted|killed",
  "checkpoint": "between-issues",
  "resume_supported": true,
  "resume_from_status": "/tmp/.../status.json",
  "script_file": "/path/to/skills/implementation-pipeline/pipeline.sh",
  "config_sha256": "...",
  "script_version": "1.1.0",
  "next_issue_index": 3,
  "current_issue_index": null,
  "next_issue": 488,
  "paused_at": "2026-06-30T00:00:00Z",
  "paused_reason": "user-requested"
}
```

Continue writing existing fields:

```json
{
  "current_issue": null,
  "current_phase": "paused",
  "current_agent_pid": null,
  "current_pr": null,
  "issues_total": [485, 416, 486],
  "issues_completed": [485],
  "issues_completed_details": [
    {"issue": 485, "pr": 42, "started_at": "2026-06-01T10:00:00Z",
     "completed_at": "2026-06-01T10:35:00Z", "duration_seconds": 2100}
  ],
  "issues_skipped": [],
  "issues_remaining": [416, 486]
}
```

## State refactor

Replace destructive queue shifting with cursor state.

Current unsafe pattern:

```bash
ISSUES_REMAINING=("${ISSUES_REMAINING[@]:1}")
```

Target model:

```bash
NEXT_ISSUE_INDEX=0
CURRENT_ISSUE_INDEX=""
```

Derived values:

- current issue: `ISSUES[CURRENT_ISSUE_INDEX]` when active;
- next issue: `ISSUES[NEXT_ISSUE_INDEX]` when paused/between issues;
- remaining issues: `ISSUES[NEXT_ISSUE_INDEX:]` plus active issue when appropriate.

Advance `NEXT_ISSUE_INDEX` only after the pipeline commits to starting an issue or after a terminal
per-issue outcome is durably recorded. Be explicit in code comments about the chosen invariant.

## Pause behavior

When `pause` is consumed at a safe boundary:

1. Set state:

   ```bash
   PIPELINE_STATE="paused"
   CHECKPOINT="between-issues"
   CURRENT_ISSUE=""
   CURRENT_ISSUE_INDEX=""
   CURRENT_AGENT_PID=""
   CURRENT_PHASE="paused"
   PAUSED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
   PAUSED_REASON="user-requested"
   ```

2. Write status atomically.
3. Log the checkpoint:

   ```text
   PAUSED at checkpoint between-issues. Next issue: #488.
   ```

4. Wait for `resume` or `abort` in the control file.
5. If the process receives `TERM` while paused, preserve `pipeline_state=paused`, release the repo
   lock, and exit cleanly. Do not overwrite status as `killed` for intentional shutdown while paused.

## Resume entrypoint

Add a script-level resume command:

```bash
pipeline.sh --resume /tmp/.../status.json
```

Resume flow:

1. Read `status.json` with `jq`.
2. Verify:
   - `schema_version == 2`;
   - `pipeline_state == paused`;
   - `resume_supported == true`;
   - `checkpoint == between-issues`;
   - `current_agent_pid` is null/empty/dead;
   - `config_file` exists;
   - `config_sha256` matches the current config file;
   - script version is compatible.
3. Source the recorded `config_file`.
4. Reconstruct:
   - `ISSUES_COMPLETED` (from `issues_completed` array, CSV);
   - `ISSUES_COMPLETED_DETAILS` (from `issues_completed_details` — valid compact object lines only;
     non-object elements, records with non-numeric `.issue`, stale issues not in `issues_completed`,
     and duplicate issue records after the first are silently filtered;
     missing/null/non-array details are treated as empty and never block resume);
   - `ISSUES_SKIPPED`;
   - `NEXT_ISSUE_INDEX`;
   - terminal/current fields.
5. Re-acquire the repo lock.
6. Write status as `running` with the restored cursor.
7. Continue the main loop from `NEXT_ISSUE_INDEX`.

If any verification fails, write `pipeline_state=blocked` with a resume error and exit non-zero.
Do not guess.

### Blocked-state mutation contract for `--resume`

`--resume` writes `pipeline_state=blocked` and a bounded `resume_error` (max 512 chars) to the
path supplied as the CLI argument in these three cases:

| Failure point | Condition |
| --- | --- |
| Validation failure | `validate_resume_status` returns non-zero for a schema v2 file |
| Missing log_dir | `log_dir` field is absent/null, or the referenced directory does not exist |
| Lock acquisition failure | `acquire_repo_lock_for_resume` returns non-zero |

The write is atomic (sibling tmp file + `mv`) and preserves all other status fields.

**Guard rails — no write occurs when:**
- The argument path does not exist.
- The file is not valid JSON.
- `.schema_version != 2` — schema v1 and missing-schema files are left unchanged.

`validate_resume_status` itself remains **pure and non-mutating**; it never writes to any file.
Successful resume writes a fresh `running` status via `write_status`, which omits `resume_error`.

## Repo lock behavior

Resume must handle locks conservatively:

| Situation | Behavior |
| --- | --- |
| paused process alive | `/pipeline-resume` writes `resume` to the existing control file. |
| paused process dead | `pipeline.sh --resume <status>` may reclaim the repo lock. |
| running process alive | refuse a second resume/start. |
| status says running but PID dead | refuse; this is crash recovery, not pause resume. |
| lock exists but status is paused and PID dead | reclaim after verifying lock repo and pipeline id match. |

Lock metadata should include enough information to verify ownership:

```json
{
  "pipeline_id": "...",
  "pid": 12345,
  "repo": "/canonical/repo/path",
  "status_file": "/tmp/.../status.json",
  "state": "running|paused"
}
```

## Extension behavior

Update `extensions/pipeline-status.ts` after script support exists.

`/pipeline-resume <id>` behavior:

1. Read registry entry and status file.
2. If `pipeline_state=paused` and PID is alive:
   - write `resume` to `control_file`.
3. If `pipeline_state=paused` and PID is dead:
   - if `script_file` exists, launch:

     ```bash
     tmux new-session -d -s "resume-<pipeline-id>" \
       "'<script_file>' --resume '<status_file>'; exec bash"
     ```

   - otherwise show a manual resume command and refuse automatic start.
4. If not paused, show a clear message:
   - running: already running;
   - blocked/killed: resume unsupported; manual recovery required;
   - completed/aborted: terminal state.

The extension should not infer or repair pipeline state.

## Documentation updates

Update:

- `skills/implementation-pipeline/references/monitoring-and-steering.md`
- `skills/implementation-pipeline/references/pipeline-config-format.md`
- `README.md`

Document:

- pause is checkpoint-based and may wait for the current phase to finish;
- resume is supported only from `paused` state with schema v2;
- v1 status files are monitor-only;
- killed/crashed running pipelines require manual recovery;
- `/pipeline-resume` chooses control-file resume or restart-from-status based on PID liveness.

## Test plan

Add shell-level smoke tests using temporary repos and fake `gh`/`pi` binaries.

Required cases:

1. Pause before first issue writes `pipeline_state=paused`, `checkpoint=between-issues`, and `next_issue_index=0`.
2. Resume a live paused process by writing `resume` to control.
3. Kill a paused process, then `pipeline.sh --resume status.json` continues at the same `next_issue_index`.
4. Completed issue remains completed after resume and is not rerun.
5. Skipped issue remains skipped after resume and is not rerun.
6. Resume refuses config hash mismatch.
7. Resume refuses `pipeline_state=running` with dead PID.
8. Resume refuses unsupported checkpoint.
9. Resume does not `git reset --hard` an existing worktree unless entering a fresh issue setup checkpoint.
10. Extension renders paused state and chooses control-file vs restart behavior correctly.

## Implementation phases

### Phase 1: Cursor and status groundwork

- Add `NEXT_ISSUE_INDEX` / `CURRENT_ISSUE_INDEX`.
- Derive `issues_remaining` from cursor.
- Add schema v2 fields while preserving v1 fields.
- Add config hash and script path.
- Keep runtime behavior otherwise unchanged.

### Phase 2: Durable pause

- Convert pause handling into a durable paused state.
- Preserve paused status on intentional termination while paused.
- Add lock metadata for paused/running distinction.

### Phase 3: Resume entrypoint

- Add `pipeline.sh --resume <status.json>`.
- Validate status/config/lock ownership.
- Restore arrays and cursor from status.
- Continue from `NEXT_ISSUE_INDEX`.

### Phase 4: Extension integration

- Render `paused` as a first-class state.
- Make `/pipeline-resume` restart a dead paused process when safe.
- Refuse automatic resume for unsupported states.

### Phase 5: Docs and release

- Update docs and README.
- Run validation.
- Tag a release after the feature is proven.

## Acceptance criteria

- A user can pause at a safe checkpoint, terminate the paused process, and resume later without rerunning completed issues.
- Resume refuses ambiguous or unsafe states with actionable errors.
- Existing monitoring/steering commands still work for running pipelines.
- The pipeline-status extension remains compatible with schema v1 and supports schema v2 paused/resume metadata.
- Tests cover successful resume and refusal paths.
