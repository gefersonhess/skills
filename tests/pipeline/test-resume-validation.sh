#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Unit tests for validate_resume_status in pipeline.sh.
#
# Covers:
#   1.  happy path: valid paused status with resume_supported=true
#   2.  schema v1 refused
#   3.  running state refused
#   4.  completed state refused; original status file unchanged
#   5.  config sha256 mismatch refused
#   6.  missing config file refused
#   7.  unsupported checkpoint refused
#   8.  resume_supported=false refused
#   9.  live current_agent_pid refused
#  10.  ISSUES mismatch refused
#  11.  next_issue_index < completed count refused
#  12.  completed issue not in issues_total refused
#  13.  skipped issue not in issues_total refused
#  14.  invalid JSON refused
#  15.  all-done: next_issue_index == len(issues_total) accepted
#  16.  missing status path refused
#  17.  non-numeric next_issue_index refused
#  18.  non-numeric issue arrays refused
#  19.  issue before next_issue_index that is neither completed nor skipped refused
#
# Run: bash tests/pipeline/test-resume-validation.sh
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

# ─────────────────────────────────────────────────────────────────────────────
# Minimal stubs required so PIPELINE_LIB_MODE sourcing succeeds
# (validate_config, log, and others are defined in pipeline.sh's function
# section; we only need stubs that run *before* the function section is parsed)
# ─────────────────────────────────────────────────────────────────────────────

# Source only the function definitions by setting PIPELINE_LIB_MODE=1 and
# temporarily satisfying the argument check that runs before the function block.
PIPELINE_LIB_MODE=1

# pipeline.sh uses set -uo pipefail and reads $1 early; we must fake a valid
# invocation.  We pre-set CONFIG_FILE to a dummy path so the argument-parser
# path (which has already exited here via PIPELINE_LIB_MODE) is never reached.
# We source with `bash --` and the LIB_MODE guard stops execution after
# function definitions.

PIPELINE_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/skills/implementation-pipeline/pipeline.sh"

# Stub the early-exit sections that pipeline.sh runs before the function block.
# We need: validate_config (defined in pipeline.sh), log (defined in pipeline.sh).
# The top-level arg check runs immediately, so we use a subprocess to source
# with fake args and capture just the functions we need.

# Source strategy: set PIPELINE_LIB_MODE=1 and provide a dummy $1 so the
# "if [ $# -lt 1 ]" check passes.  PIPELINE_LIB_MODE guard exits before the
# pipeline execution body.

# We need to source into THIS shell so validate_resume_status is available.
# Use a wrapper that sets $1 via "set --" before sourcing.
_source_pipeline_lib() {
  set -- /dev/null
  # Stub validate_config before sourcing so the 'if ! validate_config' at the
  # top level (after load-config) returns without error if it runs.
  # pipeline.sh defines validate_config itself; with PIPELINE_LIB_MODE=1 the
  # execution body is never reached, so no stub is needed.
  # shellcheck disable=SC1090
  source "$PIPELINE_SH"
}

# Some variables pipeline.sh declares before function definitions need values.
LOG_DIR="$(mktemp -d)"
LOCK_DIR="$(mktemp -d)"
# Not used in validation helpers but needed by pipeline.sh set -u paths:
export PIPELINE_LIB_MODE=1

_source_pipeline_lib

# ─────────────────────────────────────────────────────────────────────────────
# Fixture helpers
# ─────────────────────────────────────────────────────────────────────────────

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR" "$LOG_DIR" "$LOCK_DIR"' EXIT

# make_config <file> [ISSUES_ARRAY_LITERAL]
# Writes a minimal sourceable config.
make_config() {
  local file="$1" issues="${2:-10 20 30}"
  cat > "$file" <<EOF
REPO="/tmp/fake-repo"
WORKTREE_BASE="/tmp/fake-worktrees"
OWNER_REPO="org/repo"
AI_REVIEW_PROVIDER="ghe-pr-bot"
AI_REVIEW_API_BASE="https://github.example.com/api/v3"
ISSUES=($issues)
BRANCHES=("issue-10" "issue-20" "issue-30")
EOF
}

