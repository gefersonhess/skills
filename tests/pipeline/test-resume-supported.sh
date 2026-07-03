#!/usr/bin/env bash
# shellcheck disable=SC2034  # globals consumed via heredoc expansion inside sourced write_status
# ─────────────────────────────────────────────────────────────────────────────
# Focused tests for Phase 3A-beta1: runtime resume eligibility + enriched
# lock metadata.  Sources the real pipeline.sh with PIPELINE_LIB_MODE=1 and
# exercises the real write_status, write_repo_lock_metadata, update_lock_state,
# and validate_resume_status.
#
# Covers:
#   a. real write_status "paused"  → resume_supported=true, checkpoint=between-issues
#   b. real write_status "running","completed","blocked","aborted","killed"
#        → resume_supported=false
#   c. double pause keeps resume_supported=true and paused_at unchanged
#   d. paused then running resets resume_supported=false
#   e. real write_repo_lock_metadata emits pipeline_id/status_file/log_file/
#        control_file and preserves old fields
#   f. update_lock_state "paused" preserves those fields
#   g. a real paused status produced by write_status passes validate_resume_status
#        when config sha matches and resume_supported=true
#
# Run: bash tests/pipeline/test-resume-supported.sh
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
# Source real pipeline.sh in lib mode
# ─────────────────────────────────────────────────────────────────────────────

PIPELINE_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/skills/implementation-pipeline/pipeline.sh"

LOG_DIR="$(mktemp -d)"
PIPELINE_LOCK_DIR="$(mktemp -d)"
export PIPELINE_LIB_MODE=1

# Provide minimal globals required by pipeline.sh top-level set -u checks
ISSUES=(10 20 30)
ISSUES_COMPLETED=()
ISSUES_COMPLETED_DETAILS=()
ISSUES_SKIPPED=()
VERSION="1.1.0"
SCRIPT_FILE="/path/to/pipeline.sh"
PIPELINE_START="2026-06-30T00:00:00Z"
PIPELINE_ID="test-rs-$$"
CONFIG_FILE="$(mktemp)"
CONFIG_SHA256=""
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

# Write a minimal config so validate_resume_status can source it
cat > "$CONFIG_FILE" <<'CFGEOF'
REPO="/tmp/fake-repo"
WORKTREE_BASE="/tmp/fake-worktrees"
OWNER_REPO="org/repo"
AI_REVIEW_PROVIDER="ghe-pr-bot"
AI_REVIEW_API_BASE="https://github.example.com/api/v3"
ISSUES=(10 20 30)
BRANCHES=("issue-10" "issue-20" "issue-30")
CFGEOF

_source_pipeline_lib() {
  set -- /dev/null
  # shellcheck disable=SC1090
  source "$PIPELINE_SH"
}
_source_pipeline_lib

# Restore globals that pipeline.sh resets on source at the top level
LOG_DIR="$(mktemp -d)"
PIPELINE_LOCK_DIR="$(mktemp -d)"
REPO="/tmp/fake-repo"

# Compute config sha after sourcing (compute_file_sha256 is now available)
CONFIG_SHA256="$(compute_file_sha256 "$CONFIG_FILE")"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR" "$LOG_DIR" "$PIPELINE_LOCK_DIR" "$CONFIG_FILE"' EXIT

reset_state() {
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
  ISSUES_COMPLETED=()
  ISSUES_COMPLETED_DETAILS=()
  ISSUES_SKIPPED=()
}

# ─────────────────────────────────────────────────────────────────────────────
# Test a: write_status "paused" → resume_supported=true, checkpoint=between-issues
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test a: write_status paused → resume_supported=true ==="

reset_state
IS_PAUSED=1
PAUSED_AT="2026-06-30T12:00:00Z"
PAUSED_REASON="user-requested"
CURRENT_PHASE="paused"
NEXT_ISSUE_INDEX="0"

write_status "paused"
JSON="$(cat "$LOG_DIR/status.json")"

if python3 -c "import sys,json; json.load(sys.stdin)" <<< "$JSON" 2>/dev/null; then
  ok "paused: valid JSON"
else
  fail "paused: valid JSON"
fi
assert_json_field "paused: pipeline_state=paused"         "$JSON" "pipeline_state"   "paused"
assert_json_field "paused: resume_supported=true"         "$JSON" "resume_supported" "true"
assert_json_field "paused: checkpoint=between-issues"     "$JSON" "checkpoint"       "between-issues"
assert_json_field_notnull "paused: paused_at non-null"    "$JSON" "paused_at"

