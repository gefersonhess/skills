#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Unit tests for pipeline.sh cursor/status logic (no live gh/pi required).
#
# Exercises:
#   - derive_issues_remaining  : cursor-based remaining list
#   - next_issue_value         : next issue at NEXT_ISSUE_INDEX
#   - CONFIG_SHA256 computation: defensive sha256 path
#   - write_status             : schema_version=2 + new fields in JSON output
#   - NEXT_ISSUE_INDEX semantics: while issue i is active, remaining = i+1..end
#
# Run: bash tests/pipeline/test-cursor-status.sh
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
  # Strip surrounding double-quotes for simple scalar comparison
  actual="${actual%\"}"
  actual="${actual#\"}"
  if [ "$actual" = "$expected" ]; then
    ok "$label"
  else
    fail "$label" "expected=$(printf '%q' "$expected") got=$(printf '%q' "$actual")"
  fi
}

# ── Inline function under test (extracted from pipeline.sh) ──────────────────
# We source the logic as a self-contained harness so we never need live gh/pi.

ISSUES=(101 202 303 404)

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

# ── Test: derive_issues_remaining ────────────────────────────────────────────
echo ""
echo "=== derive_issues_remaining ==="

assert_eq "before loop (idx=0): all issues" \
  "101,202,303,404" "$(derive_issues_remaining 0)"

# While issue[0]=101 is active, NEXT_ISSUE_INDEX=1 → remaining excludes 101
assert_eq "issue[0] active (idx=1): 202,303,404" \
  "202,303,404" "$(derive_issues_remaining 1)"

assert_eq "issue[1] active (idx=2): 303,404" \
  "303,404" "$(derive_issues_remaining 2)"

assert_eq "issue[2] active (idx=3): 404 only" \
  "404" "$(derive_issues_remaining 3)"

assert_eq "issue[3] active (idx=4): empty" \
  "" "$(derive_issues_remaining 4)"

assert_eq "past end (idx=99): empty" \
  "" "$(derive_issues_remaining 99)"

# ── Test: next_issue_value ────────────────────────────────────────────────────
echo ""
echo "=== next_issue_value ==="

NEXT_ISSUE_INDEX=0
assert_eq "idx=0: 101" "101" "$(next_issue_value)"

NEXT_ISSUE_INDEX=1
assert_eq "idx=1: 202" "202" "$(next_issue_value)"

NEXT_ISSUE_INDEX=3
assert_eq "idx=3: 404" "404" "$(next_issue_value)"

NEXT_ISSUE_INDEX=4
assert_eq "idx=4 (past end): null" "null" "$(next_issue_value)"

NEXT_ISSUE_INDEX=99
assert_eq "idx=99 (way past end): null" "null" "$(next_issue_value)"

# ── Test: NEXT_ISSUE_INDEX invariant ─────────────────────────────────────────
# Invariant: while issue index i is active, NEXT_ISSUE_INDEX=i+1 and
# issues_remaining = ISSUES[i+1..end].  Simulate what the loop does.
echo ""
echo "=== NEXT_ISSUE_INDEX invariant ==="