# make_status <file> <config_file> <config_sha256>
# Writes a minimal valid paused status with resume_supported=true.
make_status() {
  local file="$1" config_file="$2" config_sha256="$3"
  cat > "$file" <<EOF
{
  "schema_version": 2,
  "pipeline_state": "paused",
  "version": "1.1.0",
  "resume_supported": true,
  "checkpoint": "between-issues",
  "pipeline_id": "test-pipe-123",
  "pid": 99999,
  "current_agent_pid": null,
  "config_file": "$config_file",
  "config_sha256": "$config_sha256",
  "next_issue_index": 1,
  "issues_total": [10, 20, 30],
  "issues_completed": [10],
  "issues_skipped": []
}
EOF
}

# ─────────────────────────────────────────────────────────────────────────────
# Test 1: happy path validates synthetic paused status with resume_supported=true
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 1: happy path ==="

cfg1="$TMP_DIR/config1.sh"
make_config "$cfg1"
sha1=$(compute_file_sha256 "$cfg1")
st1="$TMP_DIR/status1.json"
make_status "$st1" "$cfg1" "$sha1"

err1=""
if validate_resume_status "$st1" 2>/tmp/vrs_stderr_$$.txt; then
  ok "happy path: validate_resume_status returns 0"
  assert_eq "RESUME_STATUS_FILE set" "$st1" "$RESUME_STATUS_FILE"
  assert_eq "RESUME_CONFIG_FILE set" "$cfg1" "$RESUME_CONFIG_FILE"
  assert_eq "RESUME_PIPELINE_ID set" "test-pipe-123" "$RESUME_PIPELINE_ID"
  assert_eq "RESUME_NEXT_ISSUE_INDEX set" "1" "$RESUME_NEXT_ISSUE_INDEX"
  assert_eq "RESUME_ISSUES_TOTAL_CSV set" "10,20,30" "$RESUME_ISSUES_TOTAL_CSV"
  assert_eq "RESUME_ISSUES_COMPLETED_CSV set" "10" "$RESUME_ISSUES_COMPLETED_CSV"
  assert_eq "RESUME_ISSUES_SKIPPED_CSV set" "" "$RESUME_ISSUES_SKIPPED_CSV"
else
  err1=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  fail "happy path: validate_resume_status returns 0" "$err1"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 2: schema v1 refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 2: schema v1 refused ==="

cfg2="$TMP_DIR/config2.sh"
make_config "$cfg2"
sha2=$(compute_file_sha256 "$cfg2")
st2="$TMP_DIR/status2.json"
make_status "$st2" "$cfg2" "$sha2"
# Override schema_version to 1
python3 -c "import json,sys; d=json.load(open('$st2')); d['schema_version']=1; json.dump(d,open('$st2','w'))"

if ! validate_resume_status "$st2" 2>/tmp/vrs_stderr_$$.txt; then
  err2=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err2" | grep -qi "schema_version"; then
    ok "schema v1 refused with schema_version message"
  else
    fail "schema v1 refused: expected schema_version in error" "$err2"
  fi
else
  fail "schema v1 should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 3: running state refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 3: running state refused ==="

cfg3="$TMP_DIR/config3.sh"
make_config "$cfg3"
sha3=$(compute_file_sha256 "$cfg3")
st3="$TMP_DIR/status3.json"
make_status "$st3" "$cfg3" "$sha3"
python3 -c "import json,sys; d=json.load(open('$st3')); d['pipeline_state']='running'; json.dump(d,open('$st3','w'))"

if ! validate_resume_status "$st3" 2>/tmp/vrs_stderr_$$.txt; then
  err3=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err3" | grep -qi "pipeline_state\|running"; then
    ok "running state refused with pipeline_state message"
  else
    fail "running state refused: expected pipeline_state in error" "$err3"
  fi
