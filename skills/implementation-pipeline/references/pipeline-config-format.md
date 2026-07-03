# Pipeline Config File Format

The preferred launch path is the `pipeline_run` extension tool or `/pipeline-run` command. Those
surfaces generate this config file and start `pipeline.sh` in a detached tmux session. The agent
should generate this file and launch `pipeline.sh` directly only when the extension launcher is
unavailable and the user explicitly approves the fallback.

The agent does NOT generate or modify the pipeline script.

---

## Config format

A shell-sourceable file. All pipeline behavior is determined by these values.

```bash
# Required
REPO="/home/ubuntu/repos/dynatrace-service-aggregator"
WORKTREE_BASE="/home/ubuntu/worktrees/service-intelligence-platform"
OWNER_REPO="strat/dynatrace-service-aggregator"
AI_REVIEW_PROVIDER="ghe-pr-bot"                 # or "coderabbit"
AI_REVIEW_API_BASE="https://github.concur.com/api/v3" # coderabbit: https://api.github.com
BASE_BRANCH="main"                            # e.g. "master" for older repos
ISSUES=(274 275 276 277)
BRANCHES=(
  "issue-274-problems-detail-page"
  "issue-275-problems-cross-env"
  "issue-276-problems-global-dashboard"
  "issue-277-problems-timeline"
)

# Optional — defaults shown
MERGE_STRATEGY="squash"
REVIEW_LOOP_COUNT=5
TIMEOUT_IMPL=2400      # 40 min
TIMEOUT_REVIEW=1200    # 20 min
TIMEOUT_BOT=7200       # 2 hr; lets AI review workers sleep through provider rate limits
TIMEOUT_CI=600         # 10 min
TIMEOUT_GATE=120       # 2 min
HANDOFF_POLL_SECONDS=5 # handoff-file polling interval for agent phases
CI_POLL_SECONDS=10     # CI status polling interval
PAUSE_POLL_SECONDS=2   # paused control-file polling interval
DEAD_AGENT_FLUSH_SECONDS=2  # grace period for handoff file after agent PID exits
FINAL_STATUS_SETTLE_SECONDS=0  # optional post-issue settle delay; 0 means no delay
LOCAL_CODERABBIT_PRECHECK=1  # enforce local `coderabbit review` before opening PRs when provider=coderabbit
SKIP_REVIEW=0
SKIP_BOT=0
SKIP_SCOPE_GATE=0
FORCE_ISSUES=""        # e.g. "275,277" to bypass scope gate for those
NO_MERGE=0
CONTINUE_ON_FAILURE=0  # default: stop before next issue on any failure/blocker
ALLOW_CONCURRENT_REPO_PIPELINES=0  # default: refuse another running pipeline for the same repo
PIPELINE_REGISTRY_ROOT="/tmp/pi-pipeline-status/active"  # status discovery for pi extensions
LOG_DIR=""             # auto-generated if empty
IMPL_SKILL="design-first-implementation"
REVIEW_SKILL="targeted-pr-review"
BOT_SKILL="ai-pr-review-loop"
EXTRA_IMPL_CONTEXT=""  # appended to implementation prompt
```

`GHE_API` is still accepted as a deprecated fallback for `AI_REVIEW_API_BASE`, but new configs
should use the provider-neutral field.

## How to derive values

| Field | Source |
|-------|--------|
| `REPO` | `git rev-parse --show-toplevel` from user's cwd |
| `WORKTREE_BASE` | Repository AGENTS.md convention, or `~/worktrees/<repo-name>` |
| `OWNER_REPO` | Parse from `git remote get-url origin` — strip protocol/host/.git |
| `AI_REVIEW_PROVIDER` | `coderabbit` for public GitHub CodeRabbit; `ghe-pr-bot` for Enterprise Hyperspace/PR-Bot |
| `AI_REVIEW_API_BASE` | `https://api.github.com` for CodeRabbit; Enterprise host + `/api/v3` for GHE |
| `GHE_API` | Deprecated fallback for `AI_REVIEW_API_BASE`; do not use in new configs |
| `BASE_BRANCH` | `origin/HEAD` default branch; set explicitly when repo uses `master` |
| `ISSUES` | User provides |
| `BRANCHES` | Auto-generate: `issue-<N>-<slugified-title>` from `gh issue view <N>`; for split tracker checkpoints use `tracker:<child>,<child>` |
| `MERGE_STRATEGY` | User preference or repo convention (default: squash) |
| `CONTINUE_ON_FAILURE` | Keep `0` for roadmap/dependent sequences; set `1` only for independent best-effort batches |
| `ALLOW_CONCURRENT_REPO_PIPELINES` | Keep `0` by default; set `1` only with explicit user approval after verifying same-repo pipelines cannot interfere |
| `PIPELINE_REGISTRY_ROOT` | Runtime status registry for pi extensions; keep default unless testing |
| Timeouts | Use defaults unless user has reason to change |
| Poll intervals | Use defaults unless the pipeline is over-polling external APIs or needs slower local filesystem polling |

## Tracker checkpoint entries

When a broad issue is split into child issues, keep the parent tracker in the queue after the final
child and before downstream dependents. Use a `tracker:` branch entry listing children:

```bash
ISSUES=(470 471 472 473 422 413)
BRANCHES=(
  "issue-470-implement-environment-selector-component"
  "issue-471-implement-environment-selection-url-and-liveview-assign-helpers"
  "issue-472-implement-invalid-and-missing-environment-selection-handling"
  "issue-473-implement-multi-tab-safe-environment-switch-behavior"
  "tracker:470,471,472,473"
  "issue-413-update-credentials-ui-for-separate-paper-live-credential-cards"
)
```

