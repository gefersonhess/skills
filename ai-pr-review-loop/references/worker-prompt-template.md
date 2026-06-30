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
- The provider produces zero selected findings for the current head after a review/preflight result.
- All findings in a round are false positives, out of scope with follow-up issues created, non-blocking only, or quality declines per worker-mode gate.
- A current-head explicit approval/no-actionable signal appears.
- The requested loop budget is exhausted after completing the required fix/reply/CI work.

A round that fixes a real actionable finding is not clean. After any `1.0` finding is fixed, validated, pushed, and replied to, continue to the next round if loop budget remains. Use the worker's internal quality classification for this decision; provider feedback acknowledgements are reporting artifacts only and must not control loop termination.

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
7. Establish the PR Scope Contract from the linked issue, PR body, acceptance criteria, and current diff; keep the loop focused on that problem.
8. Classify all selected findings by quality and verify each against actual code before fixing. Treat valid findings outside the Scope Contract as `0.3` out of scope.
9. For every out-of-scope valid finding, create/link a GitHub issue, reply with the issue URL, and leave triage/implementation outside this loop.
10. Rate every classified finding via the provider's feedback mechanism (see provider file Feedback section). FEEDBACK_LOG must not be empty at session end. This records feedback only; loop continuation is controlled by internal quality classification plus provider preflight, not by feedback acknowledgement text.
11. Run the post-triage quality gate before writing fixes.
12. Reply inline to non-actionable findings immediately after classification.
13. For in-scope real defects, add/update tests or documented validation, fix, run focused validation and repo-required validation, push, then reply inline with commit SHA and `CI: pending`.
14. Wait for acceptable CI on latest head using worker-mode/provider CI status rules. Do not let provider-listed ignored checks control readiness. If an authoritative check fails, investigate and write HANDOFF with blocker.
15. Apply the worker-mode Loop-Continuation Gate: fixed in-scope `1.0` findings require another round when loop budget remains; approval/zero findings/non-blocking-only/quality decline may stop.
16. Write HANDOFF with provider, latest head, scope contract, fixed findings, rejected findings, follow-up issues, validation, authoritative CI state, ignored CI checks observed, local CodeRabbit precheck verification, review-fix verification, worktree cleanliness, and unresolved risks.
17. If blocked, still write HANDOFF.
```
