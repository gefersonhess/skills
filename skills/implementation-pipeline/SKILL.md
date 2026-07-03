---
name: implementation-pipeline
description: "Run a sequential implementation pipeline across multiple GitHub issues: for each issue, evaluate reviewability scope, set up a worktree, implement with design-first discipline, self-review, handle bot review, and merge. Includes a quantitative scope gate that skips issues too broad for a single reviewable diff. Use when asked to implement a batch of issues end-to-end, run an implementation loop, automate a series of issues through the full PR lifecycle, or evaluate whether issues are well-scoped for automated implementation. Triggers on: implementation loop, batch issues, automate issues, sequential implementation, implement and merge, pipeline, scope gate, reviewability."
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# Implementation Pipeline

Orchestrate sequential implementation of multiple GitHub issues through a full PR lifecycle:
worktree setup → design-first implementation → targeted self-review → bot review loop → merge.

## When to use

- User provides a list of issue numbers to implement sequentially
- User asks to "run an implementation loop" or "automate these issues"
- User wants end-to-end: implement → review → merge for a batch

## Preferred Launch Path

**Always prefer the `pipeline_run` LLM tool or `/pipeline-run` command** to launch pipelines.
Do NOT run `pipeline.sh` directly via bash (e.g. in a tmux session) unless:
1. The `pipeline_run` tool and `/pipeline-run` command are both explicitly unavailable in the current environment, AND
2. The user explicitly approves a fallback to direct bash launch.

The tool/command handle session naming, config generation, tmux availability checks, and session uniqueness automatically. Direct bash launch is error-prone and bypasses these safeguards.

## Split Tracker Checkpoints

When an oversized issue is split into child issues, the parent tracker is still work. Do not leave it
as an implicit dependency for later scope gates to trip over.

Queue split work as:

```text
child-1, child-2, ..., child-N, parent-tracker-checkpoint, downstream-dependent
```

The checkpoint verifies every child issue is closed, comments on/closes the parent tracker, and only
then lets downstream dependent issues proceed. If any child is still open, the checkpoint blocks.

In pipeline config, represent a tracker checkpoint by including the parent issue in `ISSUES` and a
matching `BRANCHES` entry with the child list:

```bash
ISSUES=(470 471 472 473 422 413)
BRANCHES=(
  "issue-470-..."
  "issue-471-..."
  "issue-472-..."
  "issue-473-..."
  "tracker:470,471,472,473"
  "issue-413-..."
)
```

Do not skip the parent tracker merely because it is not directly implementable. A split tracker is
complete only after its children are merged and the tracker itself is closed or verified closed.

## Mode Selection

- If the user prompt contains `worker mode`: execute a single issue pipeline directly (do not spawn).
- Otherwise: orchestrate — set up the tmux session and monitoring.

## Thinking Framework

Before generating the pipeline, ask yourself:

- **Dependency order**: Do any issues depend on code from earlier issues? If yes, they must be
  sequential and the dependent issue must come after its prerequisite merges. If a dependency is a
  split parent tracker, include a tracker checkpoint immediately after the final child and before any
  downstream dependent issue.
- **Scope per issue**: Is each issue small enough for a single agent session (40 min timeout)?
  If an issue looks like it needs >1 PR, flag it to the user before starting.
- **Repository readiness**: Does `make check` pass on main right now? If not, the pipeline will
  fail on every issue. Verify before launching.
- **Existing work**: Do any branches or PRs already exist for these issues? The pipeline must
  detect and skip (not destroy) in-progress work.

## Scope Gate (Phase 0)

Before implementation begins for each issue, evaluate whether the issue is appropriately scoped
for a single pipeline pass. This is the most important quality gate — a too-large issue that
slips through produces unreviewable diffs, scope-creep review loops, and hidden defects that
merge because the review surface is too broad to catch them.

### Why this matters

The failure mode is NOT timeout. It's:
1. **Unreviewable diffs** — a 500-line diff across 8 files can't be meaningfully self-reviewed
2. **Scope creep during implementation** — the agent solves adjacent problems because boundaries aren't firm
3. **Review loop divergence** — bot review generates findings about tangential code, agent "fixes" them, expanding the diff further
4. **Hidden defects that merge** — too much surface area for any single review pass to cover