else
  fail "running state should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 4: completed state refused and original status unchanged
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 4: completed state refused; original status unchanged ==="

cfg4="$TMP_DIR/config4.sh"
make_config "$cfg4"
sha4=$(compute_file_sha256 "$cfg4")
st4="$TMP_DIR/status4.json"
make_status "$st4" "$cfg4" "$sha4"
python3 -c "import json,sys; d=json.load(open('$st4')); d['pipeline_state']='completed'; json.dump(d,open('$st4','w'))"
original_content4=$(cat "$st4")

if ! validate_resume_status "$st4" 2>/dev/null; then
  ok "completed state refused"
  after_content4=$(cat "$st4")
  assert_eq "status file unchanged after refused validation" "$original_content4" "$after_content4"
else
  fail "completed state should have been refused"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test 5: config sha256 mismatch refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 5: config sha256 mismatch refused ==="

cfg5="$TMP_DIR/config5.sh"
make_config "$cfg5"
st5="$TMP_DIR/status5.json"
make_status "$st5" "$cfg5" "deadbeefdeadbeef0000111122223333deadbeefdeadbeef0000111122223333"

if ! validate_resume_status "$st5" 2>/tmp/vrs_stderr_$$.txt; then
  err5=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err5" | grep -qi "sha256\|mismatch\|changed"; then
    ok "sha256 mismatch refused with hash message"
  else
    fail "sha256 mismatch refused: expected sha256/mismatch in error" "$err5"
  fi
else
  fail "sha256 mismatch should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 6: missing config file refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 6: missing config file refused ==="

cfg6="/tmp/nonexistent_config_$$.sh"
st6="$TMP_DIR/status6.json"
make_status "$st6" "$cfg6" "aaabbbcccddd"

if ! validate_resume_status "$st6" 2>/tmp/vrs_stderr_$$.txt; then
  err6=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err6" | grep -qi "config\|not exist"; then
    ok "missing config refused with config message"
  else
    fail "missing config refused: expected config/not exist in error" "$err6"
  fi
else
  fail "missing config should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 7: unsupported checkpoint refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 7: unsupported checkpoint refused ==="

cfg7="$TMP_DIR/config7.sh"
make_config "$cfg7"
sha7=$(compute_file_sha256 "$cfg7")
st7="$TMP_DIR/status7.json"
make_status "$st7" "$cfg7" "$sha7"
python3 -c "import json,sys; d=json.load(open('$st7')); d['checkpoint']='mid-issue'; json.dump(d,open('$st7','w'))"

if ! validate_resume_status "$st7" 2>/tmp/vrs_stderr_$$.txt; then
  err7=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err7" | grep -qi "checkpoint"; then
    ok "unsupported checkpoint refused with checkpoint message"
  else
    fail "unsupported checkpoint refused: expected checkpoint in error" "$err7"
  fi
else
  fail "unsupported checkpoint should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 8: resume_supported=false refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 8: resume_supported=false refused ==="

cfg8="$TMP_DIR/config8.sh"
make_config "$cfg8"
sha8=$(compute_file_sha256 "$cfg8")
st8="$TMP_DIR/status8.json"
make_status "$st8" "$cfg8" "$sha8"
python3 -c "import json,sys; d=json.load(open('$st8')); d['resume_supported']=False; json.dump(d,open('$st8','w'))"

if ! validate_resume_status "$st8" 2>/tmp/vrs_stderr_$$.txt; then
  err8=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err8" | grep -qi "resume_supported"; then
    ok "resume_supported=false refused with resume_supported message"
  else
    fail "resume_supported=false refused: expected resume_supported in error" "$err8"
  fi
else
  fail "resume_supported=false should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 9: live current_agent_pid refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 9: live current_agent_pid refused ==="

