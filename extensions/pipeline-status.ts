import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const DEFAULT_REGISTRY_ROOT = "/tmp/pi-pipeline-status/active";
const STATUS_KEY = "pipeline-status";
const WIDGET_KEY = "pipeline-status";
const TERMINAL_STATES = new Set(["completed", "blocked", "aborted", "killed"]);

type NotifyLevel = "info" | "warning" | "error";

type RegistryEntry = {
	id: string;
	repo: string;
	repo_name?: string;
	pid?: number;
	status_file?: string;
	log_file?: string;
	control_file?: string;
	log_dir?: string;
	config_file?: string;
	started_at?: string;
};

type CompletedIssue = {
	issue: number;
	pr?: number | null;
	started_at?: string;
	completed_at?: string;
	duration_seconds?: number | null;
};

type PipelineStatus = {
	schema_version?: number;
	pipeline_state?: string;
	pipeline_id?: string;
	repo?: string;
	repo_name?: string;
	pid?: number;
	// schema_version >= 2
	resume_supported?: boolean;
	checkpoint?: unknown;
	script_file?: string;
	script_version?: string;
	config_sha256?: string;
	current_issue_index?: number | null;
	next_issue_index?: number | null;
	next_issue?: number | null;
	// always present
	current_issue?: number | null;
	current_phase?: string;
	current_phase_started_at?: string | null;
	current_issue_started_at?: string | null;
	current_issue_elapsed_seconds?: number | null;
	current_pr?: number | null;
	current_agent_pid?: number | null;
	paused_at?: string | null;
	paused_reason?: string | null;
	issues_total?: number[];
	issues_completed?: number[];
	issues_completed_details?: CompletedIssue[];
	issues_skipped?: number[];
	issues_remaining?: number[];
	started_at?: string;
	last_update?: string;
	status_file?: string;
	log_file?: string;
	control_file?: string;
	// schema_version >= 2, blocked resume failure
	resume_error?: unknown;
};

type PipelineView = {
	id: string;
	registryPath: string;
	repo: string;
	repoName: string;
	pid: number | null;
	statusFile: string;
	logFile: string;
	controlFile: string;
	status?: PipelineStatus;
	pidAlive: boolean;
	state: string;
	terminal: boolean;
	phase: string;
	phaseElapsed: string;
	issueElapsed: string;
};

type ExtensionContextLike = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	ui: {
		theme?: {
			fg: (color: string, text: string) => string;
		};
		setStatus: (key: string, value?: string) => void;
		setWidget: (key: string, value?: string[], options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
		custom?: <T>(factory: (tui: { requestRender: () => void }, theme: { fg: (color: string, text: string) => string }, keybindings: unknown, done: (value: T) => void) => unknown) => Promise<T>;
		notify: (message: string, level?: NotifyLevel) => void;
		confirm: (title: string, message: string) => Promise<boolean>;
		select: (title: string, items: string[]) => Promise<string | undefined>;
	};
};

