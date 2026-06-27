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
> "$SCORES_LOG"
> "$QUALITY_LOG"
> "$PROGRESS_LOG"
> "$REPLIED_LOG"
> "$FEEDBACK_LOG"
```

`REPLIED_LOG` is the inline-reply idempotency ledger. Before posting any reply, check:

```bash
grep -qx "$COMMENT_ID" "$REPLIED_LOG" && echo "already replied: $COMMENT_ID" && continue
```

Append the ID only after a successful reply API call.

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
6. Read cited code and classify every finding:
   - `1.0` real actionable defect;
   - `0.7` valid cleanup but non-blocking / not necessary for this PR;
   - `0.3` out of scope;
   - `0.0` false positive/stale/wrong.
7. Append classification JSON lines to `QUALITY_LOG`.
8. **Rate each finding using provider feedback mechanism** (mandatory). If the provider exposes feedback controls on its comments (e.g. checkboxes, reactions), mark each classified finding per the provider file's Feedback section. Use `FEEDBACK_LOG` for idempotency.
9. Apply post-triage quality gate.
10. Reply immediately to non-actionable findings using provider reply endpoint.
11. Fix actionable findings only after the quality gate passes.
12. Run focused validation and repo-required validation.
13. Commit/push fixes.
14. Reply to fixed actionable findings with commit SHA and `CI: pending`.
15. Wait for CI. If red, investigate and hand off as blocker. Do not classify provider rate limits as CI failure or review blocker unless the provider-specific wait/retry budget is exhausted.
16. Append one progress line and write/update HANDOFF.
17. Stop when loop count is exhausted, provider approval is present, zero findings are present, or quality declines.

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

Stop without fixing if all selected findings are `<= 0.3` or if round average is `<= 0.5`. Reply to non-actionable findings first, then write HANDOFF. Do not fix low-value suggestions just because they are easy.

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
- out of scope with scope rationale;
- blocker with exact missing data/tool/API state.

Do not say "deferred" without the provider/repo policy allowing it. If the provider requires issue URLs for deferrals, create the issue before mentioning it.

## Handoff Required Fields

```markdown
# AI PR review loop handoff

Provider: <provider>
PR: <owner/repo>#<number>
Latest head: <sha>
Exit reason: <clean | all-non-actionable | approval | quality-gate | loop-count | blocker>

## Findings

- Fixed:
- Rejected / out of scope:
- Still blocked:

## Validation

- Focused:
- Full:
- CI:

## Review-fix verification

- Inline comments fetched:
- Issue comments/reviews fetched:
- Reply ledger checked:
- Feedback ledger checked: <yes — N comments rated>
- Local CodeRabbit precheck verification (CodeRabbit provider only): <documented before PR | recovered post-PR | not applicable>
- Provider approval/no-actionable signal:

## Worktree

<git status --short --branch>
```
