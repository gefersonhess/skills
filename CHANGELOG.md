# Changelog

All notable changes to this package are recorded here.

## [0.2.8] - 2026-07-03

### Fixed

- **Single-pass local CodeRabbit precheck** — the implementation prompt now instructs a single local CodeRabbit pass only. Agents fix verified functional/security/correctness/stability findings, triage the rest via `coderabbit feedback`, and proceed. Re-running the local review is explicitly prohibited, preventing multi-round loops that exhaust the rate limit quota across batch pipeline runs.
- **Rate-limited/unavailable local precheck is now a pass** — `verify_local_coderabbit_precheck` now detects rate-limit and service-unavailable responses and passes through with a log note rather than blocking the pipeline. The PR-side CodeRabbit bot review is the safety net for what the local pass missed.

---

## [0.2.7] - 2026-07-03

### Changed

- **Local CodeRabbit precheck accepts triaged findings** — the precheck verifier now accepts handoffs that document finding dispositions (fixed, deferred, out-of-scope, false-positive) rather than requiring a zero-findings result. Requires `coderabbit feedback` command/result to be documented for any finding not fixed in code.

---

## [0.2.6] - 2026-07-03

### Fixed

- **Bad substitution crash in scope gate** — `${#ISSUES_COMPLETED[@]:-0}` is not valid bash; the `:-` default operator does not apply to array length expressions. Caused an immediate pipeline crash on the first scope gate invocation. Fixed to `${#ISSUES_COMPLETED[@]}`.

---

## [0.2.5] - 2026-07-03

### Added

- **Dependency state retry with exponential backoff** — `gh_issue_state_with_retry` queries issue
  state with exponential backoff (4 sleeps across 5 attempts, ~15s worst-case) before returning a
  non-CLOSED result. Prevents a stale GitHub API read immediately after a merge from misclassifying
  a just-closed dependency as still-open and blocking downstream issues.
- **Session-local completion memory** — before any API call, the retry helper checks
  `ISSUES_COMPLETED` (the in-process record of issues merged in this run). If the pipeline already
  merged the dependency in this session it returns CLOSED immediately without touching the network.
  Used by `process_tracker_checkpoint` for all child and tracker issue checks.
- **Gate prompt eventual-consistency guidance** — the scope gate agent prompt now receives the list
  of session-completed issues and explicit instructions to re-check an OPEN dependency (wait 5s,
  then 15s more) before writing a `blocker:` verdict.
- **Transient CI failure retry** — the pipeline now retries transient CI failures before blocking,
  and investigates CI failures before retrying to distinguish real failures from infrastructure noise.

---

## [0.2.4] - 2026-07-02

### Added

- **Pipeline status hide/show controls** — `/pipeline-status hide`, `/pipeline-status show`,
  `/pipeline-hide`, and `/pipeline-show` let a session hide the pipeline widget without stopping
  polling or losing tracked pipeline state.
- **Pipeline status help** — `/pipeline-status --help`, `-h`, and `help` now render command usage
  before any repo refresh, including shortcuts, `p1`/`p2` handles, full IDs, and unique prefixes.

### Changed

- **Compact pipeline widget UX** — the below-editor widget now uses a single compact line with
  colored state icons, current item duration, total pipeline duration, progress, next issue, and PR
  number; it removes the heading, verbose controls list, and duplicate footer/status-line rendering.
- **Right-aligned status hint** — the dim `/pipeline-status` hint is rendered with a width-aware
  widget component so it aligns to the right edge when the terminal is wide enough and falls back to
  the normal separator when space is constrained.
- **Pipeline value emphasis** — key runtime values use normal text emphasis while labels and
  separators stay dim, making the compact status easier to scan without relying on color alone.

---

## [0.2.3] - 2026-07-01

### Added

- **Extension-owned pipeline launcher** — `pipeline-status` now registers `/pipeline-run` and the
  LLM-callable `pipeline_run` tool so implementation pipelines launch through a validated,
  detached tmux entrypoint instead of model-generated bash. The launcher writes a shell-safe config
  under `/tmp/<session>/config.sh`, sets `LOG_DIR` to the same session directory, checks tmux
  availability/session uniqueness, and returns the attach, config, log, status, and control paths.
- **Launch helper tests and docs** — pure launch helpers cover parameter validation, config
  rendering, shell quoting, command parsing, and session planning; implementation-pipeline docs now
  prefer `pipeline_run` or `/pipeline-run` and treat direct `pipeline.sh` launch as an explicitly
  approved fallback only.

---

## [0.2.2] - 2026-06-30

### Fixed

- **Pipeline widget durations are less noisy** — active durations now use compact labels such as
  `3m20s`, `17m`, `1h12m`, or `2d4h`; completed issue durations use coarser labels such as
  `<1m`, `56m`, `1h12m`, or `2d4h` so the widget avoids stale-looking second counters for
  completed work.
- **Pipeline control loops poll faster by default** — implementation-pipeline handoff polling,
  CI polling, pause control polling, dead-agent flush waits, and final post-issue settle delays are
  configurable via `HANDOFF_POLL_SECONDS`, `CI_POLL_SECONDS`, `PAUSE_POLL_SECONDS`,
  `DEAD_AGENT_FLUSH_SECONDS`, and `FINAL_STATUS_SETTLE_SECONDS`; defaults reduce idle latency
  without skipping review or CI gates.

---

## [0.2.1] - 2026-06-30

### Fixed

- **Pipeline widget issue age advances live** — the `pipeline-status` extension now derives the
  active issue age from `current_issue_started_at` when available instead of preferring the
  write-time `current_issue_elapsed_seconds` snapshot, preventing status lines such as
  `issue 1m1s · phase 16m53s` from freezing issue age while phase age advances; the snapshot field
  remains a fallback for old or sparse status files.

---

## [0.2.0] - 2026-06-30

### Added

- **Resume status schema / cursor groundwork** — `pipeline.sh` writes schema v2 status fields such
  as `current_issue_index`, `next_issue_index`, `next_issue`, `checkpoint`, `resume_supported`,
  `script_file`, and `config_sha256` so restart decisions are based on explicit metadata.
- **Durable pause at between-issues checkpoint** — the pipeline process now persists pause state to
  `status.json` before sleeping, ensuring a dead process leaves a recoverable checkpoint rather
  than an ambiguous stale-running entry.
- **Extension surfaces `resume_error` for blocked pipelines in the widget** — when a schema v2
  status file carries a `resume_error` field and `pipeline_state=blocked`, the `pipeline-status`
  below-editor widget shows a concise, sanitized, one-line reason (max 160 chars) as a dim
  sub-line after the state indicator; the footer/status bar is unchanged.
- **`pipeline.sh --resume` restores `ISSUES_COMPLETED_DETAILS`** — after a dead-process resume,
  previously completed issue metadata (PR number, timestamps, duration) recorded in
  `issues_completed_details` is reconstructed from the paused status file and re-emitted in the
  first `running` status write; invalid/orphan/duplicate detail records are silently filtered
  (non-object elements, non-numeric `.issue`, issues not in `issues_completed`, and duplicate
  records after the first) without blocking resume; missing/null/non-array details fields are
  treated as empty.
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

- **`pipeline.sh --resume` preserves original `started_at`** — `resume_entrypoint` now restores
  the `started_at` timestamp from the paused status file instead of resetting it to the resume
  time, so `status.json` and the registry entry report the pipeline's true wall-clock start
  throughout its lifetime; falls back to current UTC time only when the field is missing or empty.
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