export default function pipelineStatusExtension(pi: ExtensionAPI) {
	const registryRoot = process.env.PIPELINE_STATUS_REGISTRY_ROOT ?? process.env.PIPELINE_REGISTRY_ROOT ?? DEFAULT_REGISTRY_ROOT;
	const pollMs = parsePollMs(process.env.PIPELINE_STATUS_POLL_MS);
	let timer: NodeJS.Timeout | undefined;
	let currentRepo: string | null = null;
	let pipelines: PipelineView[] = [];
	const pendingCommands = new Map<string, string>();

	async function refresh(ctx: ExtensionContextLike): Promise<void> {
		currentRepo ??= await resolveCurrentRepo(ctx);
		if (!currentRepo) {
			clearUI(ctx);
			return;
		}

		pipelines = await loadPipelinesForRepo(currentRepo);
		render(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		currentRepo = await resolveCurrentRepo(ctx as ExtensionContextLike);
		await refresh(ctx as ExtensionContextLike);
		timer = setInterval(() => {
			refresh(ctx as ExtensionContextLike).catch((error) => {
				console.error(`[pipeline-status] refresh failed: ${String(error)}`);
			});
		}, pollMs);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		currentRepo = null;
		pipelines = [];
		if (ctx.hasUI) clearUI(ctx as ExtensionContextLike);
	});

	pi.registerCommand("pipeline-status", {
		description: "Show implementation pipeline status for the current repo; supports subcommands: pause, resume, skip, abort, dismiss, log",
		handler: async (args, ctx) => {
			await refresh(ctx as ExtensionContextLike);
			const [actionRaw, id] = splitArgs(args);
			const action = actionRaw || "show";
			switch (action) {
				case "show":
				case "list":
					showStatus(ctx as ExtensionContextLike);
					return;
				case "pause":
				case "resume":
				case "skip":
				case "abort":
					await steer(ctx as ExtensionContextLike, action, id);
					return;
				case "dismiss":
					await dismiss(ctx as ExtensionContextLike, id);
					return;
				case "log":
					await showLog(ctx as ExtensionContextLike, id);
					return;
				default:
					notify(ctx as ExtensionContextLike, `Unknown pipeline-status action: ${action}`, "error");
			}
		},
	});

	for (const command of ["pause", "resume", "skip", "abort"] as const) {
		pi.registerCommand(`pipeline-${command}`, {
			description: `${command} the current implementation pipeline for this repo`,
			handler: async (args, ctx) => {
				await refresh(ctx as ExtensionContextLike);
				await steer(ctx as ExtensionContextLike, command, args.trim() || undefined);
			},
		});
	}

	pi.registerCommand("pipeline-dismiss", {
		description: "Dismiss a terminal implementation pipeline from the status widget",
		handler: async (args, ctx) => {
			await refresh(ctx as ExtensionContextLike);
			await dismiss(ctx as ExtensionContextLike, args.trim() || undefined);
		},
	});

	pi.registerCommand("pipeline-log", {
		description: "Show the loop.log path for an implementation pipeline",
		handler: async (args, ctx) => {
			await refresh(ctx as ExtensionContextLike);
			await showLog(ctx as ExtensionContextLike, args.trim() || undefined);
		},
	});

	async function resolveCurrentRepo(ctx: ExtensionContextLike): Promise<string | null> {
		const top = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 3000 });
		if (top.code !== 0) return null;
		const repo = top.stdout.trim();
		if (!repo) return null;
		const real = await pi.exec("realpath", [repo], { timeout: 3000 });
		return real.code === 0 && real.stdout.trim() ? real.stdout.trim() : repo;
	}

	async function loadPipelinesForRepo(repo: string): Promise<PipelineView[]> {
		let files: string[];
		try {
			files = await readdir(registryRoot);
		} catch {
			return [];
		}

		const views: PipelineView[] = [];
		for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
			const registryPath = join(registryRoot, file);
			const registry = await readJson<RegistryEntry>(registryPath);
			if (!registry || registry.repo !== repo) continue;

			const statusFile = registry.status_file ?? join(registry.log_dir ?? "", "status.json");
			const status = statusFile ? await readJson<PipelineStatus>(statusFile) : undefined;
			const pid = numberOrNull(registry.pid ?? status?.pid);
			const pidAlive = pid !== null && isPidAlive(pid);
			const state = classifyState(status?.pipeline_state, pidAlive, status !== undefined);
			const phase = status?.current_phase || "-";
			const id = registry.id || status?.pipeline_id || basename(file, ".json");

			views.push({
				id,
				registryPath,
				repo: registry.repo,
				repoName: registry.repo_name || status?.repo_name || basename(registry.repo),
				pid,
				statusFile,
				logFile: registry.log_file ?? status?.log_file ?? join(registry.log_dir ?? "", "loop.log"),
				controlFile: registry.control_file ?? status?.control_file ?? join(registry.log_dir ?? "", "control"),
				status,
				pidAlive,
				state,
				terminal: TERMINAL_STATES.has(state) || state === "crashed",
				phase,
				phaseElapsed: elapsedSince(status?.current_phase_started_at),
				issueElapsed: elapsedIssue(status),
			});
		}
		return views;
	}

	function render(ctx: ExtensionContextLike): void {
		if (!ctx.hasUI) return;
		if (pipelines.length === 0) {
			clearUI(ctx);
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, footerText(ctx));
		ctx.ui.setWidget(WIDGET_KEY, widgetLines(ctx), { placement: "belowEditor" });
	}

	function footerText(ctx: ExtensionContextLike): string {
		const active = pipelines.filter((pipeline) => pipeline.state === "running" || pipeline.state === "starting" || pipeline.state === "paused");
		const terminal = pipelines.length - active.length;
		const theme = ctx.ui.theme;
		if (active.length === 1) {
			const pipeline = active[0]!;
			if (pipeline.state === "paused") {
				const next = pipeline.status?.next_issue ? `#${pipeline.status.next_issue}` : "unknown";
				return color(theme, "accent", "pipeline:") + " " + color(theme, "dim", `⏸ paused before ${next}`);
			}
			const issue = pipeline.status?.current_issue ? `#${pipeline.status.current_issue}` : "no issue";
			const issueAge = pipeline.issueElapsed === "unknown" ? "" : ` issue age ${pipeline.issueElapsed}`;
			return color(theme, "accent", "pipeline:") + " " + color(theme, "dim", `${issue} ${pipeline.phase}${issueAge}`);
		}
		if (active.length > 1) {
			return color(theme, "accent", "pipelines:") + " " + color(theme, "dim", `${active.length} active${terminal ? `, ${terminal} terminal` : ""}`);
		}
		return color(theme, "success", "pipeline:") + " " + color(theme, "dim", `${terminal} complete/terminal; dismiss when done`);
	}

	function widgetLines(ctx: ExtensionContextLike): string[] {
		const theme = ctx.ui.theme;
		const lines = [color(theme, "accent", "── Implementation Pipeline Status ──")];
		for (const pipeline of pipelines) {
			const status = pipeline.status;
			const issue = status?.current_issue ? `#${status.current_issue}` : "-";
			const pr = status?.current_pr ? ` PR #${status.current_pr}` : "";
			const completed = completedIssueDetails(status);
			const skipped = status?.issues_skipped ?? [];
			const remaining = status?.issues_remaining ?? [];
			const pending = pendingCommands.get(pipeline.id);
			const indicator = stateIndicator(pipeline.state);
			const issueAge = pipeline.issueElapsed === "unknown" ? "" : ` · issue age ${pipeline.issueElapsed}`;
			const nextIssue = status?.next_issue ? `#${status.next_issue}` : "unknown";
			const active = pipeline.terminal
				? `${indicator} ${pipeline.repoName} ${pipeline.state}`
				: pipeline.state === "paused"
					? `${indicator} paused: before ${nextIssue}`
					: `${indicator} active: ${issue} ${pipeline.phase}${issueAge} · phase ${pipeline.phaseElapsed}${pr}`;
			lines.push(`${active}${pending ? ` (${pending} pending)` : ""}`);
			if (pipeline.state === "blocked") {
				const resumeErr = formatResumeError(pipeline.status?.resume_error);
				if (resumeErr !== null) {
					lines.push(color(theme, "dim", `   resume error: ${resumeErr}`));
				}
			}
			const controls = pipeline.terminal
				? `dismiss: /pipeline-dismiss ${pipeline.id}`
				: pipeline.state === "paused"
					? `controls: /pipeline-resume ${pipeline.id} | /pipeline-abort ${pipeline.id}`
					: `controls: /pipeline-pause ${pipeline.id} | /pipeline-skip ${pipeline.id} | /pipeline-abort ${pipeline.id}`;

			lines.push(color(theme, "dim", `   completed: ${formatCompleted(completed)}`));
			lines.push(color(theme, "dim", `   remaining: ${formatIssueList(remaining)}${skipped.length ? ` · skipped: ${formatIssueList(skipped)}` : ""}`));
			lines.push(color(theme, "dim", `   log: ${pipeline.logFile}`));
			lines.push(color(theme, pipeline.terminal ? "muted" : "dim", `   ${controls}`));
		}
		return lines;
	}

	async function resumePipeline(ctx: ExtensionContextLike, pipeline: PipelineView): Promise<void> {
		const action = planResumeAction({
			pipelineId: pipeline.id,
			state: pipeline.state,
			pidAlive: pipeline.pidAlive,
			controlFile: pipeline.controlFile,
			statusFile: pipeline.statusFile,
			status: pipeline.status,
		});

		if (action.type === "refuse") {
			notify(ctx, action.message + (action.manualCommand ? `\nManual: ${action.manualCommand}` : ""), "error");
			return;
		}

		if (action.type === "control-file-write") {
			// Live PID: use existing control-file write path.
			const hadPending = await fileHasContent(action.controlFile);
			try {
				await writeFile(action.controlFile, "resume\n", "utf8");
				pendingCommands.set(pipeline.id, "resume");
				setTimeout(() => pendingCommands.delete(pipeline.id), pollMs * 2).unref?.();
				notify(ctx, `resume command sent to pipeline ${pipeline.id}.${hadPending ? " Previous control command may not have been consumed yet." : ""}`, hadPending ? "warning" : "info");
				await refresh(ctx);
			} catch (error) {
				notify(ctx, `Failed to write pipeline control command: ${String(error)}`, "error");
			}
			return;
		}

		// action.type === "tmux-restart"
		// Dead PID: attempt restart only after precondition checks.
		const { sessionName, shellCmd, scriptFile, statusFile } = action;

		// Check tmux availability.
		const whichResult = await pi.exec("which", ["tmux"], { timeout: 3000 });
		if (whichResult.code !== 0) {
			const manual = manualResumeCommand(scriptFile, statusFile);
			notify(
				ctx,
				`Pipeline ${pipeline.id}: tmux is not available — cannot auto-restart.\nManual: ${manual}`,
				"warning",
			);
			return;
		}

		// Check if session already exists.
		const hasSession = await pi.exec("tmux", ["has-session", "-t", sessionName], { timeout: 3000 });
		if (hasSession.code === 0) {
			notify(ctx, `Pipeline ${pipeline.id}: a resume session is already running.\nAttach: tmux attach -t ${sessionName}`, "info");
			return;
		}

		// Spawn detached tmux session.
		const spawnResult = await pi.exec("tmux", ["new-session", "-d", "-s", sessionName, shellCmd], { timeout: 5000 });
		if (spawnResult.code !== 0) {
			const manual = manualResumeCommand(scriptFile, statusFile);
			notify(
				ctx,
				`Pipeline ${pipeline.id}: failed to start tmux session (${spawnResult.stderr.trim() || "unknown error"}).\nManual: ${manual}`,
				"error",
			);
			return;
		}

		pendingCommands.set(pipeline.id, "resume");
		setTimeout(() => pendingCommands.delete(pipeline.id), pollMs * 2).unref?.();
		notify(ctx, `Pipeline ${pipeline.id}: restart launched.\nAttach: tmux attach -t ${sessionName}`, "info");
		await refresh(ctx);
	}

	async function steer(ctx: ExtensionContextLike, command: "pause" | "resume" | "skip" | "abort", id?: string): Promise<void> {
		const pipeline = await selectPipeline(ctx, id, { allowTerminal: false });
		if (!pipeline) return;

		if (command === "resume") {
			await resumePipeline(ctx, pipeline);
			return;
		}

		if (command === "skip" || command === "abort") {
			if (!ctx.hasUI) {
				notify(ctx, `Refusing to ${command} pipeline without interactive confirmation.`, "error");
				return;
			}
			const ok = await ctx.ui.confirm(confirmTitle(command, pipeline), confirmMessage(command, pipeline));
			if (!ok) {
				notify(ctx, "Pipeline command cancelled.", "info");
				return;
			}
		}

		const hadPending = await fileHasContent(pipeline.controlFile);
		try {
			await writeFile(pipeline.controlFile, `${command}\n`, "utf8");
			pendingCommands.set(pipeline.id, command);
			setTimeout(() => pendingCommands.delete(pipeline.id), pollMs * 2).unref?.();
			notify(ctx, `${command} command sent to pipeline ${pipeline.id}.${hadPending ? " Previous control command may not have been consumed yet." : ""}`, hadPending ? "warning" : "info");
			await refresh(ctx);
		} catch (error) {
			notify(ctx, `Failed to write pipeline control command: ${String(error)}`, "error");
		}
	}

	async function dismiss(ctx: ExtensionContextLike, id?: string): Promise<void> {
		const pipeline = await selectPipeline(ctx, id, { allowTerminal: true, terminalOnly: true });
		if (!pipeline) return;
		try {
			await rm(pipeline.registryPath, { force: true });
			notify(ctx, `Dismissed pipeline ${pipeline.id}.`, "info");
			await refresh(ctx);
		} catch (error) {
			notify(ctx, `Failed to dismiss pipeline ${pipeline.id}: ${String(error)}`, "error");
		}
	}

	async function showLog(ctx: ExtensionContextLike, id?: string): Promise<void> {
		const pipeline = await selectPipeline(ctx, id, { allowTerminal: true });
		if (!pipeline) return;
		if (ctx.mode !== "tui" || !ctx.ui.custom) {
			notify(ctx, `Pipeline log: ${pipeline.logFile}`, "info");
			return;
		}
		await tailLog(ctx, pipeline);
	}

	async function tailLog(ctx: ExtensionContextLike, pipeline: PipelineView): Promise<void> {
		let lines = ["Loading..."];
		let interval: NodeJS.Timeout | undefined;

		const load = async () => {
			try {
				lines = tailLines(await readFile(pipeline.logFile, "utf8"), 80);
			} catch (error) {
				lines = [`Unable to read ${pipeline.logFile}: ${String(error)}`];
			}
		};

		await load();
		try {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				interval = setInterval(() => {
					load()
						.then(() => tui.requestRender())
						.catch((error) => {
							lines = [`Unable to refresh ${pipeline.logFile}: ${String(error)}`];
							tui.requestRender();
						});
				}, 1500);

				const close = () => done(undefined);
				return {
					invalidate() {},
					handleInput(data: string) {
						if (data === "q" || data === "\u0003" || data === "\u001b") close();
					},
					render(width: number): string[] {
						const safeWidth = Math.max(1, width);
						const rendered = [
							theme.fg("accent", truncatePlain(`tail -f ${pipeline.logFile}`, safeWidth)),
							theme.fg("dim", truncatePlain("q/Esc/Ctrl-C close · refresh 1.5s", safeWidth)),
							"",
						];
						for (const line of lines) rendered.push(truncatePlain(line, safeWidth));
						return rendered;
					},
				};
			});
		} finally {
			if (interval) clearInterval(interval);
		}
	}

	function showStatus(ctx: ExtensionContextLike): void {
		if (pipelines.length === 0) {
			notify(ctx, "No implementation pipelines found for this repo.", "info");
			return;
		}
		notify(ctx, `${pipelines.length} implementation pipeline(s) visible for this repo.`, "info");
		render(ctx);
	}

	async function selectPipeline(
		ctx: ExtensionContextLike,
		id: string | undefined,
		options: { allowTerminal: boolean; terminalOnly?: boolean },
	): Promise<PipelineView | undefined> {
		const candidates = pipelines.filter((pipeline) => {
			if (options.terminalOnly) return pipeline.terminal;
			return options.allowTerminal || !pipeline.terminal;
		});

		if (id) {
			const pipeline = candidates.find((item) => item.id === id || item.id.startsWith(id));
			if (!pipeline) notify(ctx, `No matching pipeline found for id '${id}'.`, "error");
			return pipeline;
		}

		if (candidates.length === 0) {
			notify(ctx, options.terminalOnly ? "No terminal pipelines to dismiss." : "No running pipelines to control.", "info");
			return undefined;
		}
		if (candidates.length === 1) return candidates[0];
		if (!ctx.hasUI) {
			console.error("[pipeline-status] multiple pipelines match; provide an id");
			return undefined;
		}

		const labels = candidates.map((pipeline) => pipelineLabel(pipeline));
		const choice = await ctx.ui.select("Select pipeline", labels);
		if (!choice) return undefined;
		const index = labels.indexOf(choice);
		return index >= 0 ? candidates[index] : undefined;
	}
}

