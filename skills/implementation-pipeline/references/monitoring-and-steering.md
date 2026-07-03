# Monitoring and Steering

This file defines how the invoking session monitors pipeline progress and steers execution.
The invoking session is the pi/agent that spawned the tmux pipeline — or the user themselves.

---

## Status File (machine-readable)

The pipeline writes `$LOG_DIR/status.json` at every phase transition.

**`status.json` is the source of truth** for phase, issue, PR, and terminal state. The extension
must not infer state from logs or GitHub API calls — it reads `status.json` directly.

### Schema v2 example (paused at checkpoint)

```json
{
  "schema_version": 2,
  "pipeline_state": "paused",
  "resume_supported": true,
  "checkpoint": "between-issues",
  "script_file": "/home/ubuntu/repos/skills/skills/implementation-pipeline/pipeline.sh",
  "script_version": "1.1.0",
  "config_sha256": "e3b0c44298fc1c149afb",
  "current_issue_index": null,
  "next_issue_index": 2,
  "next_issue": 275,
  "paused_at": "2026-06-25T01:50:00Z",
  "paused_reason": "user-requested",
  "started_at": "2026-06-25T01:01:02Z",
  "current_issue": null,
  "current_phase": "paused",
  "current_phase_started_at": null,
  "current_issue_started_at": "",
  "current_issue_elapsed_seconds": null,
  "current_agent_pid": null,
  "current_pr": null,
  "issues_completed": [273, 274],
  "issues_completed_details": [
    {
      "issue": 273,
      "pr": 280,
      "started_at": "2026-06-25T01:01:02Z",
      "completed_at": "2026-06-25T01:09:50Z",
      "duration_seconds": 528
    },
    {
      "issue": 274,
      "pr": 281,
      "started_at": "2026-06-25T01:38:22Z",
      "completed_at": "2026-06-25T01:50:00Z",
      "duration_seconds": 698
    }
  ],
  "issues_skipped": [],
  "issues_remaining": [275, 276, 277],
  "last_update": "2026-06-25T01:50:00Z"
}
```

**v2 fields added at `between-issues` checkpoint:**

| Field | Description |
|-------|-------------|
| `schema_version` | `2` for checkpoint-capable pipelines; absent or `1` for older runs |
| `resume_supported` | `true` when a dead-process restart via `pipeline.sh --resume` is safe |
| `checkpoint` | Current safe point; `"between-issues"` is the only supported restart checkpoint |
| `script_file` | Absolute path to the pipeline script used for a restart |
| `script_version` | Script version that wrote the status; useful for diagnostics during resume refusal |
| `config_sha256` | SHA-256 of the original config file; `pipeline.sh --resume` validates this |
| `current_issue_index` | 0-based index of the active issue; `null` while paused between issues |
| `next_issue_index` | 0-based index of the issue to run next on resume |
| `next_issue` | Issue number to run next |
| `paused_at` | ISO timestamp when the durable paused state was written |
| `paused_reason` | Why the pause occurred (currently `"user-requested"`) |

All v1 fields (`started_at`, `current_issue`, `current_phase`, `issues_completed`, `issues_remaining`, etc.) are preserved in v2.

Terminal states for `pipeline_state`: `"completed"`, `"blocked"`, `"aborted"`, `"killed"`. `"paused"` is a durable non-terminal state: the pipeline is waiting at a safe checkpoint for `resume` or `abort`.

> **Blocked pipelines and `resume_error`:** When `pipeline.sh --resume` fails against a schema v2
> status file, it patches `pipeline_state=blocked` and a bounded `resume_error` field into the
> status file.  The stored `resume_error` value is capped at **512 chars**.  The `pipeline-status`
> below-editor widget surfaces this as a dim sub-line for pipelines in the `blocked` state
> (e.g. `resume error: config hash mismatch`): the displayed excerpt is a sanitized single line
> capped at **160 chars**, separate from the 512-char stored bound.  This helps the user diagnose
> why a resume attempt failed without inspecting the status file directly.

## Active Registry

The pipeline also writes a stable registry entry for UI extensions and other monitors:

```text
${PIPELINE_REGISTRY_ROOT:-/tmp/pi-pipeline-status/active}/<pipeline-id>.json
```

The registry entry points to the authoritative status/control artifacts:

