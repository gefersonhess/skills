#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2317
# SC2034: this test sets globals consumed indirectly by sourced pipeline.sh functions.
# SC2317: this test deliberately stubs commands such as sleep/gh for indirect calls.
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Tests for implementation-pipeline poll interval configuration.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIPELINE_SH="$REPO_ROOT/skills/implementation-pipeline/pipeline.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0

ok() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1${2:+ — $2}"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$label"
  else
    fail "$label" "expected=$(printf '%q' "$expected") got=$(printf '%q' "$actual")"
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    ok "$label"
  else
    fail "$label" "expected to contain $(printf '%q' "$needle"), got $(printf '%q' "$haystack")"
  fi
}

# Source the real script in library mode.
export PIPELINE_LIB_MODE=1
# shellcheck source=/dev/null
source "$PIPELINE_SH"

# Keep test output quiet when functions call log().
log() { :; }

make_fake_path() {
  local bin_dir="$TMP_DIR/bin"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/pi" <<'SH'
#!/usr/bin/env sh
exit 0
SH
  cat > "$bin_dir/gh" <<'SH'
#!/usr/bin/env sh
exit 0
SH
  chmod +x "$bin_dir/pi" "$bin_dir/gh"
  PATH="$bin_dir:$PATH"
  export PATH
}

make_git_repo() {
  local repo="$TMP_DIR/repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  echo "$repo"
}

set_valid_config_globals() {
  REPO="$(make_git_repo)"
  WORKTREE_BASE="$TMP_DIR/worktrees"
  OWNER_REPO="owner/repo"
  AI_REVIEW_PROVIDER="ghe-pr-bot"
  AI_REVIEW_API_BASE="https://github.concur.com/api/v3"
  ISSUES=(1)
  BRANCHES=(issue-1)
  MERGE_STRATEGY="squash"
  TIMEOUT_IMPL="2400"
  TIMEOUT_REVIEW="1200"
  TIMEOUT_BOT="7200"
  TIMEOUT_CI="600"
  TIMEOUT_GATE="120"
  SKIP_REVIEW="0"
  SKIP_BOT="0"
  SKIP_SCOPE_GATE="0"
  NO_MERGE="0"
  CONTINUE_ON_FAILURE="0"
  ALLOW_CONCURRENT_REPO_PIPELINES="0"
  HANDOFF_POLL_SECONDS="5"
  CI_POLL_SECONDS="10"
  PAUSE_POLL_SECONDS="2"
  DEAD_AGENT_FLUSH_SECONDS="2"
  FINAL_STATUS_SETTLE_SECONDS="0"
}

run_validate_config() {
  local stderr_file="$TMP_DIR/validate-stderr-$RANDOM.txt"
  if validate_config 2>"$stderr_file"; then
    cat "$stderr_file"
    return 0
  fi
  cat "$stderr_file"
  return 1
}

make_fake_path

# ── Validation behavior ─────────────────────────────────────────────────────
echo ""
echo "=== validate_config poll interval checks ==="

set_valid_config_globals
if out=$(run_validate_config); then
  ok "valid explicit poll interval values pass validation"
else
  fail "valid explicit poll interval values pass validation" "$out"
fi

set_valid_config_globals
HANDOFF_POLL_SECONDS="0"
if out=$(run_validate_config); then
  fail "HANDOFF_POLL_SECONDS=0 is rejected" "validation unexpectedly passed"
else
  assert_contains "HANDOFF_POLL_SECONDS=0 error names variable" "$out" "HANDOFF_POLL_SECONDS"
fi

set_valid_config_globals
CI_POLL_SECONDS="abc"
if out=$(run_validate_config); then
  fail "CI_POLL_SECONDS=abc is rejected" "validation unexpectedly passed"
else
  assert_contains "CI_POLL_SECONDS=abc error names variable" "$out" "CI_POLL_SECONDS"
fi

set_valid_config_globals
PAUSE_POLL_SECONDS="-1"
if out=$(run_validate_config); then
  fail "PAUSE_POLL_SECONDS=-1 is rejected" "validation unexpectedly passed"
else
  assert_contains "PAUSE_POLL_SECONDS=-1 error names variable" "$out" "PAUSE_POLL_SECONDS"
fi

set_valid_config_globals
DEAD_AGENT_FLUSH_SECONDS="1.5"
if out=$(run_validate_config); then
  fail "DEAD_AGENT_FLUSH_SECONDS=1.5 is rejected" "validation unexpectedly passed"
else
  assert_contains "DEAD_AGENT_FLUSH_SECONDS=1.5 error names variable" "$out" "DEAD_AGENT_FLUSH_SECONDS"
fi