# ─────────────────────────────────────────────────────────────────────────────
# Test b: non-paused states → resume_supported=false
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test b: non-paused states → resume_supported=false ==="

for state in running completed blocked aborted killed; do
  reset_state
  write_status "$state"
  JSON="$(cat "$LOG_DIR/status.json")"
  assert_json_field "$state: resume_supported=false" "$JSON" "resume_supported" "false"
  assert_json_field "$state: checkpoint=null"        "$JSON" "checkpoint"       "null"
done

# ─────────────────────────────────────────────────────────────────────────────
# Test c: double pause keeps resume_supported=true and paused_at unchanged
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test c: double pause keeps resume_supported=true, paused_at unchanged ==="

reset_state
IS_PAUSED=1
PAUSED_AT="2026-06-30T09:00:00Z"
PAUSED_REASON="user-requested"
CURRENT_PHASE="paused"
NEXT_ISSUE_INDEX="0"

write_status "paused"
JSON1="$(cat "$LOG_DIR/status.json")"
FIRST_AT=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('paused_at','null'))" <<< "$JSON1" 2>/dev/null || echo "null")
FIRST_RS=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('resume_supported')))" <<< "$JSON1" 2>/dev/null || echo "null")

# Second write with same state vars — simulates double-pause
write_status "paused"
JSON2="$(cat "$LOG_DIR/status.json")"
SECOND_AT=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('paused_at','null'))" <<< "$JSON2" 2>/dev/null || echo "null")
SECOND_RS=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('resume_supported')))" <<< "$JSON2" 2>/dev/null || echo "null")

assert_eq "double pause: paused_at unchanged"       "$FIRST_AT"  "$SECOND_AT"
assert_eq "double pause: resume_supported=true"     "true"       "$FIRST_RS"
assert_eq "double pause: resume_supported still true" "true"     "$SECOND_RS"

# ─────────────────────────────────────────────────────────────────────────────
# Test d: paused then running resets resume_supported=false
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test d: paused then running → resume_supported=false ==="

reset_state
IS_PAUSED=1
PAUSED_AT="2026-06-30T12:00:00Z"
PAUSED_REASON="user-requested"
CURRENT_PHASE="paused"
NEXT_ISSUE_INDEX="1"

write_status "paused"
PAUSED_JSON="$(cat "$LOG_DIR/status.json")"
assert_json_field "before resume: resume_supported=true"  "$PAUSED_JSON" "resume_supported" "true"

# Resume: clear paused state
IS_PAUSED=0
PAUSED_AT=""
PAUSED_REASON=""
CURRENT_PHASE=""
CURRENT_ISSUE="20"
CURRENT_ISSUE_INDEX="1"
NEXT_ISSUE_INDEX="2"

write_status "running"
RUNNING_JSON="$(cat "$LOG_DIR/status.json")"
assert_json_field "after resume: resume_supported=false"  "$RUNNING_JSON" "resume_supported" "false"
assert_json_field "after resume: checkpoint=null"         "$RUNNING_JSON" "checkpoint"       "null"
assert_json_field "after resume: paused_at=null"          "$RUNNING_JSON" "paused_at"        "null"

# ─────────────────────────────────────────────────────────────────────────────
# Test e: real write_repo_lock_metadata emits four new fields and old fields
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test e: write_repo_lock_metadata emits pipeline_id/status_file/log_file/control_file ==="

reset_state
canonical=$(canonical_repo_path)
write_repo_lock_metadata "$canonical"
META="$(cat "$PIPELINE_LOCK_DIR/metadata")"

# Old preserved fields
if echo "$META" | grep -q "^pid="; then
  ok "lock metadata: pid field present"
else
  fail "lock metadata: pid field present" "$META"
fi
if echo "$META" | grep -q "^repo="; then
  ok "lock metadata: repo field present"
else
  fail "lock metadata: repo field present" "$META"
fi
if echo "$META" | grep -q "^config="; then
  ok "lock metadata: config field present"
else
  fail "lock metadata: config field present" "$META"
fi
if echo "$META" | grep -q "^log_dir="; then
  ok "lock metadata: log_dir field present"
else
  fail "lock metadata: log_dir field present" "$META"