function parsePollMs(raw: string | undefined): number {
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 1000) return 5000;
	return Math.floor(parsed);
}

function splitArgs(args: string): [string | undefined, string | undefined] {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	return [parts[0], parts[1]];
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function classifyState(rawState: string | undefined, pidAlive: boolean, hasStatus: boolean): string {
	if (!hasStatus) return pidAlive ? "starting" : "crashed";
	const state = rawState || "unknown";
	// paused is intentionally alive — do not classify as crashed even if the poll window is wide
	if (state === "running" && !pidAlive) return "crashed";
	return state;
}

function tailLines(content: string, count: number): string[] {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.slice(-count);
}

function truncatePlain(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return "…";
	return text.slice(0, width - 1) + "…";
}

function elapsedSince(iso: string | null | undefined, nowMs = Date.now()): string {
	if (!iso) return "unknown";
	const started = Date.parse(iso);
	if (!Number.isFinite(started)) return "unknown";
	return formatDurationActive(Math.max(0, Math.floor((nowMs - started) / 1000)));
}

export function elapsedIssue(status: PipelineStatus | undefined, nowMs = Date.now()): string {
	const fromTimestamp = elapsedSince(status?.current_issue_started_at, nowMs);
	if (fromTimestamp !== "unknown") return fromTimestamp;

	// current_issue_elapsed_seconds is a write-time snapshot. Use it only as a
	// fallback for old/sparse status files that do not have a parseable start time.
	const elapsedSeconds = status?.current_issue_elapsed_seconds;
	if (typeof elapsedSeconds === "number" && Number.isFinite(elapsedSeconds)) {
		return formatDurationActive(Math.max(0, Math.floor(elapsedSeconds)));
	}
	return "unknown";
}

function completedIssueDetails(status: PipelineStatus | undefined): CompletedIssue[] {
	if (Array.isArray(status?.issues_completed_details) && status.issues_completed_details.length > 0) {
		return status.issues_completed_details;
	}
	return (status?.issues_completed ?? []).map((issue) => ({ issue, duration_seconds: null }));
}

function formatCompleted(items: CompletedIssue[]): string {
	if (items.length === 0) return "none";
	return items
		.map((item) => {
			const duration = typeof item.duration_seconds === "number" ? formatDurationCompleted(item.duration_seconds) : "unknown";
			const pr = item.pr ? ` PR #${item.pr}` : "";
			return `#${item.issue} ${duration}${pr}`;
		})
		.join(", ");
}

function formatIssueList(items: number[]): string {
	if (items.length === 0) return "none";
	return items.map((issue) => `#${issue}`).join(", ");
}

/**
 * Format a duration for active issue/phase display (used by elapsedSince and elapsedIssue fallback).
 * <60s:       "42s"
 * 60–599s:    minutes + residual seconds if > 0, e.g. "1m", "3m20s", "9m59s"
 * 600–3599s:  whole minutes only, e.g. "10m", "59m"
 * 3600–86399s: hours + residual minutes if > 0, e.g. "1h", "1h12m", "23h59m"
 * >=86400s:   days + residual hours if > 0, e.g. "1d", "2d4h"
 */
export function formatDurationActive(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 10) {
		// 60–599s: show seconds residual
		const residualSec = seconds % 60;
		return residualSec > 0 ? `${minutes}m${residualSec}s` : `${minutes}m`;
	}
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const residualMin = minutes % 60;
		return residualMin > 0 ? `${hours}h${residualMin}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const residualHour = hours % 24;
	return residualHour > 0 ? `${days}d${residualHour}h` : `${days}d`;
}

/**
 * Format a duration for completed issue display (used by formatCompleted only).
 * <60s:       "<1m"
 * 60–3599s:   whole minutes only, e.g. "1m", "56m", "59m"
 * 3600–86399s: hours + residual minutes if > 0, e.g. "1h", "1h12m"
 * >=86400s:   days + residual hours if > 0, e.g. "1d", "2d4h"
 */
export function formatDurationCompleted(seconds: number): string {
	if (seconds < 60) return "<1m";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const residualMin = minutes % 60;
		return residualMin > 0 ? `${hours}h${residualMin}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const residualHour = hours % 24;
	return residualHour > 0 ? `${days}d${residualHour}h` : `${days}d`;
}

