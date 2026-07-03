#!/usr/bin/env bash
# shellcheck disable=SC2034  # globals consumed by sourced pipeline.sh functions
# ─────────────────────────────────────────────────────────────────────────────
# Unit and integration tests for Phase 3B: pipeline.sh --resume <status.json>
#
# Covers:
#   1.  Happy path: restores state (completed/skipped/cursor) with no existing lock
#   2.  Stale same-owner lock is reclaimed
#   3.  Stale foreign lock is refused and left unchanged
#   4.  Live lock is refused and status unchanged
#   5.  Missing LOG_DIR refused before lock/status mutation
#   6.  --resume with no path exits nonzero with usage/error
#   7.  --resume with extra arg exits nonzero with usage/error
#   8.  Validation failure (bad state) leaves status unchanged
#   9.  Pipeline ID preserved in lock metadata/registry after resume prep
#  10.  Skip guard: completed/skipped issues are skipped; fresh issues are not
#  11.  All-done cursor: resume_entrypoint with next_issue_index == len(issues)
#         transitions cleanly (state restoration verified)
#  12.  Normal config startup path reaches validation without resolve_skill errors
#
# Run: bash tests/pipeline/test-resume-entrypoint.sh
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
  local label="$1" json_file="$2" field="$3" expected="$4"
  local actual
  actual=$(python3 -c "
import sys, json
try:
    data = json.load(open('$json_file'))
    val = data.get('$field')
    if val is None:
        print('null')
    elif isinstance(val, bool):
        print('true' if val else 'false')
    else:
        print(json.dumps(val).strip('\"'))
except Exception as e:
    print('__ERROR__: ' + str(e))
" 2>/dev/null) || actual="__ERROR__"
  if [ "$actual" = "$expected" ]; then
    ok "$label"
  else
    fail "$label" "expected=$(printf '%q' "$expected") got=$(printf '%q' "$actual")"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Source pipeline.sh in lib mode to get all helpers (validate_resume_status,
# acquire_repo_lock_for_resume, resume_entrypoint, compute_file_sha256, etc.)
# ─────────────────────────────────────────────────────────────────────────────

PIPELINE_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/skills/implementation-pipeline/pipeline.sh"

# Minimal globals required by pipeline.sh under PIPELINE_LIB_MODE=1
export PIPELINE_LIB_MODE=1
ISSUES=(10 20 30)
BRANCHES=("issue-10" "issue-20" "issue-30")
ISSUES_COMPLETED=()
ISSUES_COMPLETED_DETAILS=()
ISSUES_SKIPPED=()
VERSION="1.1.0"
SCRIPT_FILE="/path/to/pipeline.sh"
PIPELINE_START="2026-06-30T00:00:00Z"
PIPELINE_ID="test-re-$$"
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

LOG_DIR="$(mktemp -d)"
PIPELINE_LOCK_DIR="$(mktemp -d)"
REPO="/tmp/fake-repo"

_source_pipeline_lib() {
  set -- /dev/null
  # shellcheck disable=SC1090
  source "$PIPELINE_SH"
}
_source_pipeline_lib

# Restore LOG_DIR/PIPELINE_LOCK_DIR after sourcing (pipeline.sh resets some vars)
LOG_DIR="$(mktemp -d)"
PIPELINE_LOCK_DIR="$(mktemp -d)"

TMP_DIR="$(mktemp -d)"
LOCK_ROOT="$(mktemp -d)"
export PIPELINE_LOCK_ROOT="$LOCK_ROOT"
PIPELINE_REGISTRY_ROOT="$(mktemp -d)"
export PIPELINE_REGISTRY_ROOT

trap 'rm -rf "$TMP_DIR" "$LOG_DIR" "$PIPELINE_LOCK_DIR" "$CONFIG_FILE" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT"' EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Fixture helpers
# ─────────────────────────────────────────────────────────────────────────────

# make_config <file> [issue1 issue2 ...]
make_config() {
  local file="$1"
  shift
  local issues="${*:-10 20 30}"
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

# make_status <file> <config_file> <config_sha256> <log_dir> <pipeline_id>
# [next_issue_index] [issues_total_json] [issues_completed_json] [issues_skipped_json]
make_status() {
  local file="$1" config_file="$2" config_sha256="$3" log_dir="$4" pipeline_id="$5"
  local next_idx="${6:-1}"
  local issues_total="${7:-[10,20,30]}"
  local issues_completed="${8:-[10]}"
  local issues_skipped="${9:-[]}"
  cat > "$file" <<EOF
{
  "schema_version": 2,
  "pipeline_state": "paused",
  "version": "1.1.0",
  "resume_supported": true,
  "checkpoint": "between-issues",
  "pipeline_id": "$pipeline_id",
  "pid": 99999,
  "current_agent_pid": null,
  "config_file": "$config_file",
  "config_sha256": "$config_sha256",
  "log_dir": "$log_dir",
  "next_issue_index": $next_idx,
  "issues_total": $issues_total,
  "issues_completed": $issues_completed,
  "issues_skipped": $issues_skipped
}
EOF
}

# lock_name <repo_canonical>
get_lock_dir() {
  local repo_canonical="$1"
  local base hash safe_base
  base=$(basename "$repo_canonical")
  safe_base=$(printf '%s' "$base" | tr -cs 'A-Za-z0-9._-' '-')
  hash=$(printf '%s' "$repo_canonical" | sha256sum | awk '{print $1}' | cut -c1-12)
  printf '%s/%s-%s.lock' "$LOCK_ROOT" "$safe_base" "$hash"
}

reset_state() {
  ISSUES_COMPLETED=()
  ISSUES_COMPLETED_DETAILS=()
  ISSUES_SKIPPED=()
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
  PIPELINE_LOCK_DIR="$(mktemp -d)"
  LOG_DIR="$(mktemp -d)"
}

# Helper: run resume_entrypoint in a clean subprocess to avoid readonly var conflicts.
# Usage: run_resume_in_subprocess <status_file> <lock_root> <registry_root>
# Exits with same exit code as resume_entrypoint; all output goes to stderr.
run_resume_in_subprocess() {
  local status_file="$1" lock_root="$2" registry_root="$3"
  env -i PATH="$PATH" HOME="$HOME" \
    bash -c "
      set -uo pipefail
      PIPELINE_LIB_MODE=1 source '$PIPELINE_SH'
      PIPELINE_LOCK_ROOT='$lock_root'
      PIPELINE_REGISTRY_ROOT='$registry_root'
      canonical_repo_path() { echo '/tmp/fake-repo'; }
      log() { :; }
      write_registry_entry() { :; }
      resume_entrypoint '$status_file'
    " 2>&1
}

# ─────────────────────────────────────────────────────────────────────────────
# Tests 6 & 7: CLI argument validation (subprocess invocations)
# These must run before any state is mutated, using subprocess calls.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 6: --resume with no path exits nonzero ==="

if PIPELINE_LIB_MODE=0 bash "$PIPELINE_SH" --resume 2>/tmp/re_stderr_$$.txt; then
  fail "--resume with no path: should exit nonzero"
else
  err6=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  if echo "$err6" | grep -qi "requires\|status.json\|path\|usage\|error"; then
    ok "--resume with no path: exits nonzero with usage/error message"
  else
    fail "--resume with no path: expected usage/error in stderr" "$err6"
  fi
fi
rm -f /tmp/re_stderr_$$.txt

echo ""
echo "=== Test 7: --resume with extra arg exits nonzero ==="

if PIPELINE_LIB_MODE=0 bash "$PIPELINE_SH" --resume /some/path.json extra_arg 2>/tmp/re_stderr_$$.txt; then
  fail "--resume with extra arg: should exit nonzero"
else
  err7=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  if echo "$err7" | grep -qi "extra\|usage\|error"; then
    ok "--resume with extra arg: exits nonzero with usage/error message"
  else
    fail "--resume with extra arg: expected extra/usage/error in stderr" "$err7"
  fi
fi
rm -f /tmp/re_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Stub canonical_repo_path for in-process tests (no real repo needed)
# ─────────────────────────────────────────────────────────────────────────────
canonical_repo_path() { echo "/tmp/fake-repo"; }
log() { echo "[TEST-LOG] $*" >/dev/null; }
write_registry_entry() { :; }   # stub: no real registry needed for most tests

# ─────────────────────────────────────────────────────────────────────────────
# Test 8: Validation failure leaves status file unchanged
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 8: Validation failure writes blocked (schema v2) ==="

reset_state
cfg8="$TMP_DIR/cfg8.sh"
make_config "$cfg8"
sha8=$(compute_file_sha256 "$cfg8")
st8="$TMP_DIR/st8.json"
# Make it a running (not paused) status — validation should refuse
make_status "$st8" "$cfg8" "$sha8" "$LOG_DIR" "pipe-8"
python3 -c "import json; d=json.load(open('$st8')); d['pipeline_state']='running'; json.dump(d,open('$st8','w'))"

# resume_entrypoint calls exit on failure; run in subprocess to capture
if run_resume_in_subprocess "$st8" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "validation failure: resume_entrypoint should exit nonzero"
else
  ok "validation failure: resume_entrypoint exits nonzero"
fi
# Phase 5G: schema v2 with invalid state → blocked is written to arg path
assert_json_field "validation failure: pipeline_state=blocked" "$st8" "pipeline_state" "blocked"
resume_err8=$(python3 -c "
import json
d = json.load(open('$st8'))
print('present' if d.get('resume_error') else 'missing')
" 2>/dev/null)
assert_eq "validation failure: resume_error present" "present" "$resume_err8"
assert_json_field "validation failure: pipeline_id preserved" "$st8" "pipeline_id" "pipe-8"
rm -f /tmp/re_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 5: Missing LOG_DIR refused before lock/status mutation
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 5: Missing LOG_DIR writes blocked to arg path ==="

reset_state
cfg5="$TMP_DIR/cfg5.sh"
make_config "$cfg5"
sha5=$(compute_file_sha256 "$cfg5")
st5="$TMP_DIR/st5.json"
nonexistent_log="/tmp/nonexistent_log_dir_$$"
make_status "$st5" "$cfg5" "$sha5" "$nonexistent_log" "pipe-5"

lock_dir5=$(get_lock_dir "/tmp/fake-repo")
# Ensure no lock exists before
rm -rf "$lock_dir5"

if run_resume_in_subprocess "$st5" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "missing LOG_DIR: should exit nonzero"
else
  err5=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  if echo "$err5" | grep -qi "log\|directory\|not exist"; then
    ok "missing LOG_DIR: exits nonzero with log/directory message"
  else
    fail "missing LOG_DIR: expected log/directory in error" "$err5"
  fi
fi
# Phase 5G: missing log_dir on a valid schema v2 file → blocked written
assert_json_field "missing LOG_DIR: pipeline_state=blocked" "$st5" "pipeline_state" "blocked"
resume_err5=$(python3 -c "
import json
d = json.load(open('$st5'))
print('present' if d.get('resume_error') else 'missing')
" 2>/dev/null)
assert_eq "missing LOG_DIR: resume_error present" "present" "$resume_err5"
# Lock must NOT have been acquired
if [ ! -d "$lock_dir5" ]; then
  ok "missing LOG_DIR: no lock created"
else
  fail "missing LOG_DIR: lock should not have been created"
  rm -rf "$lock_dir5"
fi
rm -f /tmp/re_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# Test 1: Happy path — state restored, no existing lock
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 1: Happy path — state restored, no existing lock ==="

reset_state
cfg1="$TMP_DIR/cfg1.sh"
make_config "$cfg1"
sha1=$(compute_file_sha256 "$cfg1")
log_dir1="$(mktemp -d)"
st1="$TMP_DIR/st1.json"
make_status "$st1" "$cfg1" "$sha1" "$log_dir1" "pipe-happy-$$" "1" "[10,20,30]" "[10]" "[]"

lock_dir1=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dir1"

# Run resume_entrypoint in the current shell (not subprocess) so we can
# inspect the resulting globals.
PIPELINE_LOCK_ROOT="$LOCK_ROOT"

if resume_entrypoint "$st1" 2>/tmp/re_stderr_$$.txt; then
  ok "happy path: resume_entrypoint returns 0"
else
  err1=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  fail "happy path: resume_entrypoint returns 0" "$err1"
fi

assert_eq "happy path: PIPELINE_ID preserved"     "pipe-happy-$$"     "$PIPELINE_ID"
assert_eq "happy path: NEXT_ISSUE_INDEX restored" "1"                 "$NEXT_ISSUE_INDEX"
assert_eq "happy path: ISSUES_COMPLETED[0]=10"    "10"                "${ISSUES_COMPLETED[0]:-}"
assert_eq "happy path: ISSUES_COMPLETED length=1" "1"                 "${#ISSUES_COMPLETED[@]}"
assert_eq "happy path: ISSUES_SKIPPED empty"      "0"                 "${#ISSUES_SKIPPED[@]}"
assert_eq "happy path: LOG_DIR from status"       "$log_dir1"         "$LOG_DIR"
assert_eq "happy path: IS_PAUSED reset to 0"      "0"                 "$IS_PAUSED"
assert_eq "happy path: PAUSED_AT cleared"         ""                  "$PAUSED_AT"

# Status file written as running
assert_json_field "happy path: status=running"    "$log_dir1/status.json" "pipeline_state" "running"
assert_json_field "happy path: resume_supported=false" "$log_dir1/status.json" "resume_supported" "false"

# Lock acquired
if [ -d "$lock_dir1" ]; then
  ok "happy path: lock directory created"
  lock_pid1=$(cat "$lock_dir1/pid" 2>/dev/null || true)
  assert_eq "happy path: lock PID is current process" "$$" "$lock_pid1"
else
  fail "happy path: lock directory should exist"
fi
rm -f /tmp/re_stderr_$$.txt
# Clean up lock for subsequent tests
rm -rf "$lock_dir1"

# ─────────────────────────────────────────────────────────────────────────────
# Test 9: Pipeline ID preserved in lock metadata and status file
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 9: Pipeline ID preserved in lock metadata and status ==="

reset_state
cfg9="$TMP_DIR/cfg9.sh"
make_config "$cfg9"
sha9=$(compute_file_sha256 "$cfg9")
log_dir9="$(mktemp -d)"
st9="$TMP_DIR/st9.json"
pipe_id9="pipeline-id-preserved-$$"
make_status "$st9" "$cfg9" "$sha9" "$log_dir9" "$pipe_id9" "1" "[10,20,30]" "[10]" "[]"

lock_dir9=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dir9"

if resume_entrypoint "$st9" 2>/dev/null; then
  ok "test 9: resume_entrypoint returns 0"
else
  fail "test 9: resume_entrypoint returns 0"
fi

# Check lock metadata
if [ -f "$lock_dir9/metadata" ]; then
  meta9=$(cat "$lock_dir9/metadata")
  if echo "$meta9" | grep -q "^pipeline_id=${pipe_id9}$"; then
    ok "test 9: pipeline_id in lock metadata matches original"
  else
    fail "test 9: pipeline_id in lock metadata" "$(grep '^pipeline_id=' "$lock_dir9/metadata" 2>/dev/null)"
  fi
else
  fail "test 9: lock metadata file exists"
fi

# Check status.json
assert_json_field "test 9: pipeline_id in status matches original" \
  "$log_dir9/status.json" "pipeline_id" "$pipe_id9"

rm -rf "$lock_dir9"

# ─────────────────────────────────────────────────────────────────────────────
# Test 2: Stale same-owner lock is reclaimed
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 2: Stale same-owner lock is reclaimed ==="

reset_state
cfg2="$TMP_DIR/cfg2.sh"
make_config "$cfg2"
sha2=$(compute_file_sha256 "$cfg2")
log_dir2="$(mktemp -d)"
st2="$TMP_DIR/st2.json"
pipe_id2="stale-same-owner-$$"
make_status "$st2" "$cfg2" "$sha2" "$log_dir2" "$pipe_id2" "1" "[10,20,30]" "[10]" "[]"

lock_dir2=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dir2"

# Create a stale lock with a dead PID but matching pipeline_id
mkdir "$lock_dir2"
echo "99999999" > "$lock_dir2/pid"   # almost certainly dead
echo "pipeline_id=$pipe_id2" > "$lock_dir2/metadata"
echo "state=paused" >> "$lock_dir2/metadata"
echo "pid=99999999" >> "$lock_dir2/metadata"

if resume_entrypoint "$st2" 2>/tmp/re_stderr_$$.txt; then
  ok "stale same-owner lock: resume_entrypoint returns 0 (reclaimed)"
  new_pid2=$(cat "$lock_dir2/pid" 2>/dev/null || true)
  assert_eq "stale same-owner lock: new PID is current process" "$$" "$new_pid2"
  if grep -q "^pipeline_id=${pipe_id2}$" "$lock_dir2/metadata" 2>/dev/null; then
    ok "stale same-owner lock: pipeline_id preserved in reclaimed metadata"
  else
    fail "stale same-owner lock: pipeline_id preserved in reclaimed metadata" \
      "$(grep '^pipeline_id=' "$lock_dir2/metadata" 2>/dev/null)"
  fi
else
  err2=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  fail "stale same-owner lock: should succeed" "$err2"
fi
rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dir2"

# ─────────────────────────────────────────────────────────────────────────────
# Test 3: Stale foreign lock is refused and left unchanged
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 3: Stale foreign lock — blocked written, foreign lock preserved ==="

reset_state
cfg3="$TMP_DIR/cfg3.sh"
make_config "$cfg3"
sha3=$(compute_file_sha256 "$cfg3")
log_dir3="$(mktemp -d)"
st3="$TMP_DIR/st3.json"
pipe_id3="new-resume-$$"
make_status "$st3" "$cfg3" "$sha3" "$log_dir3" "$pipe_id3" "1" "[10,20,30]" "[10]" "[]"

lock_dir3=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dir3"

# Create a stale lock with a dead PID but DIFFERENT pipeline_id (foreign)
mkdir "$lock_dir3"
echo "99999998" > "$lock_dir3/pid"
echo "pipeline_id=totally-different-pipeline-id" > "$lock_dir3/metadata"
echo "state=running" >> "$lock_dir3/metadata"
echo "pid=99999998" >> "$lock_dir3/metadata"
foreign_meta3=$(cat "$lock_dir3/metadata")

if run_resume_in_subprocess "$st3" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "stale foreign lock: should exit nonzero"
else
  err3=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  if echo "$err3" | grep -qi "foreign\|different\|pipeline_id\|refusing\|stale"; then
    ok "stale foreign lock: exits nonzero with foreign/refusing message"
  else
    fail "stale foreign lock: expected foreign/refusing in stderr" "$err3"
  fi
fi

# Lock must be unchanged (foreign lock preservation)
if [ -f "$lock_dir3/metadata" ]; then
  actual_meta3=$(cat "$lock_dir3/metadata")
  assert_eq "stale foreign lock: lock metadata unchanged" "$foreign_meta3" "$actual_meta3"
else
  fail "stale foreign lock: lock metadata file should still exist"
fi

# Phase 5G: blocked is written to the arg path (valid schema v2)
assert_json_field "stale foreign lock: pipeline_state=blocked" "$st3" "pipeline_state" "blocked"
resume_err3=$(python3 -c "
import json
d = json.load(open('$st3'))
print('present' if d.get('resume_error') else 'missing')
" 2>/dev/null)
assert_eq "stale foreign lock: resume_error present" "present" "$resume_err3"
assert_json_field "stale foreign lock: pipeline_id preserved" "$st3" "pipeline_id" "$pipe_id3"

rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dir3"

# ─────────────────────────────────────────────────────────────────────────────
# Test 4: Live lock is refused and status unchanged
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 4: Live lock — blocked written, lock PID unchanged ==="

reset_state
cfg4="$TMP_DIR/cfg4.sh"
make_config "$cfg4"
sha4=$(compute_file_sha256 "$cfg4")
log_dir4="$(mktemp -d)"
st4="$TMP_DIR/st4.json"
make_status "$st4" "$cfg4" "$sha4" "$log_dir4" "live-lock-test-$$" "1" "[10,20,30]" "[10]" "[]"

lock_dir4=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dir4"

# Create a lock with a live PID (current shell) — simulate active pipeline
mkdir "$lock_dir4"
echo "$$" > "$lock_dir4/pid"
echo "pid=$$" > "$lock_dir4/metadata"
echo "pipeline_id=some-other-pipeline" >> "$lock_dir4/metadata"
echo "state=running" >> "$lock_dir4/metadata"

if run_resume_in_subprocess "$st4" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "live lock: should exit nonzero"
else
  err4=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  if echo "$err4" | grep -qi "alive\|live\|refusing\|stop\|existing\|held"; then
    ok "live lock: exits nonzero with alive/refusing message"
  else
    fail "live lock: expected alive/refusing in stderr" "$err4"
  fi
fi

# Phase 5G: blocked is written to arg path
assert_json_field "live lock: pipeline_state=blocked" "$st4" "pipeline_state" "blocked"
resume_err4=$(python3 -c "
import json
d = json.load(open('$st4'))
print('present' if d.get('resume_error') else 'missing')
" 2>/dev/null)
assert_eq "live lock: resume_error present" "present" "$resume_err4"

# Lock PID must still be $$ (unchanged)
lock_pid4=$(cat "$lock_dir4/pid" 2>/dev/null || true)
assert_eq "live lock: lock PID unchanged" "$$" "$lock_pid4"

rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dir4"

# ─────────────────────────────────────────────────────────────────────────────
# Test 10: Skip guard skips completed/skipped issues; does not skip fresh ones
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 10: Skip guard correctness ==="

# Simulate the skip guard logic directly (the main loop logic, extracted)
_test_skip_guard() {
  local issue="$1"
  local -a completed=("${!2}")
  local -a skipped=("${!3}")
  local _already_processed=0
  for _prev in "${completed[@]:-}"; do
    [ "$_prev" = "$issue" ] && { _already_processed=1; break; }
  done
  if [ "$_already_processed" = "0" ]; then
    for _prev in "${skipped[@]:-}"; do
      [ "$_prev" = "$issue" ] && { _already_processed=1; break; }
    done
  fi
  echo "$_already_processed"
}

completed_arr=(10 20)
skipped_arr=(15)

# Completed issue is skipped
result=$(_test_skip_guard "10" completed_arr[@] skipped_arr[@])
assert_eq "skip guard: completed issue 10 → already_processed=1" "1" "$result"

# Skipped issue is skipped
result=$(_test_skip_guard "15" completed_arr[@] skipped_arr[@])
assert_eq "skip guard: skipped issue 15 → already_processed=1" "1" "$result"

# Fresh issue is not skipped
result=$(_test_skip_guard "30" completed_arr[@] skipped_arr[@])
assert_eq "skip guard: fresh issue 30 → already_processed=0" "0" "$result"

# Empty arrays (fresh start) — nothing is skipped
empty_arr=()
result=$(_test_skip_guard "10" empty_arr[@] empty_arr[@])
assert_eq "skip guard: empty arrays → already_processed=0 (fresh start)" "0" "$result"
result=$(_test_skip_guard "30" empty_arr[@] empty_arr[@])
assert_eq "skip guard: empty arrays, issue 30 → already_processed=0" "0" "$result"

# ─────────────────────────────────────────────────────────────────────────────
# Test 11: All-done cursor (next_issue_index == len(issues_total))
# resume_entrypoint succeeds and state is correctly restored
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 11: All-done cursor (next_issue_index == 3 == len) ==="

reset_state
cfg11="$TMP_DIR/cfg11.sh"
make_config "$cfg11"
sha11=$(compute_file_sha256 "$cfg11")
log_dir11="$(mktemp -d)"
st11="$TMP_DIR/st11.json"
pipe_id11="all-done-$$"
# All 3 issues completed, next_issue_index=3 (== len)
make_status "$st11" "$cfg11" "$sha11" "$log_dir11" "$pipe_id11" "3" "[10,20,30]" "[10,20,30]" "[]"

lock_dir11=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dir11"

if resume_entrypoint "$st11" 2>/tmp/re_stderr_$$.txt; then
  ok "all-done cursor: resume_entrypoint returns 0"
  assert_eq "all-done cursor: NEXT_ISSUE_INDEX=3"        "3"  "$NEXT_ISSUE_INDEX"
  assert_eq "all-done cursor: ISSUES_COMPLETED length=3" "3"  "${#ISSUES_COMPLETED[@]}"
  assert_eq "all-done cursor: PIPELINE_ID preserved"     "$pipe_id11" "$PIPELINE_ID"
  assert_eq "all-done cursor: IS_PAUSED=0"               "0"  "$IS_PAUSED"
  assert_json_field "all-done cursor: status=running" "$log_dir11/status.json" "pipeline_state" "running"
else
  err11=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  fail "all-done cursor: resume_entrypoint returns 0" "$err11"
fi
rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dir11"

# ─────────────────────────────────────────────────────────────────────────────
# Test 12: Normal config startup path reaches validation without resolve_skill errors
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 12: Normal startup path does not call undefined resolve_skill ==="

cfg12="$TMP_DIR/cfg12.sh"
cat > "$cfg12" <<'CFG12'
REPO="/tmp/definitely-not-a-repo-for-resume-entrypoint-test"
WORKTREE_BASE="/tmp/fake-worktrees"
OWNER_REPO="org/repo"
AI_REVIEW_PROVIDER="ghe-pr-bot"
AI_REVIEW_API_BASE="https://github.example.com/api/v3"
ISSUES=(10)
BRANCHES=("issue-10")
CFG12

if PIPELINE_LIB_MODE=0 bash "$PIPELINE_SH" "$cfg12" 2>/tmp/re_stderr_$$.txt; then
  fail "normal startup invalid repo should exit nonzero"
else
  err12=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  if echo "$err12" | grep -q "resolve_skill"; then
    fail "normal startup should not call undefined resolve_skill" "$err12"
  else
    ok "normal startup reaches validation without resolve_skill error"
  fi
  if echo "$err12" | grep -qi "Config validation failed\|not a git repository"; then
    ok "normal startup invalid repo fails at validation"
  else
    fail "normal startup invalid repo should report validation failure" "$err12"
  fi
fi
rm -f /tmp/re_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# T-A: Validation failure on v2 paused status (sha mismatch) writes blocked
#      + bounded resume_error + preserves core fields
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-A: Validation failure writes blocked + resume_error to arg path ==="

reset_state
cfgTA="$TMP_DIR/cfgTA.sh"
make_config "$cfgTA"
# Intentionally wrong SHA so validation fails with config-sha-mismatch
stTA="$TMP_DIR/stTA.json"
log_dirTA="$(mktemp -d)"
make_status "$stTA" "$cfgTA" "000000000000wrongsha" "$log_dirTA" "pipe-TA"

if run_resume_in_subprocess "$stTA" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "T-A: resume_entrypoint should exit nonzero on validation failure"
else
  ok "T-A: resume_entrypoint exits nonzero"
fi

# pipeline_state must be blocked
assert_json_field "T-A: pipeline_state=blocked" "$stTA" "pipeline_state" "blocked"
# resume_error must be non-null and non-empty
resume_errTA=$(python3 -c "
import sys, json
try:
    d = json.load(open('$stTA'))
    v = d.get('resume_error', '')
    print('present' if v else 'missing')
except Exception:
    print('error')
" 2>/dev/null)
assert_eq "T-A: resume_error is present" "present" "$resume_errTA"
# resume_error must be <= 512 chars
resume_err_lenTA=$(python3 -c "
import json
d = json.load(open('$stTA'))
print(len(d.get('resume_error', '')))
" 2>/dev/null)
if [ -n "$resume_err_lenTA" ] && [ "$resume_err_lenTA" -le 512 ]; then
  ok "T-A: resume_error length is bounded (<= 512 chars): $resume_err_lenTA"
else
  fail "T-A: resume_error length bounded" "len=$resume_err_lenTA"
fi
# Core fields preserved
assert_json_field "T-A: pipeline_id preserved" "$stTA" "pipeline_id" "pipe-TA"
assert_json_field "T-A: schema_version preserved" "$stTA" "schema_version" "2"
rm -f /tmp/re_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# T-B: Invalid JSON at argument path remains unchanged
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-B: Invalid JSON at arg path — no write, exit nonzero ==="

reset_state
stTB="$TMP_DIR/stTB.json"
echo '{not valid json' > "$stTB"
before_TB=$(cat "$stTB")

if run_resume_in_subprocess "$stTB" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "T-B: should exit nonzero for invalid JSON"
else
  ok "T-B: exits nonzero for invalid JSON"
fi
assert_eq "T-B: invalid JSON file unchanged" "$before_TB" "$(cat "$stTB")"
rm -f /tmp/re_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# T-C: Schema v1 at argument path remains unchanged
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-C: Schema v1 at arg path — no write, exit nonzero ==="

reset_state
stTC="$TMP_DIR/stTC.json"
cat > "$stTC" <<'EOF'
{
  "schema_version": 1,
  "pipeline_state": "paused",
  "resume_supported": false
}
EOF
before_TC=$(cat "$stTC")

if run_resume_in_subprocess "$stTC" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "T-C: should exit nonzero for schema v1"
else
  ok "T-C: exits nonzero for schema v1"
fi
assert_eq "T-C: schema v1 file unchanged" "$before_TC" "$(cat "$stTC")"
rm -f /tmp/re_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# T-D: Nonexistent log_dir after validation writes blocked to arg path
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-D: Nonexistent log_dir writes blocked to arg path ==="

reset_state
cfgTD="$TMP_DIR/cfgTD.sh"
make_config "$cfgTD"
shaTD=$(compute_file_sha256 "$cfgTD")
stTD="$TMP_DIR/stTD.json"
nonexistent_logTD="/tmp/nonexistent_logdir_TD_$$"
make_status "$stTD" "$cfgTD" "$shaTD" "$nonexistent_logTD" "pipe-TD"

if run_resume_in_subprocess "$stTD" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "T-D: should exit nonzero for missing log_dir"
else
  ok "T-D: exits nonzero for missing log_dir"
fi
assert_json_field "T-D: pipeline_state=blocked" "$stTD" "pipeline_state" "blocked"
resume_errTD=$(python3 -c "
import json
d = json.load(open('$stTD'))
print('present' if d.get('resume_error') else 'missing')
" 2>/dev/null)
assert_eq "T-D: resume_error present" "present" "$resume_errTD"
assert_json_field "T-D: pipeline_id preserved" "$stTD" "pipeline_id" "pipe-TD"
rm -f /tmp/re_stderr_$$.txt

# ─────────────────────────────────────────────────────────────────────────────
# T-E: Stale foreign lock writes blocked and preserves the foreign lock
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-E: Stale foreign lock — blocked written, foreign lock preserved ==="

reset_state
cfgTE="$TMP_DIR/cfgTE.sh"
make_config "$cfgTE"
shaTE=$(compute_file_sha256 "$cfgTE")
log_dirTE="$(mktemp -d)"
stTE="$TMP_DIR/stTE.json"
make_status "$stTE" "$cfgTE" "$shaTE" "$log_dirTE" "pipe-TE" "1" "[10,20,30]" "[10]" "[]"

lock_dirTE=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dirTE"
mkdir "$lock_dirTE"
echo "99999997" > "$lock_dirTE/pid"
echo "pipeline_id=foreign-pipeline-id" > "$lock_dirTE/metadata"
echo "state=running" >> "$lock_dirTE/metadata"
foreign_metaTE=$(cat "$lock_dirTE/metadata")

if run_resume_in_subprocess "$stTE" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >/tmp/re_stderr_$$.txt 2>&1; then
  fail "T-E: should exit nonzero for stale foreign lock"
else
  ok "T-E: exits nonzero for stale foreign lock"
fi
assert_json_field "T-E: pipeline_state=blocked" "$stTE" "pipeline_state" "blocked"
resume_errTE=$(python3 -c "
import json
d = json.load(open('$stTE'))
print('present' if d.get('resume_error') else 'missing')
" 2>/dev/null)
assert_eq "T-E: resume_error present" "present" "$resume_errTE"
# Foreign lock must be intact
if [ -f "$lock_dirTE/metadata" ]; then
  actual_metaTE=$(cat "$lock_dirTE/metadata")
  assert_eq "T-E: foreign lock metadata unchanged" "$foreign_metaTE" "$actual_metaTE"
else
  fail "T-E: foreign lock metadata must still exist"
fi
assert_json_field "T-E: pipeline_id preserved" "$stTE" "pipeline_id" "pipe-TE"
rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dirTE"

# ─────────────────────────────────────────────────────────────────────────────
# T-F: Successful resume does not leave resume_error in the written status
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-F: Successful resume does not leave resume_error ==="

reset_state
cfgTF="$TMP_DIR/cfgTF.sh"
make_config "$cfgTF"
shaTF=$(compute_file_sha256 "$cfgTF")
log_dirTF="$(mktemp -d)"
stTF="$log_dirTF/status.json"  # Note: write_status writes to LOG_DIR/status.json
make_status "$stTF" "$cfgTF" "$shaTF" "$log_dirTF" "pipe-TF" "1" "[10,20,30]" "[10]" "[]"

lock_dirTF=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dirTF"

if resume_entrypoint "$stTF" 2>/tmp/re_stderr_$$.txt; then
  ok "T-F: successful resume returns 0"
  # Check no resume_error field in written status
  resume_errTF=$(python3 -c "
import json
d = json.load(open('$stTF'))
print('absent' if 'resume_error' not in d or d['resume_error'] is None else 'present')
" 2>/dev/null)
  assert_eq "T-F: no resume_error in written status" "absent" "$resume_errTF"
  assert_json_field "T-F: pipeline_state=running after success" "$stTF" "pipeline_state" "running"
else
  errTF=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  fail "T-F: resume_entrypoint should succeed" "$errTF"
fi
rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dirTF"

# ─────────────────────────────────────────────────────────────────────────────
# T-G: Status path whose parent directory does not exist — clear error, no junk
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-G: Missing status path with non-existent parent directory ==="

reset_state
# Construct a path whose parent directory does not exist.
missing_parent_dir="/tmp/no_such_parent_dir_$$"
missing_st="$missing_parent_dir/status.json"
rm -rf "$missing_parent_dir"

# run_resume_in_subprocess or direct resume_entrypoint must exit nonzero.
stderrTG=$(mktemp)
if run_resume_in_subprocess "$missing_st" "$LOCK_ROOT" "$PIPELINE_REGISTRY_ROOT" >"$stderrTG" 2>&1; then
  fail "T-G: should exit nonzero for missing status path with non-existent parent"
else
  ok "T-G: exits nonzero for missing status path with non-existent parent"
fi

err_outputTG=$(cat "$stderrTG")
# stderr must mention the status file problem, not a temp-file redirection error.
if echo "$err_outputTG" | grep -qi "status file"; then
  ok "T-G: stderr mentions 'status file'"
else
  fail "T-G: stderr should mention 'status file' (got: $err_outputTG)"
fi
# stderr must NOT expose the internal temp-file name.
if echo "$err_outputTG" | grep -q "\.re_validate_err"; then
  fail "T-G: stderr must not expose temp error filename (got: $err_outputTG)"
else
  ok "T-G: stderr does not leak temp filename"
fi
# stderr must NOT be a raw 'No such file or directory' for the redirection itself.
if echo "$err_outputTG" | grep -q "No such file or directory" && \
   ! echo "$err_outputTG" | grep -qi "status file"; then
  fail "T-G: stderr is raw OS redirection error, not a clear validation message (got: $err_outputTG)"
else
  ok "T-G: stderr is not a raw OS redirection error without context"
fi
# No file must have been created at the missing path.
if [ -e "$missing_st" ]; then
  fail "T-G: must not create file at missing status path"
else
  ok "T-G: no file created at missing status path"
fi
rm -f "$stderrTG"
rm -rf "$missing_parent_dir"


# ─────────────────────────────────────────────────────────────────────────────
# T-H: Valid completed details are restored in ISSUES_COMPLETED_DETAILS after resume
# and re-emitted in the first write_status "running" call.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-H: Valid details restored and re-emitted on first running status ==="

reset_state
cfgTH="$TMP_DIR/cfgTH.sh"
make_config "$cfgTH"
shaTH=$(compute_file_sha256 "$cfgTH")
log_dirTH="$(mktemp -d)"
stTH="$log_dirTH/status.json"
make_status "$stTH" "$cfgTH" "$shaTH" "$log_dirTH" "pipe-TH" "1" "[10,20,30]" "[10]" "[]"
# Inject valid completed details for issue 10
python3 -c "
import json
d = json.load(open('$stTH'))
d['issues_completed_details'] = [
  {\"issue\": 10, \"pr\": 77, \"started_at\": \"2026-01-01T00:00:00Z\",
   \"completed_at\": \"2026-01-01T00:10:00Z\", \"duration_seconds\": 600}
]
json.dump(d, open('$stTH', 'w'))
"

lock_dirTH=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dirTH"

if resume_entrypoint "$stTH" 2>/tmp/re_stderr_$$.txt; then
  ok "T-H: resume_entrypoint returns 0 with valid details"
  # ISSUES_COMPLETED_DETAILS must be non-empty
  if [ "${#ISSUES_COMPLETED_DETAILS[@]}" -gt 0 ]; then
    ok "T-H: ISSUES_COMPLETED_DETAILS is non-empty"
  else
    fail "T-H: ISSUES_COMPLETED_DETAILS should be non-empty"
  fi
  # First element must be a compact JSON object with .issue == 10
  first_detailTH="${ISSUES_COMPLETED_DETAILS[0]:-}"
  issue_valTH=$(printf '%s' "$first_detailTH" | jq -r '.issue' 2>/dev/null || echo "ERR")
  assert_eq "T-H: ISSUES_COMPLETED_DETAILS[0] .issue == 10" "10" "$issue_valTH"
  pr_valTH=$(printf '%s' "$first_detailTH" | jq -r '.pr' 2>/dev/null || echo "ERR")
  assert_eq "T-H: ISSUES_COMPLETED_DETAILS[0] .pr == 77" "77" "$pr_valTH"
  # Verify the written status.json includes the restored detail
  if [ -f "$log_dirTH/status.json" ]; then
    detail_count_TH=$(jq '.issues_completed_details | length' "$log_dirTH/status.json" 2>/dev/null || echo 0)
    assert_eq "T-H: status.json issues_completed_details has 1 record" "1" "$detail_count_TH"
    status_pr_TH=$(jq -r '.issues_completed_details[0].pr' "$log_dirTH/status.json" 2>/dev/null || echo "ERR")
    assert_eq "T-H: status.json issues_completed_details[0].pr == 77" "77" "$status_pr_TH"
  else
    fail "T-H: status.json should exist after resume"
  fi
else
  errTH=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  fail "T-H: resume_entrypoint should succeed" "$errTH"
fi
rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dirTH"

# ─────────────────────────────────────────────────────────────────────────────
# T-I: Missing/null/non-array details do not fail resume; ISSUES_COMPLETED_DETAILS empty
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-I: Missing/null/non-array details do not fail resume ==="

for variantTI in missing null string; do
  reset_state
  cfgTI="$TMP_DIR/cfgTI_${variantTI}.sh"
  make_config "$cfgTI"
  shaTI=$(compute_file_sha256 "$cfgTI")
  log_dirTI="$(mktemp -d)"
  stTI="$log_dirTI/status.json"
  make_status "$stTI" "$cfgTI" "$shaTI" "$log_dirTI" "pipe-TI-${variantTI}" "1" "[10,20,30]" "[10]" "[]"
  case "$variantTI" in
    missing)
      python3 -c "import json; d=json.load(open('$stTI')); del d['issues_completed_details']; json.dump(d,open('$stTI','w'))" 2>/dev/null || true
      ;;
    null)
      python3 -c "import json; d=json.load(open('$stTI')); d['issues_completed_details']=None; json.dump(d,open('$stTI','w'))"
      ;;
    string)
      python3 -c "import json; d=json.load(open('$stTI')); d['issues_completed_details']='bad'; json.dump(d,open('$stTI','w'))"
      ;;
  esac
  lock_dirTI=$(get_lock_dir "/tmp/fake-repo")
  rm -rf "$lock_dirTI"
  if resume_entrypoint "$stTI" 2>/tmp/re_stderr_$$.txt; then
    ok "T-I ($variantTI): resume_entrypoint returns 0"
    assert_eq "T-I ($variantTI): ISSUES_COMPLETED_DETAILS empty" "0" "${#ISSUES_COMPLETED_DETAILS[@]}"
  else
    errTI=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
    fail "T-I ($variantTI): resume should not fail due to bad details" "$errTI"
  fi
  rm -f /tmp/re_stderr_$$.txt
  rm -rf "$lock_dirTI"
done

# ─────────────────────────────────────────────────────────────────────────────
# T-J: Invalid/extra/duplicate records filtered; first valid duplicate kept; original order preserved
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-J: Invalid/extra/dup records filtered; order preserved ==="

reset_state
cfgTJ="$TMP_DIR/cfgTJ.sh"
make_config "$cfgTJ"
shaTJ=$(compute_file_sha256 "$cfgTJ")
log_dirTJ="$(mktemp -d)"
stTJ="$log_dirTJ/status.json"
# Two completed issues (10 and 20), next_issue_index=2
make_status "$stTJ" "$cfgTJ" "$shaTJ" "$log_dirTJ" "pipe-TJ" "2" "[10,20,30]" "[10,20]" "[]"
# Details:
#   valid record for issue 10 (pr=1) — first
#   non-object element
#   valid record for issue 20 (pr=2) — valid
#   stale: issue 30 not completed
#   duplicate issue 10 (pr=9) — must be filtered; first (pr=1) wins
python3 -c "
import json
d = json.load(open('$stTJ'))
d['issues_completed_details'] = [
  {\"issue\": 10, \"pr\": 1, \"duration_seconds\": 100},
  42,
  {\"issue\": 20, \"pr\": 2, \"duration_seconds\": 200},
  {\"issue\": 30, \"pr\": 3},
  {\"issue\": 10, \"pr\": 9, \"duration_seconds\": 999}
]
json.dump(d, open('$stTJ', 'w'))
"

lock_dirTJ=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dirTJ"

if resume_entrypoint "$stTJ" 2>/tmp/re_stderr_$$.txt; then
  ok "T-J: resume_entrypoint returns 0"
  assert_eq "T-J: ISSUES_COMPLETED_DETAILS length == 2" "2" "${#ISSUES_COMPLETED_DETAILS[@]}"
  # Order preserved: issue 10 first, issue 20 second
  iss0_TJ=$(printf '%s' "${ISSUES_COMPLETED_DETAILS[0]:-}" | jq -r '.issue' 2>/dev/null || echo "ERR")
  iss1_TJ=$(printf '%s' "${ISSUES_COMPLETED_DETAILS[1]:-}" | jq -r '.issue' 2>/dev/null || echo "ERR")
  assert_eq "T-J: ISSUES_COMPLETED_DETAILS[0].issue == 10 (order)" "10" "$iss0_TJ"
  assert_eq "T-J: ISSUES_COMPLETED_DETAILS[1].issue == 20 (order)" "20" "$iss1_TJ"
  # First-wins: pr for issue 10 must be 1 (not 9)
  pr0_TJ=$(printf '%s' "${ISSUES_COMPLETED_DETAILS[0]:-}" | jq -r '.pr' 2>/dev/null || echo "ERR")
  assert_eq "T-J: ISSUES_COMPLETED_DETAILS[0].pr == 1 (first-wins)" "1" "$pr0_TJ"
else
  errTJ=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  fail "T-J: resume_entrypoint should succeed" "$errTJ"
fi
rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dirTJ"

# ─────────────────────────────────────────────────────────────────────────────
# T-K: After resume, mark_issue_completed appends new detail after restored details
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-K: After resume, mark_issue_completed appends new detail after restored ==="

reset_state
cfgTK="$TMP_DIR/cfgTK.sh"
make_config "$cfgTK"
shaTK=$(compute_file_sha256 "$cfgTK")
log_dirTK="$(mktemp -d)"
stTK="$log_dirTK/status.json"
make_status "$stTK" "$cfgTK" "$shaTK" "$log_dirTK" "pipe-TK" "1" "[10,20,30]" "[10]" "[]"
python3 -c "
import json
d = json.load(open('$stTK'))
d['issues_completed_details'] = [
  {\"issue\": 10, \"pr\": 55, \"duration_seconds\": 300}
]
json.dump(d, open('$stTK', 'w'))
"

lock_dirTK=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dirTK"

if resume_entrypoint "$stTK" 2>/tmp/re_stderr_$$.txt; then
  ok "T-K: resume_entrypoint returns 0"
  assert_eq "T-K: ISSUES_COMPLETED_DETAILS has 1 restored detail" "1" "${#ISSUES_COMPLETED_DETAILS[@]}"

  # Simulate starting issue 20
  CURRENT_ISSUE=20
  CURRENT_ISSUE_INDEX=1
  NEXT_ISSUE_INDEX=2
  CURRENT_ISSUE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  CURRENT_ISSUE_STARTED_EPOCH="$(date -u +%s)"
  CURRENT_PR=88

  # Call mark_issue_completed for issue 20
  mark_issue_completed 20

  assert_eq "T-K: ISSUES_COMPLETED_DETAILS has 2 elements after mark" "2" "${#ISSUES_COMPLETED_DETAILS[@]}"
  # First element is still the restored detail for issue 10
  iss0_TK=$(printf '%s' "${ISSUES_COMPLETED_DETAILS[0]:-}" | jq -r '.issue' 2>/dev/null || echo "ERR")
  assert_eq "T-K: ISSUES_COMPLETED_DETAILS[0].issue == 10 (restored, unchanged)" "10" "$iss0_TK"
  pr0_TK=$(printf '%s' "${ISSUES_COMPLETED_DETAILS[0]:-}" | jq -r '.pr' 2>/dev/null || echo "ERR")
  assert_eq "T-K: ISSUES_COMPLETED_DETAILS[0].pr == 55 (restored pr preserved)" "55" "$pr0_TK"
  # Second element is the newly appended detail for issue 20
  iss1_TK=$(printf '%s' "${ISSUES_COMPLETED_DETAILS[1]:-}" | jq -r '.issue' 2>/dev/null || echo "ERR")
  assert_eq "T-K: ISSUES_COMPLETED_DETAILS[1].issue == 20 (newly appended)" "20" "$iss1_TK"
  pr1_TK=$(printf '%s' "${ISSUES_COMPLETED_DETAILS[1]:-}" | jq -r '.pr' 2>/dev/null || echo "ERR")
  assert_eq "T-K: ISSUES_COMPLETED_DETAILS[1].pr == 88 (new pr)" "88" "$pr1_TK"
else
  errTK=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  fail "T-K: resume_entrypoint should succeed" "$errTK"
fi
rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dirTK"

# ─────────────────────────────────────────────────────────────────────────────
# T-L: --resume preserves original started_at from the paused status file
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-L: --resume preserves original started_at ==="

reset_state
cfgTL="$TMP_DIR/cfgTL.sh"
make_config "$cfgTL"
shaTL=$(compute_file_sha256 "$cfgTL")
log_dirTL="$(mktemp -d)"
stTL="$log_dirTL/status.json"
make_status "$stTL" "$cfgTL" "$shaTL" "$log_dirTL" "pipe-TL" "1" "[10,20,30]" "[10]" "[]"
# Inject a fixed started_at so we can assert exact preservation
fixed_started_at="2026-01-15T08:30:00Z"
python3 -c "
import json
d = json.load(open('$stTL'))
d['started_at'] = '$fixed_started_at'
json.dump(d, open('$stTL', 'w'))
"

lock_dirTL=$(get_lock_dir "/tmp/fake-repo")
rm -rf "$lock_dirTL"

if resume_entrypoint "$stTL" 2>/tmp/re_stderr_$$.txt; then
  ok "T-L: resume_entrypoint returns 0"
  # PIPELINE_START must equal the original started_at, not the resume time
  assert_eq "T-L: PIPELINE_START equals original started_at" \
    "$fixed_started_at" "$PIPELINE_START"
  # The written status.json must also carry the original started_at
  assert_json_field "T-L: status.json started_at preserved" \
    "$stTL" "started_at" "$fixed_started_at"
else
  errTL=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
  fail "T-L: resume_entrypoint should succeed" "$errTL"
fi
rm -f /tmp/re_stderr_$$.txt
rm -rf "$lock_dirTL"

# ─────────────────────────────────────────────────────────────────────────────
# T-M: --resume with missing/empty started_at falls back to current UTC time
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== T-M: --resume with missing started_at falls back to non-empty current time ==="

for variantTM in missing empty; do
  reset_state
  cfgTM="$TMP_DIR/cfgTM_${variantTM}.sh"
  make_config "$cfgTM"
  shaTM=$(compute_file_sha256 "$cfgTM")
  log_dirTM="$(mktemp -d)"
  stTM="$log_dirTM/status.json"
  make_status "$stTM" "$cfgTM" "$shaTM" "$log_dirTM" "pipe-TM-${variantTM}" "1" "[10,20,30]" "[10]" "[]"
  case "$variantTM" in
    missing)
      python3 -c "
import json
d = json.load(open('$stTM'))
if 'started_at' in d: del d['started_at']
json.dump(d, open('$stTM', 'w'))
"
      ;;
    empty)
      python3 -c "
import json
d = json.load(open('$stTM'))
d['started_at'] = ''
json.dump(d, open('$stTM', 'w'))
"
      ;;
  esac

  lock_dirTM=$(get_lock_dir "/tmp/fake-repo")
  rm -rf "$lock_dirTM"

  if resume_entrypoint "$stTM" 2>/tmp/re_stderr_$$.txt; then
    ok "T-M ($variantTM): resume_entrypoint returns 0"
    # PIPELINE_START must be non-empty (the fallback current UTC time)
    if [ -n "$PIPELINE_START" ]; then
      ok "T-M ($variantTM): PIPELINE_START is non-empty (fallback)"
    else
      fail "T-M ($variantTM): PIPELINE_START should be non-empty"
    fi
    # The written status.json started_at must also be non-empty
    written_started_at_TM=$(python3 -c "
import json
d = json.load(open('$stTM'))
print(d.get('started_at', '') or '')
" 2>/dev/null)
    if [ -n "$written_started_at_TM" ]; then
      ok "T-M ($variantTM): status.json started_at non-empty after fallback"
    else
      fail "T-M ($variantTM): status.json started_at should be non-empty after fallback"
    fi
  else
    errTM=$(cat /tmp/re_stderr_$$.txt 2>/dev/null || true)
    fail "T-M ($variantTM): resume_entrypoint should succeed" "$errTM"
  fi
  rm -f /tmp/re_stderr_$$.txt
  rm -rf "$lock_dirTM"
done

echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