```json
{
  "schema_version": 1,
  "id": "impl-pipeline-service-insights-20260630T000000Z",
  "repo": "/home/ubuntu/repos/service-insights",
  "repo_name": "service-insights",
  "pid": 12345,
  "config_file": "/tmp/impl-pipeline-service-insights/config.sh",
  "log_dir": "/tmp/impl-pipeline-service-insights",
  "status_file": "/tmp/impl-pipeline-service-insights/status.json",
  "log_file": "/tmp/impl-pipeline-service-insights/loop.log",
  "control_file": "/tmp/impl-pipeline-service-insights/control",
  "started_at": "2026-06-25T01:01:02Z",
  "last_update": "2026-06-25T01:01:02Z"
}
```

Registry entries are intentionally left in place after terminal states so the pi status extension
can keep completed or blocked pipelines visible until the user dismisses them. `/pipeline-dismiss`
removes only the registry pointer (`/tmp/pi-pipeline-status/active/<id>.json`); it does not delete
logs, status files, worktrees, or PRs.

`status.json` remains the source of truth. The registry is only a discovery pointer; the
extension must not infer state from logs or GitHub API calls.

## Monitoring Protocol (for invoking session)

After launching the pipeline, poll status on a cadence:

```bash
# Quick status check (run every 90-120 seconds)
cat "$LOG_DIR/status.json" 2>/dev/null | jq '{state: .pipeline_state, issue: .current_issue, phase: .current_phase, completed: (.issues_completed | length), remaining: (.issues_remaining | length)}'

# Detailed progress (when user asks or phase seems stuck)
tail -20 "$LOG_DIR/loop.log"

# Check if the current agent is alive
kill -0 "$(cat "$LOG_DIR/status.json" | jq -r .current_agent_pid)" 2>/dev/null && echo "alive" || echo "dead"
```

**Reporting cadence to user:**
- Report after each issue completes (merged or skipped)
- Report if a phase has been running longer than its timeout
- Report immediately on pipeline completion or abort

**What to report:**
```text
Pipeline progress: 2/5 issues complete.
- #273: merged ✓ (PR #280)
- #274: in progress (phase: bot-review, 8 min elapsed)
Remaining: #275, #276, #277
```

## Control File (steering)

The pipeline checks `$LOG_DIR/control` between phases (after each phase completes, before starting
the next). Write steering commands to this file:

```bash
# Skip the current issue and move to the next
echo "skip" > "$LOG_DIR/control"

# Abort the entire pipeline after the current phase finishes
echo "abort" > "$LOG_DIR/control"

# Pause after the current issue completes (wait for "resume" command)
echo "pause" > "$LOG_DIR/control"

# Resume a paused pipeline
echo "resume" > "$LOG_DIR/control"
```

The control file is consumed (truncated) after being read. Commands are one-shot.

**One command at a time.** Since the file is truncated after reading, a second write before the
first is consumed will overwrite it. Wait for the log to show the command was acted on (look for
"SKIP command received" or "PAUSE command received") before writing another command.

**Important**: Control commands are only read between phases, not mid-phase. If an agent is
running (implementation, review, or bot loop), the command takes effect after that agent finishes
or times out. To interrupt immediately, kill the agent PID directly.

---

## Checkpoint Pause and Resume

Pause is checkpoint-based. When a `pause` command is written, the pipeline may not stop
immediately: it completes the current phase and, by default, the current issue before halting.
**The durable `pipeline_state: "paused"` state is only written at the `between-issues`
checkpoint.** If you need to stop sooner, kill the current agent PID to cause it to time out,
then write `pause` so the pipeline halts before starting the next issue.

If the pipeline process receives TERM or SIGINT while already in the `paused` state, it preserves
`pipeline_state: "paused"` rather than overwriting it to `killed`. This means a tmux session
killed while paused retains a resumable status file.

### `/pipeline-resume` behavior

The `/pipeline-resume` command branches on PID liveness:

| Condition | Action |
|-----------|--------|
| `pipeline_state === "paused"` and PID alive | Writes `resume` to the control file. The live process handles the rest. |
| `pipeline_state === "paused"` and PID dead | Checks dead-process restart preconditions (see below). If all pass, launches a detached tmux session running `pipeline.sh --resume <status_file>`. |
| `pipeline_state !== "paused"` (any other state) | Refuses. Does not write to the control file and does not start a tmux session. |

