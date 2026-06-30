# Implementation Pipeline — Usage Examples

These examples show how to invoke the skill. They are user-facing reference only — do not load
this file during pipeline generation.

---

## Basic usage

```
Implement issues #273, #274, #275, #276, #277 sequentially with full review pipeline.
```

The skill auto-detects repo, remote, API URL, worktree convention from the current directory
and AGENTS.md.

## With options

```
Run the implementation pipeline for issues #50, #51, #52.
Use 3 review rounds instead of 5.
Skip the targeted self-review — just do implementation + bot review + merge.
```

## Single issue (worker mode)

```
/skill:implementation-pipeline worker mode
Implement issue #273 through the full pipeline: design-first, review, bot loop, merge.
```

## Resume after blocked/failure state

```
Issue #274 failed to merge last run. Resume the pipeline from #274 after fixing it.
```

Default sequential mode stops at the first failed, blocked, or too-broad issue so later issues are
not evaluated against stale prerequisites. After the blocker is resolved and merged, restart with
only the remaining issues.

## Dry run (no merge)

```
Run the implementation pipeline for #273-#277 but don't merge — I want to review before merging.
```

(Sets `NO_MERGE=1` — the pipeline stops after bot review for each issue.)

## Best-effort independent batch

```
Run the implementation pipeline for #100, #101, #102 as independent issues.
Continue to later issues if one fails.
```

This is the only case where `CONTINUE_ON_FAILURE=1` is appropriate. Do not use it for roadmap
sections, prerequisite chains, or top-to-bottom milestone work.

## Custom context

```
Implement issues #100, #101, #102 sequentially.
Extra context: these are all React components using Mantine v7, follow existing patterns in
frontend/src/pages/. The backend API is already complete.
```

## Skip bot review (no review bot configured)

```
Run the implementation pipeline for #10, #11, #12 but skip the bot review loop.
```

(Sets `SKIP_BOT=1` — useful for repos without CodeRabbit, GHE PR-Bot, or another configured AI reviewer.)

## Cancellation

From another terminal, use the unique session name reported at launch:
```bash
tmux kill-session -t "$SESSION"
```

The EXIT trap will release the repo lock and kill all child `pi` processes on normal signal handling. Check the log for final state:
```bash
tail -20 "$LOG_DIR/loop.log"
```