### Reviewability Risk Score

The core question is NOT "is this too much code?" — it's "can a single review pass catch
defects in this diff?" Score each factor, sum them, and use the thresholds below.

Read the issue (`gh issue view <N> --json body,title`) and score:

**Boundary clarity (0-4 points — higher = more risk):**

| Factor | 0 | 1 | 2 | 3-4 |
|--------|---|---|---|-----|
| Subsystems touched | 1 (new file) | 2 (one layer) | 3-4 (cross-layer) | 5+ (full stack) |
| Existing code modified vs new code | Pure additive | Mostly new, minor wiring | Mixed new + modified | Mostly modifying existing |
| Contract boundaries | One clear contract | Two contracts (in+out) | Implicit/undocumented | Multiple or negotiable |

**Scope firmness (0-4 points — higher = more risk):**

| Factor | 0 | 1 | 2 | 3-4 |
|--------|---|---|---|-----|
| Acceptance criteria | 1-3, binary pass/fail | 4-6, testable | 7-8, some ambiguous | 9+, or qualitative |
| Stopping point | Explicit ("add X") | Implied by criteria | Fuzzy ("improve") | Open-ended ("refactor") |
| Adjacent temptation | None visible | Minor cleanup nearby | Pattern used elsewhere | Same file has tech debt |

**Review difficulty (0-4 points — higher = more risk):**

| Factor | 0 | 1 | 2 | 3-4 |
|--------|---|---|---|-----|
| Estimated diff lines | <100 | 100-250 | 250-400 | 400+ |
| Behavioral changes | None (structural only) | One behavior | Multiple behaviors | State machine / lifecycle |
| Domain knowledge required | Generic (types, UI) | One domain concept | Multiple interacting | Compliance / security |

**Dependency risk (0-2 points — higher = more risk):**

| Factor | 0 | 1 | 2 |
|--------|---|---|---|
| Prerequisites | All in main | In main but recent | Not yet merged / unclear |
| Test isolation | Self-contained fixtures | Needs existing test infra | Needs live services or shared state |

### Thresholds

| Total score | Verdict | Action |
|-------------|---------|--------|
| 0-4 | **Green** — well-scoped | `proceed` |
| 5-7 | **Yellow** — manageable with focus | `proceed-with-warning` + scope reminder in implementation prompt |
| 8-10 | **Orange** — high risk, likely produces unreviewable diff | `skip` with split recommendation |
| 11+ | **Red** — too broad, will definitely cause review loop divergence | `skip` with split recommendation |
| Any dependency score = 2 | **Blocker** — regardless of other scores | `blocker` |

### Scoring examples

**Issue: "Add problem count badge to logical-service cards" (score: 2)**
- Subsystems: 1 (frontend only) → 0
- Existing modified: mostly new component → 0
- Contract: one clear type update → 0
- Criteria: 8 binary → 1
- Stopping point: explicit → 0
- Adjacent temptation: minor → 1
- Diff: ~115 lines → 0
- Behavioral: one behavior → 0
- Domain: generic UI → 0
- Prerequisites: all in main → 0
- Test isolation: self-contained → 0
- **Total: 2 → Green, proceed**

**Issue: "Refactor collection pipeline to support multiple providers" (score: 12)**
- Subsystems: 4 (collector, config, contracts, tests) → 3
- Existing modified: heavy modification → 2
- Contract: multiple renegotiable → 3
- Criteria: 6 testable → 1
- Stopping point: fuzzy ("refactor") → 2
- Adjacent temptation: pattern used in 5 collectors → 2
- Diff: ~600 lines → 3
- Behavioral: state machine changes → 3
- Domain: provider abstraction → 2
- Prerequisites: in main → 0
- Test isolation: self-contained → 0
- **Total: 12+ → Red, skip with split recommendation**

### Why not just count acceptance criteria?

An issue with 10 criteria that are all "renders X correctly" (additive, one file, self-contained
fixtures) scores 2-3 and is fine. An issue with 4 criteria that span authentication, persistence,
API, and UI scores 9+ and should be split. **Criteria count is one signal, not the signal.**