set_valid_config_globals
FINAL_STATUS_SETTLE_SECONDS="0"
if out=$(run_validate_config); then
  ok "FINAL_STATUS_SETTLE_SECONDS=0 is accepted"
else
  fail "FINAL_STATUS_SETTLE_SECONDS=0 is accepted" "$out"
fi

set_valid_config_globals
FINAL_STATUS_SETTLE_SECONDS="-1"
if out=$(run_validate_config); then
  fail "FINAL_STATUS_SETTLE_SECONDS=-1 is rejected" "validation unexpectedly passed"
else
  assert_contains "FINAL_STATUS_SETTLE_SECONDS=-1 error names variable" "$out" "FINAL_STATUS_SETTLE_SECONDS"
fi

# ── wait_for_handoff behavior ───────────────────────────────────────────────
echo ""
echo "=== wait_for_handoff poll interval checks ==="

sleep_log="$TMP_DIR/sleep-handoff.log"
handoff_file="$TMP_DIR/handoff.md"
rm -f "$sleep_log" "$handoff_file"
HANDOFF_POLL_SECONDS="3"
DEAD_AGENT_FLUSH_SECONDS="2"
sleep() {
  echo "$1" >> "$sleep_log"
  if [ "$(wc -l < "$sleep_log")" -eq 1 ]; then
    echo "done" > "$handoff_file"
  fi
}
if wait_for_handoff "$handoff_file" 9; then
  assert_eq "wait_for_handoff sleeps with HANDOFF_POLL_SECONDS" "3" "$(cat "$sleep_log")"
else
  fail "wait_for_handoff should detect handoff after first configured sleep"
fi
unset -f sleep

sleep_log="$TMP_DIR/sleep-dead-agent.log"
handoff_file="$TMP_DIR/dead-agent-handoff.md"
rm -f "$sleep_log" "$handoff_file"
HANDOFF_POLL_SECONDS="3"
DEAD_AGENT_FLUSH_SECONDS="2"
sleep() {
  echo "$1" >> "$sleep_log"
  echo "flushed" > "$handoff_file"
}
if wait_for_handoff "$handoff_file" 9 999999; then
  assert_eq "dead agent flush uses DEAD_AGENT_FLUSH_SECONDS" "2" "$(cat "$sleep_log")"
else
  fail "wait_for_handoff should accept handoff written during dead-agent flush"
fi
unset -f sleep

# ── wait_for_ci behavior ────────────────────────────────────────────────────
echo ""
echo "=== wait_for_ci poll interval checks ==="

sleep_log="$TMP_DIR/sleep-ci.log"
gh_calls="$TMP_DIR/gh-calls.txt"
rm -f "$sleep_log" "$gh_calls"
CI_POLL_SECONDS="7"
AI_REVIEW_PROVIDER="ghe-pr-bot"
gh() {
  echo call >> "$gh_calls"
  if [ "$(wc -l < "$gh_calls")" -eq 1 ]; then
    printf '{"statusCheckRollup":[{"name":"PR Build","status":"IN_PROGRESS"}]}'
  else
    printf '{"statusCheckRollup":[{"name":"PR Build","status":"COMPLETED","conclusion":"SUCCESS"}]}'
  fi
}
sleep() { echo "$1" >> "$sleep_log"; }
ci_result=$(wait_for_ci 123 20 2>/dev/null || true)
assert_eq "wait_for_ci returns zero failures after pending clears" "0" "$ci_result"
assert_eq "wait_for_ci sleeps with CI_POLL_SECONDS" "7" "$(cat "$sleep_log")"
unset -f gh sleep

# ── final status settle behavior ────────────────────────────────────────────
echo ""
echo "=== final_status_settle checks ==="

sleep_log="$TMP_DIR/sleep-final-zero.log"
rm -f "$sleep_log"
FINAL_STATUS_SETTLE_SECONDS="0"
sleep() { echo "$1" >> "$sleep_log"; }
final_status_settle
if [ ! -s "$sleep_log" ]; then
  ok "FINAL_STATUS_SETTLE_SECONDS=0 does not call sleep"
else
  fail "FINAL_STATUS_SETTLE_SECONDS=0 does not call sleep" "sleep log: $(cat "$sleep_log")"
fi
unset -f sleep

sleep_log="$TMP_DIR/sleep-final-three.log"
rm -f "$sleep_log"
FINAL_STATUS_SETTLE_SECONDS="3"
sleep() { echo "$1" >> "$sleep_log"; }
final_status_settle
assert_eq "FINAL_STATUS_SETTLE_SECONDS=3 sleeps for 3 seconds" "3" "$(cat "$sleep_log")"
unset -f sleep

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
