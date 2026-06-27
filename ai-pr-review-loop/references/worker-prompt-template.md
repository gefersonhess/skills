<!-- markdownlint-disable MD013 -->

# Worker Prompt Template

Write this content verbatim to `/tmp/<SESSION_ID>-prompt.md`, substituting all bracketed values.

---

```text
/skill:ai-pr-review-loop worker mode

You are the worker pi instance for the unified AI PR review loop. Do not spawn another pi instance. Do the review-fix work and write detailed results to HANDOFF.

Provider: <PROVIDER>
Provider file: <PROVIDER_FILE>

Task: run <LOOP_COUNT> preflight-first AI PR review loop(s) for PR #<PR> and address actionable items. Do not trigger a new review unless preflight says one is required. Loop count options: 1, 3, 5, or "until clean" with hard cap 8.

Success condition: stop successfully when one is true:
- The provider produces zero new findings.
- All findings in a round are false positives or out of scope.
- A current-head explicit approval/no-actionable signal appears.

Inputs:
- WORKTREE: <absolute path>
- PR: <number>
- OWNER_REPO: <owner/repo>
- PROVIDER: <PROVIDER>
- API_BASE: <API_BASE>
- SESSION_ID: <session id>
- LOG: <log path>
- HANDOFF: <handoff path>

Worker requirements:
0. Load references/worker-mode.md and <PROVIDER_FILE> before acting.
1. Append round progress to `/tmp/<SESSION_ID>-progress.log`: round number, findings count, avg quality, action.
2. Work only in WORKTREE.
3. Rehydrate current state first: git status, gh pr view including PR body, provider inline-comment API, provider review/comment bodies.
4. For CodeRabbit provider, verify/document the local CodeRabbit CLI precheck before remote trigger. If missing, run `coderabbit doctor` and `coderabbit review --agent --type committed --base <base>` as a fallback first, fix real findings, and record the result in a PR comment/body and HANDOFF.
5. Use provider preflight rules to decide whether unresolved comments, approval, or review trigger is next.
6. Trigger exactly one provider review only when preflight says it is required.
7. Classify all selected findings by quality and verify each against actual code before fixing.
8. Rate every classified finding via the provider's feedback mechanism (see provider file Feedback section). FEEDBACK_LOG must not be empty at session end.
9. Run the post-triage quality gate before writing fixes.
10. Reply inline to non-actionable findings immediately after classification.
11. For real defects, add/update tests or documented validation, fix, run focused validation and repo-required validation, push, then reply inline with commit SHA and `CI: pending`.
12. Wait for CI on latest head. If CI fails, investigate and write HANDOFF with blocker.
13. Write HANDOFF with provider, latest head, fixed findings, rejected findings, validation, CI state, local CodeRabbit precheck verification, review-fix verification, worktree cleanliness, and unresolved risks.
14. If blocked, still write HANDOFF.
```