The critical factors are:
- **How many existing behaviors change** (each is a defect surface the review must verify)
- **How firm the stopping point is** (fuzzy boundaries invite scope creep)
- **How much domain context a reviewer needs** (more context = more defects missed)

### Decision

Use the score thresholds above. The verdict maps directly:

| Score | Verdict file content |
|-------|---------------------|
| 0-4 | `proceed` |
| 5-7 | `proceed-with-warning:<one-line summary of highest-scoring factors>` |
| 8+ | `skip:<one-line reason + split recommendation>` |
| dependency = 2 | `blocker:<what's missing>` |

When skipping, log a specific recommendation:
```text
[SCOPE GATE] Issue #275 skipped — too broad for single pipeline pass.
Reason: 12 acceptance criteria across 3 subsystems (frontend, API route, contract).
Recommendation: Split into #275a (contract + API), #275b (frontend component), #275c (integration tests).
```

### Implementation in the script

The scope gate runs as a lightweight `pi` invocation (no skill — just a direct prompt) with a
60-second timeout. It reads the issue and writes a one-line verdict to a gate file:

- `proceed` — issue is well-scoped
- `proceed-with-warning:<reason>` — proceed but log a focus reminder
- `skip:<reason>` — too broad, recommend split
- `blocker:<reason>` — cannot implement (missing prerequisite)

If the gate times out (shouldn't — it's just reading an issue), treat as `proceed` to avoid
blocking the pipeline on a judgment call.

## Orchestrator Mode

### 1. Gather inputs

Auto-detect or ask the user:

| Input | How to derive | Fallback |
|-------|---------------|----------|
| `ISSUES` | User provides list | Ask |
| `REPO` | `git rev-parse --show-toplevel` from cwd | Ask |
| `OWNER_REPO` | Parse from `git remote get-url origin` | Ask |
| `AI_REVIEW_PROVIDER` | `coderabbit` for public GitHub CodeRabbit, `ghe-pr-bot` for Enterprise Hyperspace/PR-Bot | Infer/ask |
| `AI_REVIEW_API_BASE` | `https://api.github.com` for CodeRabbit; Enterprise `/api/v3` for GHE | Infer/ask |
| `WORKTREE_BASE` | Repository AGENTS.md convention or `~/worktrees/<repo-name>` | Derive |
| `BASE_BRANCH` | Default branch from `origin/HEAD`; set explicitly for `master` repos | Derive |
| `BRANCH_PREFIX` | `issue-<number>-<slugified-title>` | Auto-generate |
| `REVIEW_LOOP_COUNT` | Default 5, user can override | 5 |
| `MERGE_STRATEGY` | `squash` (default), `merge`, `rebase` | `squash` |
| `TIMEOUT_IMPL` | Max time for implementation phase (seconds) | 2400 (40 min) |
| `TIMEOUT_REVIEW` | Max time for self-review phase (seconds) | 1200 (20 min) |
| `TIMEOUT_BOT` | Max time for bot review loop (seconds); must allow provider rate-limit sleeps | 7200 (2 hr) |
| `LOCAL_CODERABBIT_PRECHECK` | For CodeRabbit provider, run local `coderabbit review` before push/PR creation | 1 |

`GHE_API` is deprecated as a config field. `pipeline.sh` still accepts it as a fallback for older
configs, but new configs must set `AI_REVIEW_PROVIDER` and `AI_REVIEW_API_BASE`.

### 2. Generate the config file and launch

**Preferred**: Use the `pipeline_run` LLM tool or `/pipeline-run` command — they handle config generation, session naming, tmux checks, and uniqueness automatically. Only fall back to manual config + bash launch below if the tool/command are unavailable and the user explicitly approves.

**MANDATORY — READ ENTIRE FILE**: Load `references/pipeline-config-format.md` before generating
the config. It defines all required and optional fields, how to derive values, and what the
agent MUST NOT do.

**Do NOT load** `references/usage-examples.md` during generation — it is user-facing documentation
only.

**Do NOT load** `references/worked-example.md` during generation — it is for debugging and
explaining output format only.

The pipeline logic lives in `pipeline.sh` (a static, tested, lintable script in this skill
directory). In the default mode, this is a dependency-preserving pipeline, not a best-effort batch
runner: do not configure it to continue past a failed or blocked issue unless the user explicitly
says the issues are independent.