Note: the live-PID path writes the control file once PID liveness, paused state, and a valid absolute control-file path are confirmed; it does not require schema v2 or checkpoint fields. The dead-PID path requires the full precondition set.

### Dead-process resume preconditions

All of the following must be true for `/pipeline-resume` to launch a restart session when the
pipeline process is dead:

1. `schema_version === 2`
2. `pipeline_state === "paused"`
3. `resume_supported === true`
4. `checkpoint === "between-issues"`
5. `script_file` is a non-empty absolute path
6. `status_file` (the resolved path to `status.json`) is a non-empty absolute path
7. `tmux` is available
8. No tmux session named `resume-<pipeline-id>` already exists

If any precondition fails, `/pipeline-resume` refuses with a message indicating which check
failed. No control file write or tmux session is started.

### v1 and non-checkpoint status files: monitor-only

Status files without `schema_version: 2` (absent, `1`, or any other value) are
**monitor-only for restart purposes**: `/pipeline-resume` will not attempt a dead-process restart
against them.

Precision: if a v1 pipeline process is still alive and paused with a valid control file, the
ordinary live-PID control-file steering path still works (`/pipeline-resume` writes `resume` and
the live process continues). Dead-process restart for v1 pipelines will not work.

### What `pipeline.sh --resume` owns

After the extension launches `pipeline.sh --resume <status.json>`, the script owns correctness:

- Validates `config_sha256` against the config file on disk
- Validates `checkpoint === "between-issues"`
- Checks for a concurrent agent PID already running for this pipeline
- Validates issue arrays and cursor consistency
- Re-checks config file presence and repo lock availability

The extension only launches the restart session and reports precondition refusals. It does not
repeat the script's internal validations.

### States that are not auto-restarted

`running`, `blocked`, `killed`, `aborted`, and `completed` states are not auto-restarted by
the extension. They require manual recovery, diagnosis, or are terminal. See
[Cleaning Up After a Failed Run](#cleaning-up-after-a-failed-run) for those flows.

### Manual fallback when tmux is unavailable

If `tmux` is not available and the status is a supported paused v2 between-issues checkpoint,
you can restart manually:

```bash
# Verify preconditions first (see list above), then:
<script_file> --resume <status_file>
```

The script validates all inputs and will refuse unsafe or inconsistent status files. Do not
run it against v1, non-paused, or non-between-issues status files.


## Immediate Intervention

When the control file isn't fast enough (agent is stuck, producing wrong output, etc.):

```bash
# Kill the current agent (default sequential mode treats this as a timeout and stops blocked)
kill -TERM "$(cat "$LOG_DIR/status.json" | jq -r .current_agent_pid)" 2>/dev/null

# Kill the entire pipeline. SESSION is the unique tmux session reported at launch.
tmux kill-session -t "$SESSION"

# Or if running without tmux:
kill -TERM "$(cat "$LOG_DIR/pipeline.pid")"
```

After killing an agent, the pipeline's `wait_for_handoff` will time out (or detect the PID is
dead) and apply the configured failure policy. Default sequential mode stops with status `blocked`;
`CONTINUE_ON_FAILURE=1` is required to proceed to the next issue.

## Intervention Judgment

Before taking any steering action, ask yourself:

- **Is the agent stuck or just slow?** Check `$LOG_DIR/<session>.log` for recent output (last 60s).
  `make check` on a large repo can take 5+ minutes with no visible progress. A `wait_for_handoff`
  heartbeat every 5 minutes is normal. Only intervene if the agent log shows no new output for
  10+ minutes AND the phase has exceeded 80% of its timeout.
- **Will this leave orphaned state?** Killing mid-implementation may leave an unpushed branch.
  Killing mid-bot-review may leave unresolved inline comments. Killing mid-merge is safe (merge
  is atomic). Prefer `skip` only when deliberately leaving the current issue behind; otherwise use
  `pause`/`abort` and diagnose.
- **Is this a systemic or isolated failure?** If one issue times out, it may be too large for
  the timeout. In default sequential mode a single failure stops downstream issue evaluation so
  dependent work is not judged against stale `BASE_BRANCH`.

## Decision Points for the Invoking Session