fi
if echo "$META" | grep -q "^state="; then
  ok "lock metadata: state field present"
else
  fail "lock metadata: state field present" "$META"
fi

# New fields
if echo "$META" | grep -q "^pipeline_id="; then
  ok "lock metadata: pipeline_id present"
else
  fail "lock metadata: pipeline_id present" "$META"
fi
if echo "$META" | grep -q "^status_file=.*status\.json$"; then
  ok "lock metadata: status_file ends with status.json"
else
  fail "lock metadata: status_file ends with status.json" "$META"
fi
if echo "$META" | grep -q "^log_file=.*loop\.log$"; then
  ok "lock metadata: log_file ends with loop.log"
else
  fail "lock metadata: log_file ends with loop.log" "$META"
fi
if echo "$META" | grep -q "^control_file=.*control$"; then
  ok "lock metadata: control_file ends with control"
else
  fail "lock metadata: control_file ends with control" "$META"
fi

# pipeline_id value matches PIPELINE_ID
if echo "$META" | grep -q "^pipeline_id=${PIPELINE_ID}$"; then
  ok "lock metadata: pipeline_id value matches PIPELINE_ID"
else
  fail "lock metadata: pipeline_id value matches PIPELINE_ID" "$(grep '^pipeline_id=' <<< "$META")"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test f: update_lock_state "paused" preserves all four new fields
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test f: update_lock_state paused preserves pipeline_id/status_file/log_file/control_file ==="

reset_state
update_lock_state "paused"
PAUSED_META="$(cat "$PIPELINE_LOCK_DIR/metadata")"

if echo "$PAUSED_META" | grep -q "^state=paused$"; then
  ok "update_lock_state paused: state=paused"
else
  fail "update_lock_state paused: state=paused" "$PAUSED_META"
fi
if echo "$PAUSED_META" | grep -q "^pipeline_id="; then
  ok "update_lock_state paused: pipeline_id preserved"
else
  fail "update_lock_state paused: pipeline_id preserved" "$PAUSED_META"
fi
if echo "$PAUSED_META" | grep -q "^status_file="; then
  ok "update_lock_state paused: status_file preserved"
else
  fail "update_lock_state paused: status_file preserved" "$PAUSED_META"
fi
if echo "$PAUSED_META" | grep -q "^log_file="; then
  ok "update_lock_state paused: log_file preserved"
else
  fail "update_lock_state paused: log_file preserved" "$PAUSED_META"
fi
if echo "$PAUSED_META" | grep -q "^control_file="; then
  ok "update_lock_state paused: control_file preserved"
else
  fail "update_lock_state paused: control_file preserved" "$PAUSED_META"
fi

# Restore running state
update_lock_state "running"
RUNNING_META2="$(cat "$PIPELINE_LOCK_DIR/metadata")"
if echo "$RUNNING_META2" | grep -q "^state=running$"; then
  ok "update_lock_state running after paused: state=running"
else
  fail "update_lock_state running after paused: state=running" "$RUNNING_META2"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test g: real paused status produced by write_status passes validate_resume_status
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test g: real paused status passes validate_resume_status ==="

reset_state
IS_PAUSED=1
PAUSED_AT="2026-06-30T12:00:00Z"
PAUSED_REASON="user-requested"
CURRENT_PHASE="paused"
NEXT_ISSUE_INDEX="1"
ISSUES_COMPLETED=(10)
ISSUES_SKIPPED=()

write_status "paused"
PAUSED_STATUS="$LOG_DIR/status.json"

if validate_resume_status "$PAUSED_STATUS" 2>/tmp/test_rs_stderr_$$.txt; then
  ok "validate_resume_status accepts real paused status"
  assert_eq "RESUME_STATUS_FILE set correctly"  "$PAUSED_STATUS"  "$RESUME_STATUS_FILE"
  assert_eq "RESUME_PIPELINE_ID set correctly"  "$PIPELINE_ID"    "$RESUME_PIPELINE_ID"
  assert_eq "RESUME_NEXT_ISSUE_INDEX=1"         "1"               "$RESUME_NEXT_ISSUE_INDEX"
else
  ERR_G=$(cat /tmp/test_rs_stderr_$$.txt 2>/dev/null || true)
  fail "validate_resume_status accepts real paused status" "$ERR_G"
fi
rm -f /tmp/test_rs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════"
[ "$FAIL" -eq 0 ]
