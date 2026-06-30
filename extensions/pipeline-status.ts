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
			const controls = pipeline.terminal
				? `dismiss: /pipeline-dismiss ${pipeline.id}`
				: pipeline.state === "paused"
					? `controls: /pipeline-resume ${pipeline.id} | /pipeline-abort ${pipeline.id}`
					: `controls: /pipeline-pause ${pipeline.id} | /pipeline-skip ${pipeline.id} | /pipeline-abort ${pipeline.id}`;

			lines.push(`${active}${pending ? ` (${pending} pending)` : ""}`);
			lines.push(color(theme, "dim", `   completed: ${formatCompleted(completed)}`));
			lines.push(color(theme, "dim", `   remaining: ${formatIssueList(remaining)}${skipped.length ? ` · skipped: ${formatIssueList(skipped)}` : ""}`));
			lines.push(color(theme, "dim", `   log: ${pipeline.logFile}`));
			lines.push(color(theme, pipeline.terminal ? "muted" : "dim", `   ${controls}`));
		}
		return lines;
	}

	async function steer(ctx: ExtensionContextLike, command: "pause" | "resume" | "skip" | "abort", id?: string): Promise<void> {
		const pipeline = await selectPipeline(ctx, id, { allowTerminal: false });
		if (!pipeline) return;

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

function classifyState(rawState: string | undefined, pidAlive: boolean, hasStatus: boolean): string {
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

function elapsedSince(iso: string | null | undefined): string {
	if (!iso) return "unknown";
	const started = Date.parse(iso);
	if (!Number.isFinite(started)) return "unknown";
	return formatDuration(Math.max(0, Math.floor((Date.now() - started) / 1000)));
}

function elapsedIssue(status: PipelineStatus | undefined): string {
	if (typeof status?.current_issue_elapsed_seconds === "number") {
		return formatDuration(status.current_issue_elapsed_seconds);
	}
	return elapsedSince(status?.current_issue_started_at);
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
			const duration = typeof item.duration_seconds === "number" ? formatDuration(item.duration_seconds) : "unknown";
			const pr = item.pr ? ` PR #${item.pr}` : "";
			return `#${item.issue} ${duration}${pr}`;
		})
		.join(", ");
}

function formatIssueList(items: number[]): string {
	if (items.length === 0) return "none";
	return items.map((issue) => `#${issue}`).join(", ");
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
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