cfg9="$TMP_DIR/config9.sh"
make_config "$cfg9"
sha9=$(compute_file_sha256 "$cfg9")
st9="$TMP_DIR/status9.json"
make_status "$st9" "$cfg9" "$sha9"
# Use current shell PID as a live PID
live_pid="$$"
python3 -c "import json,sys; d=json.load(open('$st9')); d['current_agent_pid']=$live_pid; json.dump(d,open('$st9','w'))"

if ! validate_resume_status "$st9" 2>/tmp/vrs_stderr_$$.txt; then
  err9=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err9" | grep -qi "alive\|still running\|control"; then
    ok "live current_agent_pid refused with alive/control message"
  else
    fail "live current_agent_pid refused: expected alive/control in error" "$err9"
  fi
else
  fail "live current_agent_pid should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 10: ISSUES mismatch refused (config has different count)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 10: ISSUES mismatch refused ==="

cfg10="$TMP_DIR/config10.sh"
# Config has 2 issues, status claims 3
make_config "$cfg10" "10 20"
sha10=$(compute_file_sha256 "$cfg10")
st10="$TMP_DIR/status10.json"
make_status "$st10" "$cfg10" "$sha10"
# Status still has 3 issues, config only has 2 — sha matches config but count differs

if ! validate_resume_status "$st10" 2>/tmp/vrs_stderr_$$.txt; then
  err10=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err10" | grep -qi "ISSUES\|count\|mismatch"; then
    ok "ISSUES count mismatch refused"
  else
    fail "ISSUES count mismatch refused: expected ISSUES/count in error" "$err10"
  fi
else
  fail "ISSUES count mismatch should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 11: next_issue_index < completed count refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 11: next_issue_index < issues_completed count refused ==="

cfg11="$TMP_DIR/config11.sh"
make_config "$cfg11"
sha11=$(compute_file_sha256 "$cfg11")
st11="$TMP_DIR/status11.json"
make_status "$st11" "$cfg11" "$sha11"
# completed = [10, 20] (count=2), next_issue_index=1 (<2) → inconsistent
python3 -c "
import json
d=json.load(open('$st11'))
d['issues_completed']=[10,20]
d['next_issue_index']=1
json.dump(d,open('$st11','w'))
"

if ! validate_resume_status "$st11" 2>/tmp/vrs_stderr_$$.txt; then
  err11=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err11" | grep -qi "next_issue_index\|inconsistent\|less than"; then
    ok "next_issue_index < completed count refused"
  else
    fail "next_issue_index < completed count refused: expected next_issue_index/inconsistent in error" "$err11"
  fi
else
  fail "next_issue_index < completed count should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 12: completed issue not in issues_total refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 12: completed issue not in issues_total refused ==="

cfg12="$TMP_DIR/config12.sh"
make_config "$cfg12"
sha12=$(compute_file_sha256 "$cfg12")
st12="$TMP_DIR/status12.json"
make_status "$st12" "$cfg12" "$sha12"
# Put a foreign issue (999) in issues_completed
python3 -c "
import json
d=json.load(open('$st12'))
d['issues_completed']=[999]
d['next_issue_index']=1
json.dump(d,open('$st12','w'))
"

if ! validate_resume_status "$st12" 2>/tmp/vrs_stderr_$$.txt; then
  err12=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err12" | grep -qi "issues_completed\|not in issues_total\|999"; then
    ok "completed issue not in issues_total refused"
  else
    fail "completed issue not in issues_total refused: expected issues_completed/not in issues_total in error" "$err12"
  fi
else
  fail "completed issue not in issues_total should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 13: skipped issue not in issues_total refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 13: skipped issue not in issues_total refused ==="

cfg13="$TMP_DIR/config13.sh"
make_config "$cfg13"
sha13=$(compute_file_sha256 "$cfg13")
st13="$TMP_DIR/status13.json"
make_status "$st13" "$cfg13" "$sha13"
python3 -c "
import json
d=json.load(open('$st13'))
d['issues_skipped']=[888]
json.dump(d,open('$st13','w'))
"