The pipeline does not create a worktree for tracker entries. It verifies every listed child is
closed, comments on/closes the parent tracker if needed, marks the checkpoint complete, and then
continues. If any child remains open, the checkpoint blocks.

## Branch name generation

For each implementation issue, generate a branch name:

```bash
# Get issue title, lowercase, replace non-alphanumeric with hyphens, truncate
TITLE=$(gh issue view $ISSUE --json title -q .title | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-40)
BRANCH="issue-${ISSUE}-${TITLE}"
```

## Launching

Normal pipeline execution should be launched by the extension-owned launcher, not by ad-hoc bash.
The launcher has two entrypoints:

- LLM tool: `pipeline_run` with JSON-schema parameters matching this config contract.
- User command: `/pipeline-run <JSON>` or `/pipeline-run key=value ...`.

Both entrypoints validate the request, write `/tmp/<session>/config.sh`, set `LOG_DIR` to the same
`/tmp/<session>` directory, check `tmux`, ensure a unique session name, and run `pipeline.sh` in a
detached tmux session. They do not write status or registry entries themselves; `pipeline.sh` owns
those files after startup.

A separate validated restart path exists for paused pipelines: `pipeline.sh --resume <status.json>`
may be used when the pipeline is in a supported paused v2 `between-issues` checkpoint state and the
original process is dead. The extension handles this path via `/pipeline-resume`; see
`skills/implementation-pipeline/references/monitoring-and-steering.md` for the full preconditions
and semantics. Do not pass `--resume` to launch a new pipeline; it is strictly a restart path.

Manual config + tmux launch is a fallback only when `pipeline_run` and `/pipeline-run` are
unavailable and the user explicitly approves direct bash launch:

```bash
# 1. Write config
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPO_NAME="$(basename "$REPO")"
SESSION="impl-pipeline-${REPO_NAME}-${TS}"
CONFIG="/tmp/${SESSION}/config.sh"
mkdir -p "$(dirname "$CONFIG")"
cat > "$CONFIG" <<'EOF'
... (values above) ...
EOF

# 2. Launch in tmux with a unique session name. Do not kill a fixed session name.
# pipeline.sh enforces same-repo concurrency with a repo-level lock.
# Resolve this to the directory containing implementation-pipeline/SKILL.md.
SKILL_DIR="<absolute path to this skill directory>"
tmux new-session -d -s "$SESSION" "$SKILL_DIR/pipeline.sh $CONFIG; exec bash"

# 3. Report
echo "Pipeline launched."
echo "  Session: tmux attach -t $SESSION"
echo "  Log:     tail -f $(dirname $CONFIG)/loop.log"
echo "  Status:  cat $(dirname $CONFIG)/status.json"
echo "  Control: echo 'pause' > $(dirname $CONFIG)/control"
```

## Sequential dependency rule

Default behavior is fail-fast. If an issue cannot be merged, the next issue must not be evaluated
against stale `BASE_BRANCH`; the pipeline stops with status `blocked` instead. This prevents a
run from skipping downstream work merely because an upstream PR was open but not yet merged.

Set `CONTINUE_ON_FAILURE=1` only when the user explicitly says the issues are independent and a
best-effort batch is desired.

## What the agent MUST NOT do

- Do NOT modify `pipeline.sh` — it is a tested, static artifact
- Do NOT generate ad-hoc bash scripts that replicate pipeline logic
- Do NOT launch `pipeline.sh` directly when `pipeline_run` or `/pipeline-run` is available
- Do NOT inline pipeline phases into the conversation
- Do NOT override timeouts below safety minimums (TIMEOUT_GATE < 30, TIMEOUT_CI < 60)
- Do NOT set poll intervals to `0`, negative, fractional, or non-integer values; `FINAL_STATUS_SETTLE_SECONDS=0` is the only zero-valued timing knob and means no post-issue delay
- Do NOT set poll intervals close to or above their related timeout unless you intentionally accept coarse timeout behavior
- Do NOT set SKIP_SCOPE_GATE=1 without explicit user permission
- Do NOT set CONTINUE_ON_FAILURE=1 for roadmap-ordered, prerequisite-linked, or otherwise dependent issue sequences
- Do NOT set ALLOW_CONCURRENT_REPO_PIPELINES=1 without explicit user permission and a concrete non-interference check
- Do NOT put secrets, tokens, or credentials in the config file

## Validation

The script validates the config at startup and exits with clear errors if:
- Required fields are missing
- Arrays are empty or mismatched length
- REPO is not a git directory
- MERGE_STRATEGY is invalid
- Boolean toggles are not `0` or `1`
- Timeouts and poll intervals are not positive integers
- `FINAL_STATUS_SETTLE_SECONDS` is not a non-negative integer
- Another pipeline is already running for the same canonical repo path and `ALLOW_CONCURRENT_REPO_PIPELINES` is not set
- `pi` or `gh` commands are not available

## Controlling a running pipeline

Write commands to `$LOG_DIR/control`:

| Command | Effect |
|---------|--------|
| `pause` | Stop before next issue, wait for `resume` |
| `resume` | Continue after pause |
| `skip` | Skip the current/next issue |
| `abort` | Stop pipeline entirely |

## Monitoring

```bash
# Live log
tail -f $LOG_DIR/loop.log

# Machine-readable status, including current issue elapsed time and completed issue durations
cat $LOG_DIR/status.json | jq .

# Registry entry consumed by the pi pipeline-status extension
ls ${PIPELINE_REGISTRY_ROOT:-/tmp/pi-pipeline-status/active}

# Per-agent logs
ls $LOG_DIR/impl-*.log $LOG_DIR/review-*.log $LOG_DIR/bot-review-*.log
```