The invoking session should intervene when:

| Signal | Action |
|--------|--------|
| Issue took >35 min in implementation phase | Check agent log — may be stuck in a design loop. Consider killing and stopping for diagnosis. |
| Status shows `blocked` | Inform user. Fix/merge/split the blocked issue before restarting downstream items. |
| Status shows "skipped" for an issue | Inform user. Ask if this was explicit control-file skip or `CONTINUE_ON_FAILURE=1`. |
| Bot review is on round 4+ | Check progress log. If quality is declining, kill the bot agent PID; the pipeline will treat it as a timeout and continue to merge checks. |
| CI failure after merge attempt | Report to user — may need manual rebase. |
| Multiple consecutive skips | Only expected with `CONTINUE_ON_FAILURE=1`; pause and report because the batch may be misconfigured. |
| Pipeline completes with all issues merged | Report success summary. Clean up worktrees if desired. |
| Pipeline stops blocked | Report the blocking issue and recommended restart point after it is resolved. |
| Pipeline completes with some skips/failures | Only expected for explicit skips or best-effort mode; list what needs manual attention. |

## Detecting a Hung or Failed Pipeline

A pipeline is **hung** (not failed) when the script is alive but making no progress. A pipeline
is **failed** when the script or its current agent has exited without writing a handoff.

### Quick diagnostic (run all three):

```bash
# 1. Is the pipeline script itself alive?
# Prefer the launch-reported SESSION. If unknown, list unique pipeline sessions.
tmux has-session -t "$SESSION" 2>/dev/null && echo "pipeline: alive" || echo "pipeline: DEAD"
tmux list-sessions 2>/dev/null | grep 'impl-pipeline-' || true
pgrep -af 'implementation-pipeline/pipeline.sh' || true

# 2. What does status.json say? (stale last_update = hung)
cat "$LOG_DIR/status.json" | jq '{state: .pipeline_state, phase: .current_phase, last_update: .last_update, agent_pid: .current_agent_pid}'

# 3. Is the current agent alive?
AGENT_PID=$(cat "$LOG_DIR/status.json" | jq -r .current_agent_pid)
[ "$AGENT_PID" != "null" ] && (kill -0 "$AGENT_PID" 2>/dev/null && echo "agent: alive" || echo "agent: DEAD") || echo "agent: none"
```

### Interpretation:

| Pipeline script | Agent PID | `last_update` age | Diagnosis |
|----------------|-----------|-------------------|------------|
| alive | alive | <5 min | Normal — still working |
| alive | alive | 5-35 min | Possibly slow (check agent log) |
| alive | alive | >35 min | Hung — agent is stuck |
| alive | dead | any | Transitioning — pipeline will notice shortly |
| alive | none | stale | Bug — pipeline script may be stuck in `sleep` or control-file wait |
| dead | alive | any | Pipeline crashed — orphan agent running |
| dead | dead | any | Pipeline finished or crashed — check `status.json` state field |

### Confirming "stuck" vs "slow":

```bash
# Check agent's own log for recent activity
IMPL_LOG=$(ls -t $LOG_DIR/impl-*.log 2>/dev/null | head -1)
[ -n "$IMPL_LOG" ] && tail -5 "$IMPL_LOG" && echo "" && stat --format='Last modified: %y' "$IMPL_LOG"

# Check if make check is running (common reason for long silence)
ps aux | grep -E 'make|ruff|mypy|pytest|pnpm|vitest' | grep -v grep
```

If the agent log hasn't been modified in 10+ minutes AND no validation subprocess is running,
the agent is hung.

## Cleaning Up After a Failed Run

After a pipeline crashes, is killed, or leaves issues in a bad state, clean up in this order.
These states (`crashed`, `killed`, `blocked`) are not auto-restarted by the extension and
require manual recovery or diagnosis before re-running.

### 1. Kill orphan processes

```bash
# Find any pi/processes from this pipeline. Prefer matching the unique LOG_DIR or SESSION.
pgrep -af "$(basename "$LOG_DIR")|$SESSION|impl-[0-9]|review-[0-9]|ai-pr-review-loop|ghe-pr-review-loop" | grep -v grep

# Kill processes for this pipeline only.
pkill -f "$(basename "$LOG_DIR")" 2>/dev/null || true
[ -n "${SESSION:-}" ] && pkill -f "$SESSION" 2>/dev/null || true

# Verify no pipeline scripts remain for the same repo before restarting.
pgrep -af 'implementation-pipeline/pipeline.sh' | grep -v grep || echo "no pipeline scripts running"
find /tmp/pi-pipeline-locks -maxdepth 2 -type f -print -exec sh -c 'echo --- $1; cat "$1"' _ {} \; 2>/dev/null || true
```

