<!-- markdownlint-disable MD013 -->

# Provider: GitHub Enterprise / Hyperspace AI Review Bot

## Identity

- Provider name: `ghe-pr-bot`
- Bot family: Hyperspace AI review bot / Enterprise PR-Bot
- API base: Enterprise host `/api/v3` (for known Concur repos: `https://github.concur.com/api/v3`)
- Review trigger issue comment: `/review`
- Session prefix: `ai-pr-review-loop-ghe-pr-bot-<PR>-<timestamp>`

## Preflight Rules

Unresolved thread means a root inline comment has no threaded reply. GHE inline discussion APIs can be inconsistent; if the user supplies a `#discussion_r...` URL, treat it as proof the inline discussion exists even if a relative `gh api /repos/...` endpoint returns 404.

Readiness signal is a current-head/current-epoch bot comment indicating the PR is good enough / has no actionable findings. This provider does **not** use formal GitHub `APPROVED` reviews as its ready signal.

Accept comment text only when it is from the Hyperspace/PR-Bot identity and clearly says one of:

- `good enough`
- `no actionable findings`
- `ready to merge`
- `LGTM`
- `approved` in a sentence that is not part of a control panel or command list

Exclude PR-Bot control-panel comments from approval detection. They contain review-ish words and create false approvals.

A human reply to a bot thread, including a reply that says a finding was fixed, is **not** a readiness signal. After a `1.0` finding is fixed and pushed, if the loop budget remains and there is no current-head bot approval/no-actionable comment, preflight should trigger another `/review` once all known bot threads have replies.

## CI Status Override

For this GHE provider, the external `SonarQube` status check is non-authoritative for loop control. It is known to be broken/stale in some repositories and must not block review-loop continuation, readiness, or handoff exit reason.

Ignored/non-authoritative CI check names:

- `SonarQube`

Still report the ignored check state in HANDOFF, but do not wait on it and do not treat its pending/skipping/neutral/failure state as a blocker. The authoritative checks are the repository's real build/test/lint/smoke/scan checks after filtering the ignored names.

## APIs

Derive or set:

```bash
GHE_API="${API_BASE:-https://github.concur.com/api/v3}"
```

Always prefer full Enterprise API URLs:

```bash
gh api "$GHE_API/repos/$OWNER_REPO/pulls/$PR/comments" --paginate --slurp | jq '[.[][]]' > "$INLINE_COMMENTS_JSON"
gh api "$GHE_API/repos/$OWNER_REPO/issues/$PR/comments" --paginate --slurp | jq '[.[][]]' > "$ISSUE_COMMENTS_JSON"
gh pr view "$PR" --json reviews,comments,statusCheckRollup,headRefOid > "$PR_VIEW_JSON"
```

Reply inline:

```bash
gh api -X POST "$GHE_API/repos/$OWNER_REPO/pulls/$PR/comments/$COMMENT_ID/replies" -f body="$BODY"
```

Trigger review:

```bash
gh api -X POST "$GHE_API/repos/$OWNER_REPO/issues/$PR/comments" -f body="/review" >/dev/null
```

## Wait Rules

Poll for a new review or new root inline comments after trigger epoch. Do not post multiple `/review` comments in rapid succession.

## Finding Sources

Classify:

- root inline comments created after trigger;
- older root inline comments with no threaded reply;
- actionable review-body bullets if the provider posts them outside inline comments.

## Deferral Policy

Do not write `deferred`, `follow-up`, or `will address later` unless a concrete issue URL is created in the same action. Valid out-of-scope findings must get a follow-up GitHub issue, then be triaged outside the review loop. False positives do not need follow-up issues; reply with evidence instead.

## Feedback (Mandatory)

Every bot inline comment has a feedback section between `<!-- PR-Bot Feedback-Section-Start -->` and `<!-- PR-Bot Feedback-Section-End -->` markers. After classifying each finding, edit the comment body to check exactly one feedback checkbox.

Mapping from quality score to checkbox:

| Quality | Checkbox to check |
|---------|-------------------|
| `1.0` (real defect) | `<!-- PR-Bot Feedback Awesome -->` |
| `0.7` (valid cleanup) | `<!-- PR-Bot Feedback Helpful -->` |
| `0.3` (out of scope) | `<!-- PR-Bot Feedback Neutral -->` |
| `0.0` (false positive) | `<!-- PR-Bot Feedback Not helpful -->` |

Procedure for each classified comment:

1. Check `FEEDBACK_LOG` — skip if comment ID already recorded.
2. Fetch current comment body:
   ```bash
   CURRENT_BODY=$(gh api "$GHE_API/repos/$OWNER_REPO/pulls/comments/$COMMENT_ID" --jq '.body')
   ```
3. Replace `- [ ] <!-- PR-Bot Feedback $LABEL -->` with `- [x] <!-- PR-Bot Feedback $LABEL -->` where `$LABEL` matches the quality mapping above.
4. PATCH the comment:
   ```bash
   gh api -X PATCH "$GHE_API/repos/$OWNER_REPO/pulls/comments/$COMMENT_ID" -f body="$UPDATED_BODY"
   ```
5. Append comment ID to `FEEDBACK_LOG`.

Do this immediately after classification at the Round Order feedback step, before replying or fixing. This is not optional — every finding must be rated.

Feedback acknowledgements are not readiness signals. The provider may rewrite the checkbox block into text such as "Thank you for submitting your feedback"; do not parse that text for loop continuation. Continue/stop decisions come from the worker's internal quality score, current-head provider approval/no-actionable signals, zero selected findings, quality-gate rules, and loop budget.
