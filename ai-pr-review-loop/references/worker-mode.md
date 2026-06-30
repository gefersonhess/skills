<!-- markdownlint-disable MD013 -->

# Shared Worker Mode

This is the provider-independent engine. Load the selected provider file before running commands.

## Session Logs

Initialize logs once per worker run:

```bash
SCORES_LOG="/tmp/${SESSION_ID:-ai-pr-review-loop}-scores.jsonl"
QUALITY_LOG="/tmp/${SESSION_ID:-ai-pr-review-loop}-quality.jsonl"
PROGRESS_LOG="/tmp/${SESSION_ID:-ai-pr-review-loop}-progress.log"
REPLIED_LOG="/tmp/${SESSION_ID:-ai-pr-review-loop}-replied.txt"
FEEDBACK_LOG="/tmp/${SESSION_ID:-ai-pr-review-loop}-feedback.txt"
FOLLOWUP_LOG="/tmp/${SESSION_ID:-ai-pr-review-loop}-followups.tsv"
> "$SCORES_LOG"
> "$QUALITY_LOG"
> "$PROGRESS_LOG"
> "$REPLIED_LOG"
> "$FEEDBACK_LOG"
> "$FOLLOWUP_LOG"
```

`REPLIED_LOG` is the inline-reply idempotency ledger. Before posting any reply, check:

```bash
grep -qx "$COMMENT_ID" "$REPLIED_LOG" && echo "already replied: $COMMENT_ID" && continue
```

Append the ID only after a successful reply API call.

## Scope Contract

Before classifying any finding, write a short scope contract for the PR from:

- linked issue and acceptance criteria;
- PR body and stated testing;
- current diff against the base branch;
- project design/plan docs changed by the PR.

A finding is in scope only when it is necessary to solve the linked problem, satisfy an explicit acceptance criterion, or fix a defect introduced by the current diff. A valid concern that requires a new subsystem, broader policy, extra hardening beyond the issue, unrelated refactors, or design expansion is out of scope for this loop.

For every valid out-of-scope finding, create a GitHub issue before replying:

```bash
ISSUE_BODY=$(mktemp)
cat > "$ISSUE_BODY" <<ISSUE
Found during PR #$PR review.

Source comment: <comment URL>

Why out of scope for this PR: <scope rationale>

Triage notes: <what should be decided outside the review loop>
ISSUE
ISSUE_URL=$(gh issue create \
  --title "Review follow-up: <short finding>" \
  --body-file "$ISSUE_BODY")
printf '%s\t%s\n' "$COMMENT_ID" "$ISSUE_URL" >> "$FOLLOWUP_LOG"
```

Then reply inline with the scope rationale and issue URL. Do not implement the follow-up, do not ask the reviewer loop to re-review that follow-up, and do not let it affect loop continuation except as an answered out-of-scope comment.

## Round Order

Use this exact order each round:

1. Rehydrate worktree, PR head, PR body, CI, reviews, issue comments, inline comments.
2. For CodeRabbit provider, verify that the PR body or recent PR comments document a local CodeRabbit CLI precheck (`coderabbit doctor` plus `coderabbit review --agent --type committed --base <base>`). If missing, run the local CLI check before triggering remote CodeRabbit, fix verified real findings, update the PR body/comment with the result, and record in HANDOFF that the required pre-PR check was recovered post-PR. This fallback is a safety net; it does not relax the implementation-pipeline requirement to run the CLI before PR creation.
3. Run provider preflight:
   - unresolved inline/follow-up comments selected for triage;
   - current-head approval/no-actionable signal stops successfully;
   - otherwise one provider review trigger is required.
4. If triggering, post exactly one provider trigger and wait by provider rules. Provider rate/usage limits are a wait state, not a blocker: sleep until the provider's stated reset time/duration plus safety margin, emit progress lines while sleeping, then retry within the same round.
5. Build the selected findings set from provider rules.
6. Read cited code, apply the Scope Contract, and classify every finding:
   - `1.0` real actionable defect that is in scope for this PR;
   - `0.7` valid in-scope cleanup but non-blocking / not necessary for this PR;
   - `0.3` valid but out of scope for this PR;
   - `0.0` false positive/stale/wrong.
   For design-only, docs-only, or contract-decision PRs, classify reviewer requests for runtime helpers, validators, clients, fake servers, endpoint implementations, schedulers, publication paths, or other downstream implementation details as `0.3` out of scope unless the issue acceptance criteria explicitly require that code. If the design needs clarity, add bounded wording that names the downstream owner issue instead of implementing the behavior.
7. For each `0.3` finding, check `FOLLOWUP_LOG` first; create or link exactly one follow-up issue using the Scope Contract procedure before any reply. The follow-up is triaged outside the loop; never implement it in this loop.
8. Append classification JSON lines to `QUALITY_LOG`.
9. **Rate each finding using provider feedback mechanism** (mandatory). If the provider exposes feedback controls on its comments (e.g. checkboxes, reactions), mark each classified finding per the provider file's Feedback section. Use `FEEDBACK_LOG` for idempotency.
10. Apply post-triage quality gate.
11. Reply immediately to non-actionable findings using provider reply endpoint. Include follow-up issue URLs for `0.3` findings.
12. Fix in-scope actionable findings only after the quality gate passes.
13. Run focused validation and repo-required validation.
14. Commit/push fixes.
15. Reply to fixed actionable findings with commit SHA and `CI: pending`.
16. Wait for acceptable CI as defined below and by provider overrides. If an authoritative check is red, investigate and hand off as blocker. Ignore explicitly non-authoritative/broken provider-listed checks for loop control. Do not classify provider rate limits as CI failure or review blocker unless the provider-specific wait/retry budget is exhausted.
17. Append one progress line and write/update HANDOFF.
18. Apply the loop-continuation gate below. Do not stop merely because the current round's actionable findings were fixed.