async function fileHasContent(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.size > 0;
	} catch {
		return false;
	}
}

function stateIndicator(state: string): string {
	switch (state) {
		case "running":
		case "starting":
			return "●";
		case "paused": // intentionally not terminal — process is alive and waiting for resume/abort
			return "⏸";
		case "completed":
			return "✓";
		case "blocked":
			return "⚠";
		case "aborted":
		case "killed":
		case "crashed":
			return "✗";
		default:
			return "?";
	}
}

function pipelineLabel(pipeline: PipelineView): string {
	const issue = pipeline.status?.current_issue ? `#${pipeline.status.current_issue}` : "-";
	return `${pipeline.id} · ${pipeline.repoName} · ${issue} · ${pipeline.state} · ${pipeline.phase}`;
}

function confirmTitle(command: "skip" | "abort", pipeline: PipelineView): string {
	return command === "abort" ? "Abort implementation pipeline?" : "Skip current pipeline issue?";
}

function confirmMessage(command: "skip" | "abort", pipeline: PipelineView): string {
	const issue = pipeline.status?.current_issue ? `#${pipeline.status.current_issue}` : "the current issue";
	const remaining = pipeline.status?.issues_remaining?.length ?? 0;
	if (command === "abort") {
		return `Abort pipeline ${pipeline.id}? This stops the pipeline before remaining issues (${remaining}) run.`;
	}
	return `Skip ${issue} for pipeline ${pipeline.id}? Any open PR/worktree may require manual cleanup.`;
}