if ! validate_resume_status "$st13" 2>/tmp/vrs_stderr_$$.txt; then
  err13=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err13" | grep -qi "issues_skipped\|not in issues_total\|888"; then
    ok "skipped issue not in issues_total refused"
  else
    fail "skipped issue not in issues_total refused: expected issues_skipped/not in issues_total in error" "$err13"
  fi
else
  fail "skipped issue not in issues_total should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 14: invalid JSON refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 14: invalid JSON refused ==="

st14="$TMP_DIR/status14.json"
printf 'this is not json\n' > "$st14"

if ! validate_resume_status "$st14" 2>/tmp/vrs_stderr_$$.txt; then
  err14=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err14" | grep -qi "JSON\|json\|valid"; then
    ok "invalid JSON refused with JSON message"
  else
    fail "invalid JSON refused: expected JSON in error" "$err14"
  fi
else
  fail "invalid JSON should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 15: all-done — next_issue_index == len(issues_total) accepted
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 15: all-done: next_issue_index == len(issues_total) accepted ==="

cfg15="$TMP_DIR/config15.sh"
make_config "$cfg15"
sha15=$(compute_file_sha256 "$cfg15")
st15="$TMP_DIR/status15.json"
make_status "$st15" "$cfg15" "$sha15"
# All 3 issues completed, next_issue_index=3 (== len(issues_total))
python3 -c "
import json
d=json.load(open('$st15'))
d['issues_completed']=[10,20,30]
d['next_issue_index']=3
json.dump(d,open('$st15','w'))
"

if validate_resume_status "$st15" 2>/tmp/vrs_stderr_$$.txt; then
  ok "all-done: next_issue_index=3 accepted"
  assert_eq "RESUME_NEXT_ISSUE_INDEX=3" "3" "$RESUME_NEXT_ISSUE_INDEX"
else
  err15=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  fail "all-done: next_issue_index=3 should have been accepted" "$err15"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 16: missing status path refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 16: missing status path refused ==="

if ! validate_resume_status 2>/tmp/vrs_stderr_$$.txt; then
  err16=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err16" | grep -qi "status file path"; then
    ok "missing status path refused with clear message"
  else
    fail "missing status path refused: expected status file path in error" "$err16"
  fi
else
  fail "missing status path should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 17: non-numeric next_issue_index refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 17: non-numeric next_issue_index refused ==="

cfg17="$TMP_DIR/config17.sh"
make_config "$cfg17"
sha17=$(compute_file_sha256 "$cfg17")
st17="$TMP_DIR/status17.json"
make_status "$st17" "$cfg17" "$sha17"
python3 -c "
import json
d=json.load(open('$st17'))
d['next_issue_index']='not-a-number'
json.dump(d,open('$st17','w'))
"

if ! validate_resume_status "$st17" 2>/tmp/vrs_stderr_$$.txt; then
  err17=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err17" | grep -qi "next_issue_index"; then
    ok "non-numeric next_issue_index refused"
  else
    fail "non-numeric next_issue_index refused: expected next_issue_index in error" "$err17"
  fi
else
  fail "non-numeric next_issue_index should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 18: non-numeric issue array values refused
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 18: non-numeric issue arrays refused ==="

cfg18="$TMP_DIR/config18.sh"
make_config "$cfg18"
sha18=$(compute_file_sha256 "$cfg18")
st18="$TMP_DIR/status18.json"
make_status "$st18" "$cfg18" "$sha18"
python3 -c "
import json
d=json.load(open('$st18'))
d['issues_completed']=['not-an-issue']
json.dump(d,open('$st18','w'))
"

if ! validate_resume_status "$st18" 2>/tmp/vrs_stderr_$$.txt; then
  err18=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err18" | grep -qi "numeric issue"; then
    ok "non-numeric issue array value refused"
  else
    fail "non-numeric issue array value refused: expected numeric issue in error" "$err18"
  fi
else
  fail "non-numeric issue array value should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 19: issue before next_issue_index must be completed or skipped
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 19: unprocessed issue before cursor refused ==="

