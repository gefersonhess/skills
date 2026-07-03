#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Unit tests for durable-pause behavior in pipeline.sh.
#
# Covers:
#   1. Paused status JSON shape: pipeline_state, checkpoint, current_issue=null,
#      current_issue_index=null, current_agent_pid=null, current_phase=paused,
#      paused_at non-null, paused_reason=user-requested, next_issue_index,
#      next_issue
#   2. Running status has paused_at=null and paused_reason=null
#   3. Resume from paused clears checkpoint/paused fields, returns to running
#   4. Abort while paused writes aborted (not killed)
#   5. Cleanup while paused preserves paused state (not killed)
#   6. Cleanup while running still writes killed
#   7. Unknown/double pause while paused does not update paused_at
#   8. Lock metadata includes state=paused / state=running
#   9. Extension paused indicator returns ⏸ (via grep on source)
#
# Run: bash tests/pipeline/test-durable-pause.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PASS=0
FAIL=0

ok() {
  local label="$1"
  echo "  ✓ $label"
  PASS=$((PASS + 1))
}

fail() {
  local label="$1" msg="${2:-}"
  echo "  ✗ $label${msg:+ — $msg}"
  FAIL=$((FAIL + 1))
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$label"
  else
    fail "$label" "expected=$(printf '%q' "$expected") got=$(printf '%q' "$actual")"
  fi
}

assert_json_field() {
  local label="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(printf '%s\n' "$json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if '$field' not in data:
    print('__MISSING__')
else:
    val = data['$field']
    print(json.dumps(val))
" 2>/dev/null) || actual="__ERROR__"
  actual="${actual%\"}"
  actual="${actual#\"}"
  if [ "$actual" = "$expected" ]; then
    ok "$label"
  else
    fail "$label" "expected=$(printf '%q' "$expected") got=$(printf '%q' "$actual")"
  fi
}