function clearUI(ctx: ExtensionContextLike): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function notify(ctx: ExtensionContextLike, message: string, level: NotifyLevel): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console[level === "error" ? "error" : "log"](`[pipeline-status] ${message}`);
}

function color(theme: { fg: (color: string, text: string) => string } | undefined, colorName: string, text: string): string {
	return theme ? theme.fg(colorName, text) : text;
}

// ─── Exported pure helpers ──────────────────────────────────────────────────

/**
 * Sanitize and bound a resume_error value for widget display.
 * Returns null when the value is non-string, empty/whitespace/control-only, or max <= 0.
 * Collapses ASCII control characters (\x00-\x1F, \x7F) to spaces, collapses whitespace
 * to a single space, trims, and truncates to `max` characters (appending `…` if cut).
 */
export function formatResumeError(value: unknown, max = 160): string | null {
	if (typeof value !== "string") return null;
	if (max <= 0) return null;
	const normalized = value.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return null;
	if (normalized.length <= max) return normalized;
	if (max === 1) return "…";
	return normalized.slice(0, max - 1) + "…";
}

// ─── Exported pure planner and helpers (used by tests and resume logic) ──────

export type ResumeAction =
	| { type: "control-file-write"; controlFile: string }
	| { type: "tmux-restart"; sessionName: string; shellCmd: string; scriptFile: string; statusFile: string }
	| { type: "refuse"; message: string; manualCommand?: string };

