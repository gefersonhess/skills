# Pi Skills and Extensions

This repository contains pi skills, helper scripts, and extensions used by the local coding-agent setup.

It is a pi package: installing the repo loads the skills under `skills/` and the extensions declared
in `package.json`.

## Package contents

| Path | Purpose |
| --- | --- |
| `skills/*/SKILL.md` | Pi skills. Each directory is a self-contained skill. |
| `skills/implementation-pipeline/pipeline.sh` | Deterministic implementation-pipeline runner used by the `implementation-pipeline` skill. |
| `skills/implementation-pipeline/references/` | Pipeline config, monitoring, and operational reference docs. |
| `skills/ai-pr-review-loop/references/` | Provider-specific review-loop contracts and worker-mode docs. |
| `extensions/` | TypeScript pi extensions loaded by the package. |
| `package.json` | Pi package manifest. |

## Installation

Install from git:

```bash
pi install git:git@github.com:aweiker/skills.git@v0.2.4
```

For local development on this machine, the checkout can be installed directly:

```bash
pi install /home/ubuntu/repos/skills
```

After installing or changing package resources, reload pi:

```text
/reload
```

## Package manifest

`package.json` exposes:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

The package uses conventional `skills/` and `extensions/` directories so it can be installed as a
normal pi package instead of relying on loose global files.

## Skills

| Skill | Purpose |
| --- | --- |
| `agent` | Spawn isolated sub-agents for delegated tasks. |
| `ai-pr-review-loop` | Run provider-aware AI PR review loops for CodeRabbit and GHE PR-Bot. |
| `claude-code-review` | Run a non-interactive Claude Code review and capture findings. |
| `coderabbit-pr-review-loop` | Compatibility shim for CodeRabbit review loops. |
| `design-first-implementation` | Design/test-first gate for implementation tasks. |
| `ghe-pr-review-loop` | Compatibility shim for GHE PR-Bot review loops. |
| `graphify` | Query and update persistent code/content knowledge graphs. |
| `implementation-pipeline` | Sequential issue implementation pipeline: scope gate, worktree, implementation, self-review, bot review, merge. |
| `skill-judge` | Evaluate pi skill design quality. |
| `targeted-pr-review` | Run focused multi-dimension PR/branch self-reviews. |

## Extensions

### `pipeline-status`

`extensions/pipeline-status.ts` shows implementation-pipeline progress in the pi TUI.

It reads pipeline registry entries from:

```text
/tmp/pi-pipeline-status/active/*.json
```

The registry points to each pipeline's `status.json`, `loop.log`, and `control` file.

Commands:

| Command | Behavior |
| --- | --- |
| `/pipeline-run <JSON\|key=value...>` | Launch a new implementation pipeline through the extension-owned detached tmux launcher. |
| `/pipeline-status` | Refresh/show current repo pipeline status. |
| `/pipeline-log [id]` | Open a live tail view of the pipeline log. |
| `/pipeline-pause [id]` | Request pause between phases. |
| `/pipeline-resume [id]` | Resume a paused pipeline. If the pipeline process is alive, writes `resume` to the control file. If the process is dead and the status is a supported paused v2 between-issues checkpoint, launches a detached tmux restart session running `pipeline.sh --resume <status_file>`. Refuses if the pipeline is not paused or restart preconditions are not met. |
| `/pipeline-skip [id]` | Request skip of current issue; requires confirmation. |
| `/pipeline-abort [id]` | Request abort of the pipeline; requires confirmation. |
| `/pipeline-dismiss [id]` | Remove a terminal pipeline from the status widget. |

Widget output includes:

- completed work items and duration;
- active work item and elapsed time;
- remaining work items;
- skipped items, if any;
- log path and steering commands.

## Implementation pipeline status contract

`skills/implementation-pipeline/pipeline.sh` writes machine-readable status to:

```text
$LOG_DIR/status.json
```

and a discovery pointer to:

```text
${PIPELINE_REGISTRY_ROOT:-/tmp/pi-pipeline-status/active}/<pipeline-id>.json
```

`status.json` is the source of truth for phase, issue, PR, and terminal state. The extension must
not infer state from logs or GitHub API calls — it reads `status.json` directly. Terminal registry
entries remain in the active directory until dismissed; `/pipeline-dismiss` removes only the
registry pointer, not logs, status files, worktrees, or PRs.

See `skills/implementation-pipeline/references/monitoring-and-steering.md` for the full monitoring,
control, and pause/resume protocol including checkpoint semantics and dead-process restart.

## Plans

Execution plans for larger changes live under `docs/plans/`.

- `docs/plans/resumable-implementation-pipelines.md` — design and execution plan for safe checkpoint-based pipeline resume.
- `docs/checklists/v0.2.0-release.md` — release checklist for v0.2.0.

## Development workflow

Run all checks with the canonical validation script:

```bash
bash tests/run-all.sh
```

What it runs (in order):

```bash
bash -n skills/implementation-pipeline/pipeline.sh
node --experimental-strip-types --check extensions/pipeline-status.ts
bash tests/pipeline/test-cursor-status.sh
bash tests/pipeline/test-durable-pause.sh
bash tests/pipeline/test-resume-validation.sh
bash tests/pipeline/test-resume-supported.sh
bash tests/pipeline/test-resume-entrypoint.sh
node tests/pipeline/test-pipeline-resume-extension.mjs
node tests/package/test-package-metadata.mjs
shellcheck skills/implementation-pipeline/pipeline.sh tests/pipeline/test-cursor-status.sh tests/pipeline/test-durable-pause.sh tests/pipeline/test-resume-validation.sh tests/pipeline/test-resume-supported.sh tests/pipeline/test-resume-entrypoint.sh
```

Check package visibility:

```bash
pi list
```

Reload pi after changes:

```text
/reload
```

## Release and update

This repo is usually installed by git ref. For reproducible installs, prefer a tag or commit SHA
rather than a floating branch:

```bash
pi install git:git@github.com:aweiker/skills.git@<tag-or-sha>
```

Update installed packages:

```bash
pi update --extensions
```

## Security note

Skills can instruct the agent to run commands. Extensions execute code with the user's local
permissions. Review changes before installing or updating this package.