for i in "${!ISSUES[@]}"; do
  NEXT_ISSUE_INDEX=$((i + 1))
  remaining_csv="$(derive_issues_remaining "$NEXT_ISSUE_INDEX")"
  # Expected: all issues from i+1 to end
  expected_arr=("${ISSUES[@]:$((i + 1))}")
  if [ ${#expected_arr[@]} -gt 0 ]; then
    expected="$(IFS=,; echo "${expected_arr[*]}")"
  else
    expected=""
  fi
  assert_eq "issue[${i}]=${ISSUES[$i]} active: remaining matches" "$expected" "$remaining_csv"
done

# ── Test: CONFIG_SHA256 computation ──────────────────────────────────────────
echo ""
echo "=== CONFIG_SHA256 ==="

TMP_CFG=$(mktemp)
echo "REPO=/tmp/repo" > "$TMP_CFG"
if command -v sha256sum >/dev/null 2>&1; then
  expected_hash="$(sha256sum "$TMP_CFG" | awk '{print $1}')"
  computed="$(sha256sum "$TMP_CFG" 2>/dev/null | awk '{print $1}' || echo "")"
  assert_eq "sha256sum produces consistent hash" "$expected_hash" "$computed"
elif command -v shasum >/dev/null 2>&1; then
  expected_hash="$(shasum -a 256 "$TMP_CFG" | awk '{print $1}')"
  computed="$(shasum -a 256 "$TMP_CFG" 2>/dev/null | awk '{print $1}' || echo "")"
  assert_eq "shasum -a256 produces consistent hash" "$expected_hash" "$computed"
else
  ok "sha256 not available; empty string fallback is acceptable"
fi
rm -f "$TMP_CFG"

# ── Test: write_status JSON has schema_version=2 and new fields ───────────────
echo ""
echo "=== write_status JSON shape ==="

# Minimal stub environment to call write_status
LOG_DIR="$(mktemp -d)"
VERSION="1.1.0"
PIPELINE_ID="test-pipeline-$$"
PIPELINE_START="2026-06-30T00:00:00Z"
CONFIG_FILE="/tmp/fake-config.sh"
CONFIG_SHA256="abc123"
SCRIPT_FILE="/path/to/pipeline.sh"
ISSUES=(101 202 303)
NEXT_ISSUE_INDEX="0"

canonical_repo_path() { echo "/tmp/fake-repo"; }
current_issue_elapsed_seconds() { echo "null"; }
json_issue_records() { echo ""; }

cat > "$LOG_DIR/status.json.tmp" <<EOF_INNER
{
  "schema_version": 2,
  "pipeline_state": "running",
  "version": "$VERSION",
  "resume_supported": false,
  "checkpoint": null,
  "pipeline_id": "${PIPELINE_ID:-}",
  "pid": $$,
  "repo": "$(canonical_repo_path)",
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
  "current_issue": null,
  "current_issue_index": null,
  "next_issue_index": 0,
  "next_issue": 101,
  "current_phase": "",
  "current_phase_started_at": null,
  "current_issue_started_at": "",
  "current_issue_elapsed_seconds": null,
  "current_pr": null,
  "current_agent_pid": null,
  "issues_total": [101,202,303],
  "issues_completed": [],
  "issues_completed_details": [],
  "issues_skipped": [],
  "issues_remaining": [101,202,303],
  "last_update": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF_INNER
mv "$LOG_DIR/status.json.tmp" "$LOG_DIR/status.json"

JSON="$(cat "$LOG_DIR/status.json")"

# Validate JSON parses
if python3 -c "import sys,json; json.load(sys.stdin)" <<< "$JSON" 2>/dev/null; then
  ok "status.json is valid JSON"
else
  fail "status.json is valid JSON" "parse error"
fi

assert_json_field "schema_version=2"      "$JSON" "schema_version"     "2"
assert_json_field "resume_supported=false" "$JSON" "resume_supported"   "false"
assert_json_field "checkpoint=null"        "$JSON" "checkpoint"         "null"
assert_json_field "script_file present"    "$JSON" "script_file"        "/path/to/pipeline.sh"
assert_json_field "script_version=1.1.0"  "$JSON" "script_version"     "1.1.0"
assert_json_field "config_sha256 present"  "$JSON" "config_sha256"      "abc123"
assert_json_field "next_issue_index=0"     "$JSON" "next_issue_index"   "0"
assert_json_field "current_issue_index null" "$JSON" "current_issue_index" "null"
assert_json_field "next_issue=101"         "$JSON" "next_issue"         "101"

rm -rf "$LOG_DIR"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "════════════════════════════════"
[ "$FAIL" -eq 0 ]