## Loop-Continuation Gate

Internal quality classifications control whether the worker continues or stops. Provider feedback controls (checkboxes, reactions, etc.) are only an external record of that classification; they must never be read back as the loop-control signal.

| Round result | Required action |
| --- | --- |
| Provider approval/current-head no-actionable signal | Stop successfully. |
| A triggered provider review returns zero selected findings for the current head | Stop successfully. |
| All selected findings are `<= 0.3` or round average is `<= 0.5` | Create follow-up issues for `0.3`, reply/rate, then stop as `all-non-actionable` or `quality-gate`. |
| Any selected finding is `1.0` and in scope | Fix, validate, push, reply, wait for acceptable CI, then continue to the next round if loop budget remains. |
| Selected findings are only `0.7` | Reply/rate as valid non-blocking cleanup; do not fix by default. Stop as `non-blocking-only` unless the user explicitly asks the loop to include cleanup work. |
| Loop budget exhausted after completing the round | Stop as `loop-count`. |

A fixed actionable finding is proof that the previous review was useful, not proof that the PR is clean. After fixing a `1.0` finding, the next round must re-run provider preflight on the new head. If there is no current-head approval/no-actionable signal and no unresolved bot follow-up, trigger another provider review until the loop budget is exhausted or a stop condition above occurs.

Do not infer loop state from provider feedback acknowledgements such as "Helpful" or "Awesome". Those acknowledgements may be rewritten by the provider UI and are not tied to PR head freshness. The authoritative loop state is the worker's own classification log plus current-head provider preflight.

## Post-Triage Quality Gate

After classifying all findings and before code changes:

```bash
ROUND_AVG=$(python3 -c '
import json, sys
path = sys.argv[1]
items = [json.loads(l) for l in open(path) if l.strip()]
print(1.0 if not items else sum(i["quality"] for i in items) / len(items))
' "$QUALITY_LOG")
```

Stop without fixing if there are no in-scope `1.0` findings, if all selected findings are `<= 0.3`, or if round average is `<= 0.5`. Create follow-up issues for out-of-scope valid findings, reply to non-actionable findings, then write HANDOFF. Do not fix low-value or out-of-scope suggestions just because they are easy.

## CI Status Control

CI wait/stop logic must use only authoritative checks for the repository/provider.

Rules:

- Treat a check as **authoritative** unless the provider file lists its exact name under ignored/non-authoritative CI checks.
- Ignored checks must still be reported in HANDOFF, but must not block loop continuation, readiness, or handoff exit reason.
- Do not use raw `gh pr checks --watch` as the sole loop-control command when ignored checks exist; it can block on broken external integrations.
- Instead, poll `gh pr checks --watch=false` or `gh pr view --json statusCheckRollup`, filter out ignored check names, and continue when all remaining checks are terminal and non-failing.
- Terminal non-failing conclusions are `pass`, `success`, `skipping`, `skipped`, `neutral`, or their GitHub API equivalents.
- Any non-ignored `fail`, `failure`, `timed_out`, `cancelled`, or `action_required` conclusion is a blocker.
- If all authoritative checks are green/non-failing and only ignored checks remain pending/broken, record `CI: acceptable; ignored checks: <names>` and continue the review loop.

## Validation Discipline

For every real finding:

- name the invariant it violates;
- search for adjacent/global instances of the same defect class;
- add or update tests when behavior changed;
- run focused validation first;
- run the repository-required full validation before push;
- include validation commands/results in HANDOFF and inline reply.

## Reply Contract

Every finding gets exactly one outcome:

- fixed with commit SHA and validation;
- false positive with evidence;
- out of scope with scope rationale and follow-up issue URL;
- valid non-blocking cleanup not fixed by the loop;
- blocker with exact missing data/tool/API state.

Do not say "deferred", "follow-up", or "will address later" until the follow-up issue URL exists. Out-of-scope valid findings must be tracked by a GitHub issue and then triaged outside this loop.

## Handoff Required Fields

```markdown
# AI PR review loop handoff

Provider: <provider>
PR: <owner/repo>#<number>
Latest head: <sha>
Exit reason: <clean | all-non-actionable | non-blocking-only | approval | quality-gate | loop-count | blocker>

## Scope contract

- Linked problem / acceptance criteria:
- In-scope change boundary:
- Explicitly out-of-scope for this loop:

## Findings

- Fixed:
- Rejected / out of scope:
- Follow-up issues created for out-of-scope valid findings:
- Still blocked:

## Validation

- Focused:
- Full:
- CI: include authoritative checks used for loop control and any ignored checks observed

## Review-fix verification

- Inline comments fetched:
- Issue comments/reviews fetched:
- Reply ledger checked:
- Feedback ledger checked: <yes — N comments rated>
- Follow-up ledger checked: <yes — N out-of-scope issues created | none>
- Local CodeRabbit precheck verification (CodeRabbit provider only): <documented before PR | recovered post-PR | not applicable>
- Provider approval/no-actionable signal:

## Worktree

<git status --short --branch>
```