export type ResumePlanInput = {
	pipelineId: string;
	state: string;
	pidAlive: boolean;
	controlFile: string;
	statusFile: string;
	status?: PipelineStatus;
};

/**
 * Pure, synchronous planner for /pipeline-resume decisions.
 * No I/O, no process.kill, no pi.exec, no tmux — all side-effecting
 * operations remain in resumePipeline().
 */
export function planResumeAction(input: ResumePlanInput): ResumeAction {
	const { pipelineId, state, pidAlive, controlFile, statusFile, status } = input;

	if (state !== "paused") {
		return { type: "refuse", message: `Pipeline ${pipelineId} is not paused (state: ${state}). Only paused pipelines can be resumed.` };
	}

	if (pidAlive) {
		// Live PID: safety-harden controlFile before any write.
		if (!controlFile || !controlFile.startsWith("/")) {
			return { type: "refuse", message: `Pipeline ${pipelineId}: controlFile is missing or not absolute (got: ${controlFile || "(none)"}).` };
		}
		return { type: "control-file-write", controlFile };
	}

	// Dead PID: full precondition checks required for restart.
	if (!status) {
		return { type: "refuse", message: `Pipeline ${pipelineId}: cannot restart — status file is missing or unreadable.` };
	}
	if (status.schema_version !== 2) {
		const manual = manualResumeCommand(status.script_file, statusFile);
		return {
			type: "refuse",
			message: `Pipeline ${pipelineId}: schema_version is not 2 (got: ${status.schema_version ?? "(none)"}) — v1/unsupported schema is monitor-only; cannot auto-restart.`,
			...(manual ? { manualCommand: manual } : {}),
		};
	}
	if (status.resume_supported !== true) {
		const manual = manualResumeCommand(status.script_file, statusFile);
		return {
			type: "refuse",
			message: `Pipeline ${pipelineId}: resume_supported is not true — this pipeline cannot be automatically restarted.`,
			...(manual ? { manualCommand: manual } : {}),
		};
	}
	if (status.checkpoint !== "between-issues") {
		const manual = manualResumeCommand(status.script_file, statusFile);
		return {
			type: "refuse",
			message: `Pipeline ${pipelineId}: checkpoint is ${JSON.stringify(status.checkpoint ?? null)} — only 'between-issues' is supported for auto-restart.`,
			...(manual ? { manualCommand: manual } : {}),
		};
	}
	const scriptFile = status.script_file;
	if (!scriptFile || !scriptFile.startsWith("/")) {
		return { type: "refuse", message: `Pipeline ${pipelineId}: script_file is missing or not absolute (got: ${scriptFile ?? "(none)"}).` };
	}
	if (!statusFile || !statusFile.startsWith("/")) {
		return { type: "refuse", message: `Pipeline ${pipelineId}: statusFile path is missing or not absolute (got: ${statusFile ?? "(none)"}).` };
	}

	const sessionName = resumeSessionName(pipelineId);
	const shellCmd = `${shellQuote(scriptFile)} --resume ${shellQuote(statusFile)}; exec bash`;
	return { type: "tmux-restart", sessionName, shellCmd, scriptFile, statusFile };
}

// ─── Exported pure helpers ────────────────────────────────────────────────────

/**
 * Shell-quote a single path argument so it is safe to pass inside a
 * tmux command string that the shell will interpret.  Uses single-quote
 * wrapping with embedded single-quote escaping (the '\'' pattern).
 */
export function shellQuote(arg: string): string {
	const escapedSingleQuote = "'\\''";
	return "'" + arg.replace(/'/g, escapedSingleQuote) + "'";
}

/**
 * Deterministic, bounded tmux session name for a pipeline resume.
 * Sanitizes the id to only alnum/dash chars and caps at 40 chars.
 */
export function resumeSessionName(pipelineId: string): string {
	const safe = pipelineId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40);
	return `resume-${safe}`;
}

/**
 * Human-readable manual resume command string shown in error/warning
 * notifications when automatic restart is not possible.
 */
export function manualResumeCommand(scriptFile: string | undefined, statusFile: string | undefined): string {
	if (!scriptFile || !statusFile) return "";
	return `${shellQuote(scriptFile)} --resume ${shellQuote(statusFile)}`;
}