### 2. Kill the tmux session (if still alive)

```bash
tmux kill-session -t "$SESSION" 2>/dev/null || true
```

### 3. Assess worktree and PR state

For each issue that was in progress or skipped:

```bash
# Check which worktrees exist
cd "$REPO" && git worktree list | grep "$WORKTREE_BASE"

# For each worktree, check state:
for wt in $WORKTREE_BASE/issue-*; do
  [ -d "$wt" ] || continue
  echo "=== $wt ==="
  cd "$wt"
  git status --short --branch
  gh pr view --json number,state,title 2>/dev/null || echo "  (no PR)"
  echo ""
done
```

### 4. Decide per-issue cleanup action

| Worktree state | PR state | Action |
|---------------|----------|--------|
| Clean, branch pushed | PR open, CI green | Merge manually or resume pipeline |
| Clean, branch pushed | PR open, CI red | Fix in worktree, push, then merge |
| Dirty, uncommitted changes | No PR | Inspect changes; commit+push+PR or discard |
| Clean, branch pushed | PR merged | Remove worktree (already done) |
| Clean, no commits beyond main | No PR | Remove worktree (nothing happened) |

### 5. Remove worktrees for completed/abandoned issues

```bash
# Remove a specific worktree
cd "$REPO"
git worktree remove "$WORKTREE_BASE/issue-275-problems-cross-env" --force

# Or remove all pipeline worktrees (nuclear option — only if all issues are resolved)
for wt in $WORKTREE_BASE/issue-*; do
  git worktree remove "$wt" --force 2>/dev/null || true
done
git worktree prune
```

### 6. Clean up temp files

```bash
# Remove pipeline logs and artifacts
rm -rf "$LOG_DIR"

# Remove handoff and prompt files
rm -f /tmp/impl-*-handoff.md /tmp/impl-*-prompt.md
rm -f /tmp/review-*-handoff.md /tmp/review-*-prompt.md
rm -f /tmp/ai-pr-review-loop-*-handoff.md /tmp/ai-pr-review-loop-*-prompt.md
rm -f /tmp/ai-pr-review-loop-*-progress.log /tmp/ai-pr-review-loop-*.log
rm -f /tmp/ghe-pr-review-loop-*-handoff.md /tmp/ghe-pr-review-loop-*-prompt.md
rm -f /tmp/ghe-pr-review-loop-*-progress.log /tmp/ghe-pr-review-loop-*.log
```

### 7. Close abandoned PRs (if issues won't be retried)

```bash
# Close a PR that won't be completed
gh pr close <PR_NUMBER> --delete-branch
```

### 8. Verify main is clean

```bash
cd "$REPO"
git fetch origin main
git log --oneline -5 origin/main
# Confirm no broken merges landed
```

## Resuming After Cleanup

After cleanup, re-run the pipeline with only the remaining issue numbers by launching a new
pipeline with a fresh config. The existing-PR detection will safely skip any issues that were
already merged. For issues that have an open PR but need more work, close the PR first
(`gh pr close <N> --delete-branch`) and remove the worktree before re-running.

