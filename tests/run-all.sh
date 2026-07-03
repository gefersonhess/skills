#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root from script location so this works regardless of caller cwd:
#   bash tests/run-all.sh
#   bash /absolute/path/to/tests/run-all.sh
#   ./tests/run-all.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

# Require shellcheck before running any tests.
if ! command -v shellcheck &>/dev/null; then
  echo "ERROR: shellcheck is required but not found in PATH." >&2
  echo "Install it (e.g. apt-get install shellcheck) and retry." >&2
  exit 1
fi

run_step() {
  echo "--- $*"
  "$@"
}

run_step bash -n skills/implementation-pipeline/pipeline.sh

run_step node --experimental-strip-types --check extensions/pipeline-status.ts

run_step bash tests/pipeline/test-cursor-status.sh

run_step bash tests/pipeline/test-durable-pause.sh

run_step bash tests/pipeline/test-resume-validation.sh

run_step bash tests/pipeline/test-resume-supported.sh

run_step bash tests/pipeline/test-poll-intervals.sh

run_step bash tests/pipeline/test-resume-entrypoint.sh

run_step node tests/pipeline/test-pipeline-resume-extension.mjs

run_step node tests/pipeline/test-pipeline-launch-extension.mjs

run_step node tests/package/test-package-metadata.mjs

run_step shellcheck \
  skills/implementation-pipeline/pipeline.sh \
  tests/pipeline/test-cursor-status.sh \
  tests/pipeline/test-durable-pause.sh \
  tests/pipeline/test-resume-validation.sh \
  tests/pipeline/test-resume-supported.sh \
  tests/pipeline/test-poll-intervals.sh \
  tests/pipeline/test-resume-entrypoint.sh

echo ""
echo "All checks passed."