cfg19="$TMP_DIR/config19.sh"
make_config "$cfg19"
sha19=$(compute_file_sha256 "$cfg19")
st19="$TMP_DIR/status19.json"
make_status "$st19" "$cfg19" "$sha19"
python3 -c "
import json
d=json.load(open('$st19'))
d['next_issue_index']=2
d['issues_completed']=[10]
d['issues_skipped']=[]
json.dump(d,open('$st19','w'))
"

if ! validate_resume_status "$st19" 2>/tmp/vrs_stderr_$$.txt; then
  err19=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  if echo "$err19" | grep -qi "before next_issue_index\|neither completed nor skipped\|issue 20"; then
    ok "unprocessed issue before cursor refused"
  else
    fail "unprocessed issue before cursor refused: expected cursor prefix error" "$err19"
  fi
else
  fail "unprocessed issue before cursor should have been refused"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 20: valid issues_completed_details are exported in RESUME_ISSUES_COMPLETED_DETAILS_NDJSON
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 20: valid details exported in RESUME_ISSUES_COMPLETED_DETAILS_NDJSON ==="

cfg20="$TMP_DIR/config20.sh"
make_config "$cfg20"
sha20=$(compute_file_sha256 "$cfg20")
st20="$TMP_DIR/status20.json"
make_status "$st20" "$cfg20" "$sha20"
# Inject valid issues_completed_details for issue 10
python3 -c "
import json
d = json.load(open('$st20'))
d['issues_completed_details'] = [
  {\"issue\": 10, \"pr\": 42, \"started_at\": \"2026-01-01T00:00:00Z\",
   \"completed_at\": \"2026-01-01T00:10:00Z\", \"duration_seconds\": 600}
]
json.dump(d, open('$st20', 'w'))
"

unset RESUME_ISSUES_COMPLETED_DETAILS_NDJSON
if validate_resume_status "$st20" 2>/tmp/vrs_stderr_$$.txt; then
  ok "test 20: validate_resume_status returns 0 with valid details"
  # NDJSON must be non-empty
  if [ -n "${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}" ]; then
    ok "test 20: RESUME_ISSUES_COMPLETED_DETAILS_NDJSON is non-empty"
  else
    fail "test 20: RESUME_ISSUES_COMPLETED_DETAILS_NDJSON should be non-empty"
  fi
  # Must contain exactly one line
  line_count20=$(echo "${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}" | grep -c '.' 2>/dev/null || echo 0)
  assert_eq "test 20: exactly one detail line" "1" "$line_count20"
  # Line must be valid compact JSON with .issue == 10
  issue_val20=$(echo "${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}" | jq -r '.issue' 2>/dev/null || echo "ERR")
  assert_eq "test 20: detail .issue == 10" "10" "$issue_val20"
  # Line must be a compact object (no outer array or string wrapping)
  first_char20=$(echo "${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}" | head -c1)
  assert_eq "test 20: detail is compact object (starts with {)" "{" "$first_char20"
  # Optional field pr must be preserved
  pr_val20=$(echo "${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}" | jq -r '.pr' 2>/dev/null || echo "ERR")
  assert_eq "test 20: detail .pr preserved" "42" "$pr_val20"
else
  err20=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  fail "test 20: validate_resume_status should return 0 with valid details" "$err20"
fi
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 21: missing/null/non-array details — validation succeeds, exported details empty
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 21: missing/null/non-array details — validation succeeds, exported empty ==="

for variant in missing null string number; do
  cfg21="$TMP_DIR/config21_${variant}.sh"
  make_config "$cfg21"
  sha21=$(compute_file_sha256 "$cfg21")
  st21="$TMP_DIR/status21_${variant}.json"
  make_status "$st21" "$cfg21" "$sha21"
  case "$variant" in
    missing)
      python3 -c "import json; d=json.load(open('$st21')); del d['issues_completed_details']; json.dump(d,open('$st21','w'))" 2>/dev/null || true
      ;;
    null)
      python3 -c "import json; d=json.load(open('$st21')); d['issues_completed_details']=None; json.dump(d,open('$st21','w'))"
      ;;
    string)
      python3 -c "import json; d=json.load(open('$st21')); d['issues_completed_details']='not-an-array'; json.dump(d,open('$st21','w'))"
      ;;
    number)
      python3 -c "import json; d=json.load(open('$st21')); d['issues_completed_details']=42; json.dump(d,open('$st21','w'))"
      ;;
  esac
  unset RESUME_ISSUES_COMPLETED_DETAILS_NDJSON
  if validate_resume_status "$st21" 2>/tmp/vrs_stderr_$$.txt; then
    ok "test 21 ($variant): validate_resume_status returns 0"
    exported21="${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}"
    # Allow empty string or all-whitespace; must not contain a non-empty object line
    non_empty_lines21=$(printf '%s' "$exported21" | { grep -c '^{' || true; })
    assert_eq "test 21 ($variant): exported details empty" "0" "$non_empty_lines21"
  else
    err21=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
    fail "test 21 ($variant): validate_resume_status should not fail due to details" "$err21"
  fi
  rm -f /tmp/vrs_stderr_$$.txt