**Note:** This manual-relaunch path is for crashed/killed/blocked pipelines. For a cleanly paused
pipeline at a `between-issues` checkpoint, use `/pipeline-resume` instead (see
[Checkpoint Pause and Resume](#checkpoint-pause-and-resume)).

## Edge Cases and How to Handle Them

### Dependency failures (Issue N blocked, Issue N+1 depends on it)

Default sequential mode prevents this class of failure: if Issue N cannot be merged, the pipeline
stops with status `blocked` before evaluating Issue N+1. This keeps downstream scope gates and
implementation prompts from seeing stale `BASE_BRANCH`.

If `CONTINUE_ON_FAILURE=1` was deliberately enabled for an independent batch and a skipped issue
turns out to be a dependency, downstream issues may either:

- fail `make check` because required code is missing; or
- pass while producing a semantically broken PR because the dependency is behavioral.

**Detection**: Status shows `blocked` in default mode, or downstream implementation fails with
import errors, missing types, or tests referencing code from the skipped issue in best-effort mode.

**Fix**: Resolve the blocked issue manually or with a single-issue pipeline run, merge it, then
resume the pipeline with only the remaining issues.

**Prevention**: Keep `CONTINUE_ON_FAILURE=0` for roadmap-ordered work. Only set it to `1` when the
user explicitly confirms the issues are independent.

### Merge conflicts from concurrent changes

If someone else merges to main between Issue N merging and Issue N+1's worktree setup, N+1
will start from the latest main (correct). But if N+1 was already in self-review or bot-review
when the external merge lands, N+1's PR may develop merge conflicts.

**Detection**: Merge phase fails with "not mergeable" or CI shows conflicts.

**Fix**: In the worktree, rebase onto main and force-push:
```bash
cd "$WORKTREE"
git fetch origin main
git rebase origin/main
git push --force-with-lease
```
Then manually merge or re-run the pipeline for that single issue.

### Bot never responds to review trigger comment

If the review bot is down, misconfigured, or rate-limited, the bot-review phase will wait
for its full timeout (default 40 min) without any findings appearing.

**Detection**: Bot review agent's progress log (`/tmp/<bot-session>-progress.log`) shows
"waiting for bot" for 10+ minutes with no new inline comments on the PR.

**Fix**: Kill the bot agent PID — the pipeline will treat it as a timeout and attempt merge.
This is safe when no bot findings appeared because there is nothing to fix.

### PR was merged or closed externally

If a human merges or closes the PR while the pipeline is still in self-review or bot-review:

**Detection**: Bot review or merge phase gets unexpected state from `gh pr view`.

**Fix**: The pipeline's merge phase will fail (PR already merged → API returns 405 or error).
This is a benign skip — the issue is done. If the PR was *closed* (not merged), you'll need
to decide whether to reopen it or start over.

### GitHub API rate limits

A 5-issue pipeline makes ~50-100 API calls per issue (pr view, comments, merge, CI status).
At 5 issues that's 250-500 calls. GitHub Enterprise typically allows 5000/hour for tokens.

**Detection**: `gh` commands start returning HTTP 403 with `rate limit exceeded` in stderr.
Agent logs will show repeated failures.

**Fix**: Write `pause` to the control file. Wait for the rate limit window to reset (check
`gh api rate_limit`). Then write `resume`. For the current stuck agent, it will likely time
out — the pipeline will skip and continue after the pause.

### Token or credential expiration mid-pipeline

Long-running pipelines (3+ hours for 5 issues) may outlive short-lived tokens.

**Detection**: `gh` commands return HTTP 401. Agent logs show "Bad credentials" or
"authentication failed".

**Fix**: Cannot recover mid-pipeline. Write `abort`. Refresh the token (`gh auth login` or
update `GITHUB_TOKEN`), then resume with remaining issues.

### Disk space exhaustion

Each worktree + `.venv` can be 200-500MB. Five worktrees may require 1-2.5GB. Agent logs
and temp files add more.

**Detection**: `make sync` or `git worktree add` fails with "No space left on device".
Agent may crash without writing a handoff.

**Fix**: Remove completed worktrees (see cleanup procedure above). Clear old pipeline
logs: `rm -rf /tmp/impl-pipeline-*/`. If recurrent, add cleanup of merged worktrees
between issues in the pipeline script.

### Agent crashes (OOM, segfault, pi bug)

The `pi` process may be killed by the OS OOM killer or crash due to an internal error.

**Detection**: `wait_for_handoff` detects the PID is dead (returns early with failure).
Pipeline logs: "Agent PID XXXX died without writing handoff".

**Fix**: This is handled automatically — the pipeline treats it as a timeout and skips.
If it happens repeatedly, check system memory (`free -h`) and reduce concurrency or
increase swap.

### Handoff file exists but is empty or malformed

Agent may crash mid-write, producing a 0-byte or truncated handoff file.

**Detection**: `extract_pr_number` returns empty despite handoff file existing. Pipeline
logs: "Could not determine PR number. Skipping."

**Fix**: Check if the agent actually created a PR (`gh pr list --head <branch>` in the
worktree). If yes, manually note the PR number and either merge it or resume. If no PR
exists, the implementation failed silently — check the agent log for errors.

### Branch name collision

If a branch `issue-273-problems-ui-badges` already exists on the remote (from a previous
aborted run) but no PR is open for it, the pipeline will reset it to main and proceed.
This is correct behavior. However, if the remote branch has force-push protections:

**Detection**: `git push` fails with "rejected (non-fast-forward)".

**Fix**: Delete the remote branch first: `git push origin --delete <branch>`. Or use a
different branch name by modifying the `BRANCHES` array.

### `make sync` fails in worktree setup

Dependency resolution failures (network, registry down, version conflicts) will leave the
worktree without a working `.venv`.

**Detection**: Implementation agent's `make check` will fail immediately. Handoff will
report validation failure.

**Fix**: Write `pause`. Fix the dependency issue (usually network or lockfile). Run
`make sync` manually in the worktree. Write `resume` — but the current issue is already
skipped. Re-run the pipeline for that issue afterward.

### Control file race condition (two commands written simultaneously)

If automation (not a human) writes to the control file, and writes overlap:

**Detection**: Unexpected behavior — wrong command executed or command lost.

**Fix**: This shouldn't happen with human operation (one command at a time rule). If
automating control-file writes, use `flock` or a temp-file-and-rename pattern:
```bash
echo "skip" > "$LOG_DIR/control.tmp" && mv "$LOG_DIR/control.tmp" "$LOG_DIR/control"
```

### tmux session killed by system (server restart, OOM)

If the server restarts or tmux is killed, the pipeline script dies but child `pi` agents
may survive briefly (they're `nohup`'d).

**Detection**: `tmux has-session -t "$SESSION"` returns error. But `pgrep -af "impl-"`
may show orphans.

**Fix**: Follow full cleanup procedure. The EXIT trap normally releases the repo lock, but it
cannot run if the pipeline process is killed with SIGKILL or the host crashes. Orphan agents must be
found and killed manually, and stale `/tmp/pi-pipeline-locks/*` entries should be inspected before
removal.

### Scope gate is too conservative (skipping valid issues)

The scope gate may be overly cautious with issues that have many acceptance criteria but are
actually well-bounded (e.g., a pure-additive component with 10 test assertions).

**Detection**: Multiple issues skipped with "too broad" verdicts that you disagree with.

**Fix**: Override per-issue by modifying the pipeline:
- Remove the issue from the batch and run it as a single-issue worker mode invocation
  (worker mode skips the scope gate)
- Or set `SKIP_SCOPE_GATE=1` in the environment to disable the gate for the entire batch
  (use only when you've manually validated all issues are well-scoped)

### Scope gate passes but implementation produces scope creep anyway

The gate evaluates the *issue description*, not the agent's *interpretation*. An agent may
read "add problem badges" and decide to also refactor the existing card layout.

**Detection**: Self-review finds changes outside the issue's stated scope. Diff touches
files not mentioned in the issue. Bot review generates findings about "unnecessary changes."

**Fix**: This is the reason the scope warning is injected into the implementation prompt.
If it still happens:
1. Kill the bot review loop (it'll just chase scope-creep findings)
2. In the worktree, `git diff --stat origin/main` to see the full surface
3. Manually revert out-of-scope changes: `git checkout origin/main -- <files>`
4. Recommit, push, and merge manually
5. File the out-of-scope work as a separate issue

## End-of-Pipeline Summary

When the pipeline finishes (all issues processed), read `status.json` and the log to produce:

```text
Pipeline complete.
Results:
  ✓ #273 — merged (PR #280, sha: abc1234)
  ✓ #274 — merged (PR #281, sha: def5678)
  ✗ #275 — skipped (implementation timed out)
  ✓ #276 — merged (PR #283, sha: ghi9012)
  ⏸ #277 — skipped (PR already existed)

4/5 issues merged. 1 needs manual attention.
Manual attention needed:
  - #275: implementation timed out — check $LOG_DIR/impl-275-*.log
  - #277: PR #270 already open — review and merge manually

Worktrees still active:
  /home/ubuntu/worktrees/.../issue-275-...
  /home/ubuntu/worktrees/.../issue-277-...
```
