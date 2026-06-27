# Pipeline Config File Format

The agent's ONLY job is to generate a config file and launch `pipeline.sh`.
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
LOCAL_CODERABBIT_PRECHECK=1  # enforce local `coderabbit review` before opening PRs when provider=coderabbit
SKIP_REVIEW=0
SKIP_BOT=0
SKIP_SCOPE_GATE=0
FORCE_ISSUES=""        # e.g. "275,277" to bypass scope gate for those
NO_MERGE=0
CONTINUE_ON_FAILURE=0  # default: stop before next issue on any failure/blocker
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
| `BRANCHES` | Auto-generate: `issue-<N>-<slugified-title>` from `gh issue view <N>` |
| `MERGE_STRATEGY` | User preference or repo convention (default: squash) |
| `CONTINUE_ON_FAILURE` | Keep `0` for roadmap/dependent sequences; set `1` only for independent best-effort batches |
| Timeouts | Use defaults unless user has reason to change |

## Branch name generation

For each issue, generate a branch name:

```bash
# Get issue title, lowercase, replace non-alphanumeric with hyphens, truncate
TITLE=$(gh issue view $ISSUE --json title -q .title | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-40)
BRANCH="issue-${ISSUE}-${TITLE}"
```

## Launching

```bash
# 1. Write config
CONFIG="/tmp/impl-pipeline-$(date +%s)/config.sh"
mkdir -p "$(dirname "$CONFIG")"
cat > "$CONFIG" <<'EOF'
... (values above) ...
EOF

# 2. Launch in tmux
SKILL_DIR="$HOME/.pi/agent/skills/implementation-pipeline"
tmux new-session -d -s impl-pipeline "$SKILL_DIR/pipeline.sh $CONFIG; exec bash"

# 3. Report
echo "Pipeline launched."
echo "  Session: tmux attach -t impl-pipeline"
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
- Do NOT inline pipeline phases into the conversation
- Do NOT override timeouts below safety minimums (TIMEOUT_GATE < 30, TIMEOUT_CI < 60)
- Do NOT set SKIP_SCOPE_GATE=1 without explicit user permission
- Do NOT set CONTINUE_ON_FAILURE=1 for roadmap-ordered, prerequisite-linked, or otherwise dependent issue sequences
- Do NOT put secrets, tokens, or credentials in the config file

## Validation

The script validates the config at startup and exits with clear errors if:
- Required fields are missing
- Arrays are empty or mismatched length
- REPO is not a git directory
- MERGE_STRATEGY is invalid
- Boolean toggles are not `0` or `1`
- Timeouts are not positive integers
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

# Machine-readable status
cat $LOG_DIR/status.json | jq .

# Per-agent logs
ls $LOG_DIR/impl-*.log $LOG_DIR/review-*.log $LOG_DIR/bot-review-*.log
```