done

# ─────────────────────────────────────────────────────────────────────────────
# Test 22: stale/invalid detail records filtered; valid details still exported
# (non-mutating: validate_resume_status does not change the status file)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 22: stale/invalid details filtered; status file unchanged ==="

cfg22="$TMP_DIR/config22.sh"
make_config "$cfg22"
sha22=$(compute_file_sha256 "$cfg22")
st22="$TMP_DIR/status22.json"
make_status "$st22" "$cfg22" "$sha22"
# Inject a mix:
#   - valid record for issue 10 (completed)
#   - non-object element (array)
#   - object with non-numeric issue
#   - object with issue not in issues_completed (stale: issue 30)
#   - duplicate record for issue 10 (should be filtered)
python3 -c "
import json
d = json.load(open('$st22'))
d['issues_completed_details'] = [
  {\"issue\": 10, \"pr\": 7, \"duration_seconds\": 100},
  [\"not\", \"an\", \"object\"],
  {\"issue\": \"text\", \"pr\": 99},
  {\"issue\": 30, \"pr\": 5, \"duration_seconds\": 200},
  {\"issue\": 10, \"pr\": 8, \"duration_seconds\": 999}
]
json.dump(d, open('$st22', 'w'))
"
original22=$(cat "$st22")

unset RESUME_ISSUES_COMPLETED_DETAILS_NDJSON
if validate_resume_status "$st22" 2>/tmp/vrs_stderr_$$.txt; then
  ok "test 22: validate_resume_status returns 0"
  # Only one valid detail line (issue 10, first occurrence)
  line_count22=$(printf '%s\n' "${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}" | grep -c '^{' 2>/dev/null || echo 0)
  assert_eq "test 22: exactly one valid detail exported" "1" "$line_count22"
  issue_val22=$(printf '%s\n' "${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}" | jq -r '.issue' 2>/dev/null || echo "ERR")
  assert_eq "test 22: exported .issue == 10" "10" "$issue_val22"
  # First-wins: pr should be 7 (first occurrence), not 8 (duplicate)
  pr_val22=$(printf '%s\n' "${RESUME_ISSUES_COMPLETED_DETAILS_NDJSON:-}" | jq -r '.pr' 2>/dev/null || echo "ERR")
  assert_eq "test 22: first-wins dedup (.pr == 7)" "7" "$pr_val22"
else
  err22=$(cat /tmp/vrs_stderr_$$.txt 2>/dev/null || true)
  fail "test 22: validate_resume_status should return 0" "$err22"
fi
# Non-mutating: status file must be unchanged
after22=$(cat "$st22")
assert_eq "test 22: status file unchanged (non-mutating)" "$original22" "$after22"
rm -f /tmp/vrs_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