The agent's ONLY job is:
1. Gather inputs (issue numbers, repo, remote)
2. Write a config file (shell-sourceable)
3. Launch `pipeline.sh <config-file>` in tmux

The agent does NOT generate bash scripts. The agent does NOT modify `pipeline.sh`.
All pipeline behavior is controlled by config values.

Key behaviors of `pipeline.sh`:
- Validates config at startup (exits with clear errors if invalid)
- Strict sequential execution — the next issue starts only after the current issue is merged into `BASE_BRANCH`
- Pulls `BASE_BRANCH` between issues so later issues build on earlier merges
- Each phase spawns a `pi` instance with the appropriate skill
- Waits for handoff files as completion signals with dead-PID detection
- Logs everything to a consolidated log file
- Writes machine-readable status to `$LOG_DIR/status.json` (atomic writes)
- On phase failure, scope-gate blocker, scope-gate skip, bot blocker, CI failure, or merge failure: stops the pipeline by default before evaluating the next issue
- Best-effort continuation across independent issues is opt-in only with `CONTINUE_ON_FAILURE=1`
- On merge: polls CI with timeout, uses `--admin` flag, falls back to API merge
- Traps INT/TERM to kill child process groups (no orphan processes)
- Detects existing PRs for a branch and stops by default (does not destroy in-progress work)
- Checks `$LOG_DIR/control` for steering commands between phases
- Acquires a repo-level lock by default and refuses a second concurrent pipeline for the same repo unless `ALLOW_CONCURRENT_REPO_PIPELINES=1` is explicitly set
- Escalates kill: SIGTERM → 3s grace → SIGKILL

### 3. Launch in tmux

```bash
# Resolve this to the directory containing this SKILL.md, for example:
# /path/to/skills-repo/skills/implementation-pipeline
SKILL_DIR="<absolute path to this skill directory>"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPO_NAME="$(basename "$REPO")"
SESSION="impl-pipeline-${REPO_NAME}-${TS}"
CONFIG="/tmp/${SESSION}/config.sh"

# Do not kill a fixed session name. Session names are unique; same-repo concurrency
# is prevented by pipeline.sh's repo-level lock.
tmux new-session -d -s "$SESSION" -n loop "$SKILL_DIR/pipeline.sh $CONFIG; exec bash"
```

If `tmux` is not available, fall back to `nohup` + background:
```bash
nohup "$SKILL_DIR/pipeline.sh" "$CONFIG" > "$(dirname "$CONFIG")/loop.out" 2>&1 &
echo $! > "$(dirname "$CONFIG")/pipeline.pid"
```

### 4. Report launch

```text
Implementation pipeline launched.
Session: $SESSION (tmux)
Script:  $SKILL_DIR/pipeline.sh
Config:  $CONFIG
Issues: #X, #Y, #Z
Log: $LOG_DIR/loop.log
Status: $LOG_DIR/status.json
Control: echo 'pause' > $LOG_DIR/control
Monitor: tail -f $LOG_DIR/loop.log
Attach: tmux attach -t $SESSION
```

### 5. Monitor and steer

**MANDATORY — READ ENTIRE FILE**: Load `references/monitoring-and-steering.md` for the full
monitoring protocol. Follow it after launch.

## Worker Mode (single issue)

When invoked with `worker mode` and a single issue number, execute the pipeline inline without
tmux:

1. Setup worktree
2. Spawn design-first implementation agent, wait for handoff
3. Spawn targeted-pr-review agent, wait for handoff
4. Spawn ai-pr-review-loop worker agent with the selected provider, wait for handoff

For `AI_REVIEW_PROVIDER=coderabbit`, the implementation prompt requires the implementation agent to
commit locally, then run `coderabbit doctor` and
`coderabbit review --agent --type committed --base <BASE_BRANCH>` before push/PR creation when
`LOCAL_CODERABBIT_PRECHECK=1`. Verified correctness/security/functional findings must be fixed,
validated, committed/amended, and re-reviewed locally before opening the PR; false-positive/stale or
explicitly out-of-scope findings must be documented in the PR body and handoff. The pipeline rejects
implementation handoffs that do not document a successful local CodeRabbit precheck with either zero
findings or all real findings addressed. This pre-PR pass does not replace the post-PR CodeRabbit
approval/no-actionable gate.
5. Merge if CI green
6. Write handoff