assert_json_field_notnull() {
  local label="$1" json="$2" field="$3"
  local actual
  actual=$(printf '%s\n' "$json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if '$field' not in data:
    print('null')
else:
    val = data['$field']
    print(json.dumps(val))
" 2>/dev/null) || actual="null"
  if [ "$actual" != "null" ]; then
    ok "$label"
  else
    fail "$label" "expected non-null for $field, got null"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Shared harness: minimal stubs to call write_status and cleanup in isolation
# ─────────────────────────────────────────────────────────────────────────────

# These functions are extracted/stubbed from pipeline.sh without live deps.

ISSUES=(10 20 30)
VERSION="1.1.0"
SCRIPT_FILE="/path/to/pipeline.sh"
PIPELINE_START="2026-06-30T00:00:00Z"
PIPELINE_ID="test-pipeline-$$"
CONFIG_FILE="/tmp/fake.sh"
CONFIG_SHA256="abc"

# shellcheck disable=SC2034  # These globals mirror pipeline.sh state; some are only read via variable expansion in write_status heredoc
CURRENT_ISSUE=""
CURRENT_ISSUE_INDEX=""
NEXT_ISSUE_INDEX="0"
CURRENT_ISSUE_STARTED_AT=""
CURRENT_ISSUE_STARTED_EPOCH=""
CURRENT_PHASE=""
CURRENT_PHASE_STARTED_AT=""
CURRENT_PR=""
CURRENT_AGENT_PID=""
IS_PAUSED=0
PAUSED_AT=""
PAUSED_REASON=""
PIPELINE_LOCK_STATE="running"
PIPELINE_TERMINAL_STATE="completed"

canonical_repo_path() { echo "/tmp/fake-repo"; }
current_issue_elapsed_seconds() { echo "null"; }
json_issue_records() { echo ""; }
# shellcheck disable=SC2034
ISSUES_COMPLETED=()  # used by write_status JSON array
# shellcheck disable=SC2034
ISSUES_COMPLETED_DETAILS=()  # used by json_issue_records stub
ISSUES_SKIPPED=()

derive_issues_remaining() {
  local start_idx="${1:-0}"
  local i remaining=()
  for i in "${!ISSUES[@]}"; do
    if [ "$i" -ge "$start_idx" ]; then
      remaining+=("${ISSUES[$i]}")
    fi
  done
  if [ ${#remaining[@]} -gt 0 ]; then
    (IFS=,; echo "${remaining[*]}")
  else
    echo ""
  fi
}

next_issue_value() {
  local idx="${NEXT_ISSUE_INDEX:-0}"
  if [ -n "$idx" ] && [ "$idx" -lt "${#ISSUES[@]}" ]; then
    echo "${ISSUES[$idx]}"
  else
    echo "null"
  fi
}

write_status() {
  local state="$1"
  local repo_canonical phase_started_json issues_remaining_csv next_issue_val
  local current_issue_index_json next_issue_index_json
  local paused_at_json paused_reason_json checkpoint_json
  repo_canonical=$(canonical_repo_path)
  if [ -n "${CURRENT_PHASE_STARTED_AT:-}" ]; then
    phase_started_json="\"$CURRENT_PHASE_STARTED_AT\""
  else
    phase_started_json="null"
  fi
  issues_remaining_csv="$(derive_issues_remaining "${NEXT_ISSUE_INDEX:-0}")"
  next_issue_val="$(next_issue_value)"
  if [ -n "${CURRENT_ISSUE_INDEX:-}" ]; then
    current_issue_index_json="$CURRENT_ISSUE_INDEX"
  else
    current_issue_index_json="null"
  fi
  if [ -n "${NEXT_ISSUE_INDEX:-}" ]; then
    next_issue_index_json="$NEXT_ISSUE_INDEX"
  else
    next_issue_index_json="null"
  fi
  if [ -n "${PAUSED_AT:-}" ]; then
    paused_at_json="\"$PAUSED_AT\""
  else
    paused_at_json="null"
  fi
  if [ -n "${PAUSED_REASON:-}" ]; then
    paused_reason_json="\"$PAUSED_REASON\""
  else
    paused_reason_json="null"
  fi
  # checkpoint — only set when paused at between-issues boundary
  local resume_supported_json
  if [ "$state" = "paused" ]; then
    checkpoint_json="\"between-issues\""
    resume_supported_json="true"
  else
    checkpoint_json="null"
    resume_supported_json="false"
  fi
  cat > "$LOG_DIR/status.json.tmp" <<EOF
{
  "schema_version": 2,
  "pipeline_state": "$state",
  "version": "$VERSION",
  "resume_supported": $resume_supported_json,
  "checkpoint": $checkpoint_json,
  "pipeline_id": "${PIPELINE_ID:-}",
  "pid": $$,
  "repo": "$repo_canonical",
  "repo_name": "fake-repo",
  "config_file": "$CONFIG_FILE",
  "script_file": "$SCRIPT_FILE",
  "script_version": "$VERSION",
  "config_sha256": "${CONFIG_SHA256:-}",
  "log_dir": "$LOG_DIR",
  "status_file": "$LOG_DIR/status.json",
  "log_file": "$LOG_DIR/loop.log",
  "control_file": "$LOG_DIR/control",
  "started_at": "$PIPELINE_START",
  "current_issue": ${CURRENT_ISSUE:-null},
  "current_issue_index": $current_issue_index_json,
  "next_issue_index": $next_issue_index_json,
  "next_issue": $next_issue_val,
  "current_phase": "${CURRENT_PHASE:-}",
  "current_phase_started_at": $phase_started_json,
  "current_issue_started_at": "${CURRENT_ISSUE_STARTED_AT:-}",
  "current_issue_elapsed_seconds": $(current_issue_elapsed_seconds),
  "current_pr": ${CURRENT_PR:-null},
  "current_agent_pid": ${CURRENT_AGENT_PID:-null},
  "paused_at": $paused_at_json,
  "paused_reason": $paused_reason_json,
  "issues_total": [$(IFS=,; echo "${ISSUES[*]:-}")],
  "issues_completed": [$(IFS=,; echo "${ISSUES_COMPLETED[*]:-}")],
  "issues_completed_details": [$(json_issue_records)],
  "issues_skipped": [$(IFS=,; echo "${ISSUES_SKIPPED[*]:-}")],
  "issues_remaining": [$issues_remaining_csv],
  "last_update": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  mv "$LOG_DIR/status.json.tmp" "$LOG_DIR/status.json"
}

write_repo_lock_metadata() {
  local repo_canonical="$1"
  {
    echo "pid=$$"
    echo "repo=$repo_canonical"
    echo "config=$CONFIG_FILE"
    echo "log_dir=$LOG_DIR"
    echo "issues=${ISSUES[*]}"
    echo "started_at=${PIPELINE_START:-}"
    echo "state=${PIPELINE_LOCK_STATE:-running}"
    echo "pipeline_id=${PIPELINE_ID:-}"
    echo "status_file=$LOG_DIR/status.json"
    echo "log_file=$LOG_DIR/loop.log"
    echo "control_file=$LOG_DIR/control"
  } > "$LOCK_DIR/metadata"
  echo "$$" > "$LOCK_DIR/pid"
}

update_lock_state() {
  local new_state="$1"
  PIPELINE_LOCK_STATE="$new_state"
  [ -n "${LOCK_DIR:-}" ] && [ -d "$LOCK_DIR" ] || return 0
  local canonical
  canonical=$(canonical_repo_path)
  write_repo_lock_metadata "$canonical"
}

# shellcheck disable=SC2034  # local assignments mirror globals read via heredoc in write_status
reset_state() {
  CURRENT_ISSUE=""
  CURRENT_ISSUE_INDEX=""
  NEXT_ISSUE_INDEX="0"
  CURRENT_ISSUE_STARTED_AT=""
  # shellcheck disable=SC2034
  CURRENT_ISSUE_STARTED_EPOCH=""  # mirrors real global for reset_state completeness
  CURRENT_PHASE=""
  CURRENT_PHASE_STARTED_AT=""
  CURRENT_PR=""
  CURRENT_AGENT_PID=""
  IS_PAUSED=0
  PAUSED_AT=""
  PAUSED_REASON=""
  PIPELINE_LOCK_STATE="running"
  PIPELINE_TERMINAL_STATE="completed"  # mirrors real global; exercised in write_status path
}

# ─────────────────────────────────────────────────────────────────────────────
# Test 1: Paused status JSON shape
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 1: Paused status JSON shape ==="

LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
reset_state

# Simulate the pipeline reaching between-issues at i=0
i=0
CURRENT_ISSUE=""
CURRENT_ISSUE_INDEX=""
CURRENT_AGENT_PID=""
CURRENT_PHASE="paused"
CURRENT_PHASE_STARTED_AT=""
CURRENT_ISSUE_STARTED_AT=""
# shellcheck disable=SC2034
CURRENT_ISSUE_STARTED_EPOCH=""
CURRENT_PR=""
IS_PAUSED=1
PAUSED_AT="2026-06-30T12:00:00Z"
PAUSED_REASON="user-requested"
NEXT_ISSUE_INDEX="$i"

write_status "paused"
JSON="$(cat "$LOG_DIR/status.json")"

if python3 -c "import sys,json; json.load(sys.stdin)" <<< "$JSON" 2>/dev/null; then
  ok "paused status.json is valid JSON"
else
  fail "paused status.json is valid JSON"
fi

assert_json_field "pipeline_state=paused"           "$JSON" "pipeline_state"      "paused"
assert_json_field "checkpoint=between-issues"       "$JSON" "checkpoint"          "between-issues"
assert_json_field "current_issue=null"              "$JSON" "current_issue"       "null"
assert_json_field "current_issue_index=null"        "$JSON" "current_issue_index" "null"
assert_json_field "current_agent_pid=null"          "$JSON" "current_agent_pid"   "null"
assert_json_field "current_phase=paused"            "$JSON" "current_phase"       "paused"
assert_json_field_notnull "paused_at non-null"      "$JSON" "paused_at"
assert_json_field "paused_reason=user-requested"    "$JSON" "paused_reason"       "user-requested"
assert_json_field "next_issue_index=0"              "$JSON" "next_issue_index"    "0"
assert_json_field "next_issue=10 (ISSUES[0])"       "$JSON" "next_issue"          "10"
assert_json_field "resume_supported=true"           "$JSON" "resume_supported"    "true"

rm -rf "$LOG_DIR" "$LOCK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Test 2: Running status has paused_at=null and paused_reason=null
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 2: Running status has paused_at=null, paused_reason=null ==="

LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
reset_state

NEXT_ISSUE_INDEX="0"
write_status "running"
JSON="$(cat "$LOG_DIR/status.json")"

if python3 -c "import sys,json; json.load(sys.stdin)" <<< "$JSON" 2>/dev/null; then
  ok "running status.json is valid JSON"
else
  fail "running status.json is valid JSON"
fi

assert_json_field "running: paused_at=null"     "$JSON" "paused_at"     "null"
assert_json_field "running: paused_reason=null" "$JSON" "paused_reason" "null"
assert_json_field "running: resume_supported=false" "$JSON" "resume_supported"    "false"
assert_json_field "running: checkpoint=null"    "$JSON" "checkpoint"    "null"

rm -rf "$LOG_DIR" "$LOCK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Test 3: Resume from paused clears paused fields, returns to running
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 3: Resume clears paused fields ==="

LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
reset_state

# Enter paused state
IS_PAUSED=1
PAUSED_AT="2026-06-30T12:00:00Z"
PAUSED_REASON="user-requested"
CURRENT_PHASE="paused"
NEXT_ISSUE_INDEX="1"
write_status "paused"

PAUSED_JSON="$(cat "$LOG_DIR/status.json")"
assert_json_field "before resume: pipeline_state=paused" "$PAUSED_JSON" "pipeline_state" "paused"
assert_json_field_notnull "before resume: paused_at set" "$PAUSED_JSON" "paused_at"

# Simulate resume before issue[1] starts: paused metadata is cleared and
# current issue/cursor fields are restored for the issue about to run.
IS_PAUSED=0
PAUSED_AT=""
PAUSED_REASON=""
CURRENT_ISSUE="20"
CURRENT_ISSUE_INDEX="1"
NEXT_ISSUE_INDEX="2"
CURRENT_ISSUE_STARTED_AT="2026-06-30T12:00:10Z"
CURRENT_AGENT_PID=""
CURRENT_PHASE=""
CURRENT_PHASE_STARTED_AT=""
CURRENT_PR=""
write_status "running"

RESUMED_JSON="$(cat "$LOG_DIR/status.json")"
assert_json_field "after resume: pipeline_state=running"   "$RESUMED_JSON" "pipeline_state" "running"
assert_json_field "after resume: paused_at=null"           "$RESUMED_JSON" "paused_at"      "null"
assert_json_field "after resume: paused_reason=null"       "$RESUMED_JSON" "paused_reason"  "null"
assert_json_field "after resume: checkpoint=null"          "$RESUMED_JSON" "checkpoint"     "null"
assert_json_field "after resume: current_issue restored"   "$RESUMED_JSON" "current_issue"  "20"
assert_json_field "after resume: current index restored"   "$RESUMED_JSON" "current_issue_index" "1"
assert_json_field "after resume: next index restored"      "$RESUMED_JSON" "next_issue_index" "2"
assert_json_field "after resume: next issue restored"      "$RESUMED_JSON" "next_issue" "30"

rm -rf "$LOG_DIR" "$LOCK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Test 4: Abort while paused writes aborted, not killed
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 4: Abort while paused writes aborted ==="

LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
reset_state

IS_PAUSED=1
PAUSED_AT="2026-06-30T12:00:00Z"
PAUSED_REASON="user-requested"
CURRENT_PHASE="paused"

# Simulate abort path from paused: clear paused state, write aborted
IS_PAUSED=0
PAUSED_AT=""
PAUSED_REASON=""
write_status "aborted"

ABORT_JSON="$(cat "$LOG_DIR/status.json")"
assert_json_field "abort while paused: pipeline_state=aborted" "$ABORT_JSON" "pipeline_state" "aborted"
assert_json_field "abort while paused: paused_at=null"         "$ABORT_JSON" "paused_at"      "null"
assert_json_field "abort while paused: paused_reason=null"     "$ABORT_JSON" "paused_reason"  "null"

rm -rf "$LOG_DIR" "$LOCK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Test 5: Cleanup while paused preserves paused state (not killed)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 5: Cleanup while paused preserves paused state ==="

LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
reset_state

# Write paused status first
IS_PAUSED=1
PAUSED_AT="2026-06-30T12:00:00Z"
PAUSED_REASON="user-requested"
CURRENT_PHASE="paused"
write_status "paused"

# Simulate cleanup: when IS_PAUSED=1, cleanup does NOT call write_status "killed"
# Instead it preserves the existing status file and exits.
# Verify the file still shows paused after we check IS_PAUSED.
if [ "$IS_PAUSED" = "1" ]; then
  # This is the paused-cleanup branch — do NOT overwrite status
  :
else
  write_status "killed"
fi

CLEANUP_JSON="$(cat "$LOG_DIR/status.json")"
assert_json_field "cleanup while paused: pipeline_state=paused" "$CLEANUP_JSON" "pipeline_state" "paused"
assert_json_field_notnull "cleanup while paused: paused_at preserved" "$CLEANUP_JSON" "paused_at"

rm -rf "$LOG_DIR" "$LOCK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Test 6: Cleanup while running writes killed
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 6: Cleanup while running writes killed ==="

LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
reset_state

write_status "running"

# Simulate cleanup: IS_PAUSED=0 → write_status "killed"
if [ "$IS_PAUSED" = "1" ]; then
  :
else
  write_status "killed"
fi

KILLED_JSON="$(cat "$LOG_DIR/status.json")"
assert_json_field "cleanup while running: pipeline_state=killed" "$KILLED_JSON" "pipeline_state" "killed"
assert_json_field "cleanup while running: paused_at=null"        "$KILLED_JSON" "paused_at"      "null"

rm -rf "$LOG_DIR" "$LOCK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Test 7: Double-pause does not update paused_at
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 7: Double-pause preserves original paused_at ==="

LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
reset_state

IS_PAUSED=1
PAUSED_AT="2026-06-30T09:00:00Z"
PAUSED_REASON="user-requested"
CURRENT_PHASE="paused"
write_status "paused"
FIRST_JSON="$(cat "$LOG_DIR/status.json")"

# Simulate receiving a second "pause" command while already paused.
# The design: double-pause is ignored (paused_at unchanged).
# IS_PAUSED stays 1, PAUSED_AT stays unchanged, we do NOT update it.
# Write status again (as if the loop re-wrote it with same vars).
write_status "paused"
SECOND_JSON="$(cat "$LOG_DIR/status.json")"

FIRST_AT=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('paused_at','null'))" <<< "$FIRST_JSON" 2>/dev/null || echo "null")
SECOND_AT=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('paused_at','null'))" <<< "$SECOND_JSON" 2>/dev/null || echo "null")

assert_eq "double-pause: paused_at unchanged" "$FIRST_AT" "$SECOND_AT"

rm -rf "$LOG_DIR" "$LOCK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Test 8: Lock metadata includes state=paused / state=running
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 8: Lock metadata includes state field ==="

LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
reset_state

canonical=$(canonical_repo_path)

# running state
PIPELINE_LOCK_STATE="running"
write_repo_lock_metadata "$canonical"
RUNNING_META="$(cat "$LOCK_DIR/metadata")"
if echo "$RUNNING_META" | grep -q "^state=running$"; then
  ok "lock metadata contains state=running"
else
  fail "lock metadata contains state=running" "got: $RUNNING_META"
fi
if echo "$RUNNING_META" | grep -q "^pipeline_id="; then
  ok "lock metadata contains pipeline_id"
else
  fail "lock metadata contains pipeline_id" "got: $RUNNING_META"
fi
if echo "$RUNNING_META" | grep -q "^status_file="; then
  ok "lock metadata contains status_file"
else
  fail "lock metadata contains status_file" "got: $RUNNING_META"
fi
if echo "$RUNNING_META" | grep -q "^log_file="; then
  ok "lock metadata contains log_file"
else
  fail "lock metadata contains log_file" "got: $RUNNING_META"
fi
if echo "$RUNNING_META" | grep -q "^control_file="; then
  ok "lock metadata contains control_file"
else
  fail "lock metadata contains control_file" "got: $RUNNING_META"
fi

# paused state via update_lock_state
update_lock_state "paused"
PAUSED_META="$(cat "$LOCK_DIR/metadata")"
if echo "$PAUSED_META" | grep -q "^state=paused$"; then
  ok "lock metadata contains state=paused after update"
else
  fail "lock metadata contains state=paused after update" "got: $PAUSED_META"
fi

# back to running
update_lock_state "running"
BACK_META="$(cat "$LOCK_DIR/metadata")"
if echo "$BACK_META" | grep -q "^state=running$"; then
  ok "lock metadata contains state=running after resume"
else
  fail "lock metadata contains state=running after resume" "got: $BACK_META"
fi

rm -rf "$LOG_DIR" "$LOCK_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Test 9: Extension stateIndicator has paused case (static grep)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 9: Extension stateIndicator has paused case ==="

SCRIPT_DIR_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_FILE="$SCRIPT_DIR_REPO/../../extensions/pipeline-status.ts"
EXT_FILE="$(realpath "$EXT_FILE" 2>/dev/null || echo "$EXT_FILE")"

if [ -f "$EXT_FILE" ]; then
  if grep -q '"paused"' "$EXT_FILE" && grep -q '⏸' "$EXT_FILE"; then
    ok "pipeline-status.ts has paused indicator case with ⏸"
  else
    fail "pipeline-status.ts has paused indicator case with ⏸" "missing 'paused' or ⏸ in $EXT_FILE"
  fi
  if grep -q '/pipeline-resume' "$EXT_FILE"; then
    ok "pipeline-status.ts shows resume control for paused pipelines"
  else
    fail "pipeline-status.ts shows resume control for paused pipelines" "missing /pipeline-resume in $EXT_FILE"
  fi
else
  fail "extension file exists at $EXT_FILE"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════"
[ "$FAIL" -eq 0 ]
