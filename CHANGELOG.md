# Changelog

All notable changes to this package are recorded here.

## [0.2.0] - Unreleased

### Added

- **Resume status schema / cursor groundwork** — `pipeline.sh` writes schema v2 status fields such
  as `current_issue_index`, `next_issue_index`, `next_issue`, `checkpoint`, `resume_supported`,
  `script_file`, and `config_sha256` so restart decisions are based on explicit metadata.
- **Durable pause at between-issues checkpoint** — the pipeline process now persists pause state to
  `status.json` before sleeping, ensuring a dead process leaves a recoverable checkpoint rather
  than an ambiguous stale-running entry.
- **`pipeline.sh --resume` writes `blocked` + bounded `resume_error` on failed resume** — when
  `--resume` fails on a schema v2 status file (validation error, missing `log_dir`, or lock
  acquisition failure), it patches `pipeline_state=blocked` and a `resume_error` (≤ 512 chars)
  into the argument path atomically; missing/invalid-JSON/schema-v1 files are left unchanged;
  `validate_resume_status` remains pure and non-mutating.
- **`pipeline.sh --resume <status.json>` validation and entrypoint** — the CLI validates schema v2,
  confirms the status is `paused`, checks config hash, checkpoint, issue arrays, cursor consistency,
  agent PID liveness, and repo-lock ownership, then resumes from the recorded `next_issue_index`;
  incompatible or ambiguous status files are rejected rather than silently restarting from scratch.
- **Extension `/pipeline-resume` live-control vs. dead paused tmux restart** — `/pipeline-resume`
  distinguishes between a live-paused pipeline (writes `resume` to the control file) and a
  dead-paused pipeline (launches a detached `tmux` session running `pipeline.sh --resume`);
  refuses with an explanation if the pipeline is not paused or preconditions are not met.
- **`planResumeAction` pure planner + unit tests** — the resume-action logic is extracted into a
  pure function (`planResumeAction`) so it can be unit-tested without a live tmux or filesystem;
  the test suite covers live-resume, dead-paused tmux restart, not-paused rejection, missing
  status/checkpoint fields, and schema-version mismatch paths.
- **Operational docs** — `skills/implementation-pipeline/references/monitoring-and-steering.md`
  documents the full pause/resume protocol including checkpoint semantics, dead-process detection,
  tmux restart procedure, and unsupported recovery scenarios.

### Fixed

- **Hide unknown issue age** — the pipeline status widget no longer displays a negative or
  nonsensical age label when the issue's creation date is unknown or unavailable.

---

## [0.1.0] - Initial release

- `implementation-pipeline` skill and `pipeline.sh` deterministic runner.
- `pipeline-status` extension with `/pipeline-status`, `/pipeline-log`, `/pipeline-pause`,
  `/pipeline-skip`, `/pipeline-abort`, and `/pipeline-dismiss` commands.
- Status widget showing completed, active, and remaining work items with durations.
- Machine-readable `status.json` contract and registry discovery protocol.
- `design-first-implementation`, `agent`, `ai-pr-review-loop`, `claude-code-review`,
  `coderabbit-pr-review-loop`, `ghe-pr-review-loop`, `graphify`, `skill-judge`, and
  `targeted-pr-review` skills bundled as a pi package.