## Phase Transition Judgment

Before starting the next phase, ask:

- **Phase 2 → 3**: Did the implementation handoff report `make check` passing? If not, the
  self-review will waste time on lint/type failures. Kill the pipeline for this issue instead.
- **Phase 3 → 4**: Did the self-review push new commits? If yes, wait 15s for CI. If no commits
  pushed, proceed immediately — no CI to settle.
- **Phase 4 → 5**: Did the bot handoff report "CI green"? If it says "CI: pending" or "blocker",
  do not attempt merge. In default sequential mode, stop before the next issue instead of continuing
  against stale prerequisites.

## Pipeline Phases (detail)

| Phase | Skill | Key contract | Handoff must contain |
|-------|-------|-------------|---------------------|
| 0. Scope gate | — (lightweight prompt) | Issue # only; 60s timeout | One-line verdict: proceed/skip/blocker |
| 1. Worktree | — | `setup-worktree.sh` or manual; skip if PR exists | Clean working tree |
| 2. Implementation | `design-first-implementation` | Issue #, worktree, branch, scope warning | PR number, head SHA, `make check` result |
| 3. Self-review | `targeted-pr-review` | PR #, worktree | Findings count, fixes, head SHA |
| 4. Bot review | `ai-pr-review-loop` (worker mode) | Minimal inputs only — provider model owns bot semantics | CI state, findings, head SHA |
| 5. Merge | — | CI green via `statusCheckRollup` | N/A (pipeline handles directly) |

**Phase 4 critical rule**: Pass only variable inputs (WORKTREE, PR, OWNER_REPO,
AI_REVIEW_PROVIDER, AI_REVIEW_API_BASE, SESSION_ID, LOG, HANDOFF). The `ai-pr-review-loop` skill
owns its own worker contract and provider-specific behavior — do NOT paste the full requirements
list. A minimal activation prompt is sufficient.

**Phase 5 fallback**: If `gh pr merge` fails, the script falls back to the API merge endpoint
automatically. It polls CI with a timeout loop (not a fixed sleep). It removes the worktree
before merge so `--delete-branch` doesn't fail on a local ref lock. All this logic is in
`pipeline.sh` — the agent never handles merge directly.

## Failure Handling

| Failure | Default sequential action | With `CONTINUE_ON_FAILURE=1` |
|---------|---------------------------|------------------------------|
| Scope gate says "skip" | Stop with status `blocked`; split or force deliberately | Log skip and continue |
| Scope gate says "blocker" | Stop with status `blocked`; satisfy prerequisite first | Log skip and continue |
| Scope gate times out | Proceed by default (gate is advisory, not blocking) | Same |
| Implementation times out | Kill agent, stop with status `blocked` | Log skip and continue |
| Implementation handoff has no PR number | Stop with status `blocked` | Log skip and continue |
| Self-review times out | Log warning, continue to bot review (non-blocking) | Same |
| Bot review times out | Log warning, attempt merge anyway | Same |
| Bot review reports blocker | Stop with status `blocked` | Log skip and continue |
| CI red at merge time | Stop with status `blocked` | Log skip and continue |
| Merge fails | Stop with status `blocked` | Log skip and continue |
| Worktree setup fails | Stop with status `blocked` when script can classify it; otherwise the shell command failure exits | Same unless explicitly handled |
| PR already exists for branch | Stop with status `blocked`; merge or close that PR first | Log skip and continue |
| Script killed (SIGINT/SIGTERM) | Trap kills child PIDs, logs final state | Same |
| Agent PID dies without handoff | Detected by `wait_for_handoff`, treated as timeout | Same failure policy as timeout |
| Merge conflict (another PR merged first) | Stop; manual rebase needed | Log skip and continue |
| API rate limit / token expiry | Agents fail repeatedly; write `pause` or `abort` | Same |

For detailed edge-case handling (13 scenarios with detection + fix), load
`references/monitoring-and-steering.md` — see "Edge Cases and How to Handle Them".

## Customization Points

The pipeline is designed to be extended:

- **Skip scope gate**: Set `SKIP_SCOPE_GATE=1` to disable the reviewability scoring
- **Force specific issues past scope gate**: Set `FORCE_ISSUES="275,277"` to bypass the scope
  gate for those issue numbers only (others still evaluated normally)
- **Skip self-review**: Pass `--skip-review` or set `SKIP_REVIEW=1` to skip Phase 3
- **Skip bot review**: Pass `--skip-bot` or set `SKIP_BOT=1` to skip Phase 4
- **Dry run**: Pass `--no-merge` or set `NO_MERGE=1` to stop after bot review without merging
- **Best-effort independent batch**: Set `CONTINUE_ON_FAILURE=1` only when issues do not depend on
  each other and skipping one cannot invalidate later scope-gate decisions
- **Custom implementation prompt**: Pass extra context via `--context "..."` to append
- **Resume**: If the pipeline crashes mid-batch, re-run with only the remaining issue numbers.
  The existing-PR detection ensures already-completed issues are safely skipped.

## Troubleshooting

| Symptom | Where to look | Fix |
|---------|--------------|-----|
| Pipeline stuck (no log progress 10+ min) | `ps aux \| grep pi` — is the child alive? | Kill stale PID, check `$LOG_DIR/<session>.log` |
| "Could not determine PR number" | Agent log for impl phase — did it push? | Check `git log --oneline -3` in worktree |
| Merge fails with "not mergeable" | PR has conflicts with main | Rebase in worktree, push, retry merge |
| Bot review loops without stopping | `/tmp/ai-pr-review-loop-*-progress.log` | Kill bot PID; quality gate may need manual triage |
| "CI not green" but checks look fine | GH API lag in `statusCheckRollup` | Wait 30s, retry: `gh pr view <PR> --json statusCheckRollup` |
| Agent writes handoff but no PR number in it | Agent succeeded but used freeform format | `gh pr view` in worktree is the authoritative fallback |
| Pipeline crashed, orphan agents running | `pgrep -af 'implementation-pipeline/pipeline.sh'` and `/tmp/pi-pipeline-locks` | See "Cleaning Up" in `references/monitoring-and-steering.md` |
| Unsure if pipeline is hung or just slow | `status.json` last_update + agent log mod time | See "Detecting a Hung Pipeline" in `references/monitoring-and-steering.md` |

For full diagnostic procedures, cleanup steps, and worktree removal:
**Load** `references/monitoring-and-steering.md` — see "Detecting a Hung or Failed Pipeline"
and "Cleaning Up After a Failed Run" sections.

## Anti-patterns

- **NEVER generate or modify `pipeline.sh`.** It is a tested, static artifact. The agent writes a config file and launches the script — nothing else. If the script has a bug, fix it in the skill repo, not inline.
- **NEVER write ad-hoc bash scripts** that replicate pipeline logic. The static script exists specifically to prevent agent hallucination of pipeline behavior.
- **NEVER run two pipelines against the same repository concurrently.** Merge conflicts will cascade.
- **NEVER skip `make check`** (or equivalent) between implementation and PR push.
- **NEVER merge with red CI.** If the bot review introduced a failure, the pipeline must stop before
  evaluating downstream issues unless `CONTINUE_ON_FAILURE=1` was explicitly configured for an
  independent batch.
- **NEVER carry state between issues.** Each issue starts fresh from main. If issue B depends on issue A's code, A must merge first.
- **NEVER hardcode repository-specific paths** in this skill. Detect from AGENTS.md, Makefile, and git remote.
- **NEVER reset a branch that already has a PR open.** Check for existing PRs before touching an existing worktree — destroying in-progress work is unrecoverable.
- **NEVER spawn a bot review if CI is still running from the self-review push.** Wait for CI to settle (15s minimum) or the bot may review stale code.
- **NEVER paste another skill's full prompt contract into this skill's template.** The owning skill manages its own prompt. Pass only variable inputs and let `--skill` handle the rest. Copy-pasted prompts drift silently when the owning skill updates.
- **NEVER assume the implementation agent will produce a handoff in the expected format.** The agent may write freeform text without "PR #NNN". Always fall back to `gh pr view` in the worktree rather than failing on regex mismatch. The `extract_pr_number` function handles this — keep its gh-first ordering if modifying.
