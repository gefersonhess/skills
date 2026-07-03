import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
	totalElapsed: string;
};

type WidgetComponentLike = {
	render: (width: number) => string[];
	invalidate: () => void;
	dispose?: () => void;
};

type WidgetFactoryLike = (
	tui: { requestRender: () => void },
	theme: { fg: (color: string, text: string) => string },
) => WidgetComponentLike;

type ExtensionContextLike = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	ui: {
		theme?: {
			fg: (color: string, text: string) => string;
		};
		setStatus: (key: string, value?: string) => void;
		setWidget: (key: string, value?: string[] | WidgetFactoryLike, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
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
	let statusHidden = false;
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
		statusHidden = false;
		if (ctx.hasUI) clearUI(ctx as ExtensionContextLike);
	});

	pi.registerCommand("pipeline-status", {
		description: "Show implementation pipeline status for the current repo; use --help for supported options",
		handler: async (args, ctx) => {
			const [actionRaw, id] = splitArgs(args);
			const action = actionRaw || "show";
			if (isHelpAction(action)) {
				notify(ctx as ExtensionContextLike, pipelineStatusHelpText(), "info");
				return;
			}
			if (action === "hide") {
				statusHidden = true;
				clearUI(ctx as ExtensionContextLike);
				notify(ctx as ExtensionContextLike, "Pipeline status hidden for this session. Use /pipeline-status show or /pipeline-show to restore it.", "info");
				return;
			}

			await refresh(ctx as ExtensionContextLike);
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

	pi.registerCommand("pipeline-hide", {
		description: "Hide the implementation pipeline status widget for this session",
		handler: async (_args, ctx) => {
			statusHidden = true;
			clearUI(ctx as ExtensionContextLike);
			notify(ctx as ExtensionContextLike, "Pipeline status hidden for this session. Use /pipeline-show to restore it.", "info");
		},
	});

	pi.registerCommand("pipeline-show", {
		description: "Show the implementation pipeline status widget for this session",
		handler: async (_args, ctx) => {
			statusHidden = false;
			await refresh(ctx as ExtensionContextLike);
			showStatus(ctx as ExtensionContextLike);
		},
	});

	pi.registerCommand("pipeline-run", {
		description: "Launch a new implementation pipeline. Args: JSON object or key=value pairs. Required: repo, worktreeBase, ownerRepo, aiReviewProvider, aiReviewApiBase, baseBranch, issues, branches.",
		handler: async (args, ctx) => {
			const typedCtx = ctx as ExtensionContextLike;
			const parsedOrError = parsePipelineRunArgs(args.trim());
			if (!parsedOrError.ok) {
				notify(typedCtx, `pipeline-run: ${parsedOrError.error}`, "error");
				return;
			}
			const validOrError = validateLaunchParams(parsedOrError.params);
			if (!validOrError.ok) {
				notify(typedCtx, `pipeline-run validation: ${validOrError.errors.join("; ")}`, "error");
				return;
			}
			const scriptPath = pipelineScriptPath();
			const launchResult = await executeLaunch(pi, validOrError.params, scriptPath);
			if (!launchResult.ok) {
				notify(typedCtx, `pipeline-run launch failed: ${launchResult.error}`, "error");
				return;
			}
			notify(typedCtx, formatLaunchSummary(launchResult), "info");
			await refresh(typedCtx);
		},
	});

	pi.registerTool({
		name: "pipeline_run",
		label: "Launch Pipeline",
		description: "Launch a new implementation pipeline in a detached tmux session. Returns session name, config path, log path, and status path.",
		promptSnippet: "Launch an implementation pipeline for a list of GitHub issues",
		promptGuidelines: [
			"Use pipeline_run to start a new implementation pipeline instead of writing bash or running pipeline.sh directly. Always prefer pipeline_run unless tmux is unavailable and the user explicitly approves a fallback.",
		],
		parameters: {
			type: "object" as const,
			required: ["repo", "worktreeBase", "ownerRepo", "aiReviewProvider", "aiReviewApiBase", "baseBranch", "issues", "branches"],
			properties: {
				// Required
				repo: { type: "string", description: "Absolute path to canonical repo checkout" },
				worktreeBase: { type: "string", description: "Absolute path for worktrees base directory" },
				ownerRepo: { type: "string", description: "GitHub owner/repo, e.g. org/repo-name" },
				aiReviewProvider: { type: "string", description: "AI review provider: coderabbit or ghe-pr-bot" },
				aiReviewApiBase: { type: "string", description: "GitHub API base URL for the provider" },
				baseBranch: { type: "string", description: "Base branch to merge into, e.g. main or master" },
				issues: { type: "array", items: { type: "number" }, description: "Issue numbers to implement" },
				branches: { type: "array", items: { type: "string" }, description: "Branch names, same length as issues" },
				// Optional
				mergeStrategy: { type: "string", description: "squash (default), merge, or rebase" },
				reviewLoopCount: { type: "number", description: "Max bot review rounds (default: 5)" },
				timeoutImpl: { type: "number", description: "Implementation timeout in seconds (default: 2400)" },
				timeoutReview: { type: "number", description: "Self-review timeout in seconds (default: 1200)" },
				timeoutBot: { type: "number", description: "Bot review timeout in seconds (default: 7200)" },
				timeoutCi: { type: "number", description: "CI polling timeout in seconds (default: 600)" },
				timeoutGate: { type: "number", description: "Scope gate timeout in seconds (default: 120)" },
				handoffPollSeconds: { type: "number", description: "Handoff-file polling interval (default: 5)" },
				ciPollSeconds: { type: "number", description: "CI status polling interval (default: 10)" },
				pausePollSeconds: { type: "number", description: "Paused control-file polling interval (default: 2)" },
				deadAgentFlushSeconds: { type: "number", description: "Dead-agent handoff flush grace period (default: 2)" },
				finalStatusSettleSeconds: { type: "number", description: "Post-issue settle delay in seconds; 0 means no delay (default: 0)" },
				localCoderabbitPrecheck: { type: "boolean", description: "Run local coderabbit review before opening PRs when provider=coderabbit (default: true)" },
				skipReview: { type: "boolean", description: "Skip self-review phase (default: false)" },
				skipBot: { type: "boolean", description: "Skip bot review phase (default: false)" },
				skipScopeGate: { type: "boolean", description: "Skip scope gate (default: false)" },
				forceIssues: { type: "string", description: "Comma-separated issue numbers to bypass scope gate" },
				noMerge: { type: "boolean", description: "Stop after review without merging (default: false)" },
				continueOnFailure: { type: "boolean", description: "Continue past failures for independent issues (default: false)" },
				extraImplContext: { type: "string", description: "Extra context appended to implementation prompt" },
			},
		},
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const validOrError = validateLaunchParams(params as unknown as PipelineLaunchParams);
			if (!validOrError.ok) {
				throw new Error(`pipeline_run validation: ${validOrError.errors.join("; ")}`);
			}
			const scriptPath = pipelineScriptPath();
			const launchResult = await executeLaunch(pi, validOrError.params, scriptPath);
			if (!launchResult.ok) {
				throw new Error(`pipeline_run launch failed: ${launchResult.error}`);
			}
			return {
				content: [{ type: "text" as const, text: formatLaunchSummary(launchResult) }],
				details: {
					sessionName: launchResult.sessionName,
					configPath: launchResult.configPath,
					logDir: launchResult.logDir,
					logFile: launchResult.logFile,
					statusFile: launchResult.statusFile,
					controlFile: launchResult.controlFile,
					attachCmd: launchResult.attachCmd,
					issues: launchResult.issues,
				},
			};
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
				totalElapsed: elapsedSince(status?.started_at),
			});
		}
		return views;
	}

	function render(ctx: ExtensionContextLike): void {
		if (!ctx.hasUI) return;
		if (statusHidden || pipelines.length === 0) {
			clearUI(ctx);
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, (_tui, _theme) => ({
			render(width: number): string[] {
				return widgetLines(ctx, width);
			},
			invalidate() {},
		}), { placement: "belowEditor" });
	}

	function widgetLines(ctx: ExtensionContextLike, width?: number): string[] {
		const lines: string[] = [];
		const includeHandle = pipelines.length > 1;
		for (const pipeline of pipelines) {
			lines.push(compactPipelineLine(ctx, pipeline, { includeStatusHint: true, includeHandle, width }));
			if (pipeline.state === "blocked") {
				const resumeErr = formatResumeError(pipeline.status?.resume_error);
				if (resumeErr !== null) {
					lines.push(color(theme, "dim", `  resume error: ${resumeErr}`));
				}
			}
		}
		return lines;
	}

	function compactPipelineLine(
		ctx: ExtensionContextLike,
		pipeline: PipelineView,
		options: { includeStatusHint: boolean; includeHandle: boolean; width?: number },
	): string {
		const theme = ctx.ui.theme;
		const handle = options.includeHandle ? `${pipelineHandle(pipeline)} ` : "";
		const icon = coloredStateIndicator(theme, pipeline.state);
		const pending = pendingCommands.get(pipeline.id);
		const details = compactPipelineDetails(theme, pipeline);
		const pendingText = pending ? `${color(theme, "dim", " (")}${emphasis(theme, pending)}${color(theme, "dim", " pending)")}` : "";
		const line = `${color(theme, "dim", handle)}${icon} ${details}${pendingText}`;
		if (!options.includeStatusHint) return line;
		return appendRightAlignedHint(line, color(theme, "dim", "/pipeline-status"), options.width, separator(theme));
	}

	function compactPipelineDetails(theme: { fg: (color: string, text: string) => string } | undefined, pipeline: PipelineView): string {
		const status = pipeline.status;
		const next = nextIssueLabel(status);
		const total = pipeline.totalElapsed === "unknown" ? keyValue(theme, "total", "unknown") : keyValue(theme, "total", pipeline.totalElapsed);
		const progress = emphasis(theme, progressLabel(status));
		if (pipeline.terminal) {
			return [emphasis(theme, stateWord(pipeline.state)), total, progress].join(separator(theme));
		}
		if (pipeline.state === "paused") {
			const paused = next ? `${emphasis(theme, "paused")} ${label(theme, "before")} ${emphasis(theme, next)}` : emphasis(theme, "paused");
			return [paused, total, progress].join(separator(theme));
		}
		const issue = status?.current_issue ? `#${status.current_issue}` : "no issue";
		const phase = compactPhase(pipeline.phase);
		const issueAndPhase = phase ? `${emphasis(theme, issue)} ${color(theme, "accent", phase)}` : emphasis(theme, issue);
		const item = pipeline.issueElapsed === "unknown" ? keyValue(theme, "item", "unknown") : keyValue(theme, "item", pipeline.issueElapsed);
		const parts = [issueAndPhase, item, total, progress];
		if (next) parts.push(`${label(theme, "next")} ${emphasis(theme, next)}`);
		if (status?.current_pr) parts.push(`${label(theme, "PR")} ${emphasis(theme, `#${status.current_pr}`)}`);
		return parts.join(separator(theme));
	}

	function pipelineHandle(pipeline: PipelineView): string {
		const index = pipelines.indexOf(pipeline);
		return index >= 0 ? `p${index + 1}` : pipeline.id;
	}

	function coloredStateIndicator(theme: { fg: (color: string, text: string) => string } | undefined, state: string): string {
		return color(theme, stateColorName(state), stateIndicator(state));
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
		statusHidden = false;
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
			const handleMatch = id.match(/^p([1-9][0-9]*)$/i);
			if (handleMatch) {
				const pipeline = pipelines[Number(handleMatch[1]) - 1];
				if (!pipeline || !candidates.includes(pipeline)) {
					notify(ctx, `No matching pipeline found for handle '${id}'.`, "error");
					return undefined;
				}
				return pipeline;
			}
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

function isHelpAction(action: string): boolean {
	return action === "--help" || action === "-h" || action === "help";
}

export function pipelineStatusHelpText(): string {
	return [
		"/pipeline-status usage:",
		"  /pipeline-status [show|list]              Show compact pipeline status for this repo.",
		"  /pipeline-status hide                     Hide pipeline status for this session.",
		"  /pipeline-status pause [id|pN]            Pause the selected running pipeline after the current issue.",
		"  /pipeline-status resume [id|pN]           Resume a paused pipeline.",
		"  /pipeline-status skip [id|pN]             Skip the current pipeline issue after confirmation.",
		"  /pipeline-status abort [id|pN]            Abort the selected pipeline after confirmation.",
		"  /pipeline-status dismiss [id|pN]          Dismiss a terminal pipeline from the widget.",
		"  /pipeline-status log [id|pN]              Open/tail the selected pipeline log.",
		"  /pipeline-status --help|-h|help           Show this help.",
		"",
		"Shortcuts:",
		"  /pipeline-pause [id|pN]    /pipeline-resume [id|pN]",
		"  /pipeline-skip [id|pN]     /pipeline-abort [id|pN]",
		"  /pipeline-log [id|pN]      /pipeline-dismiss [id|pN]",
		"  /pipeline-hide             /pipeline-show",
		"",
		"Target selection:",
		"  Omit id when only one pipeline matches. Use short handles like p1/p2 from the widget,",
		"  a full pipeline id, or a unique pipeline id prefix when multiple pipelines are visible.",
	].join("\n");
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

export function visibleTextLength(text: string): number {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").length;
}

export function appendRightAlignedHint(line: string, hint: string, width: number | undefined, fallbackSeparator = " · "): string {
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
		return `${line}${fallbackSeparator}${hint}`;
	}
	const gap = Math.floor(width) - visibleTextLength(line) - visibleTextLength(hint);
	if (gap >= 1) return `${line}${" ".repeat(gap)}${hint}`;
	return `${line}${fallbackSeparator}${hint}`;
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

function progressLabel(status: PipelineStatus | undefined): string {
	const done = completedIssueDetails(status).length;
	const total = status?.issues_total?.length ?? 0;
	return total > 0 ? `${done}/${total} done` : `${done} done`;
}

function nextIssueLabel(status: PipelineStatus | undefined): string {
	const next = status?.next_issue ?? status?.issues_remaining?.[0];
	return typeof next === "number" && Number.isFinite(next) ? `#${next}` : "";
}

function compactPhase(phase: string): string {
	switch (phase) {
		case "implementation":
			return "impl";
		case "self-review":
			return "review";
		case "bot-review":
			return "bot";
		case "scope-gate":
			return "scope";
		case "worktree-setup":
			return "setup";
		case "tracker-checkpoint":
			return "tracker";
		case "merging":
			return "merge";
		case "-":
		case "":
			return "";
		default:
			return phase;
	}
}

function stateWord(state: string): string {
	switch (state) {
		case "completed":
			return "completed";
		case "aborted":
		case "killed":
			return "stopped";
		case "crashed":
			return "crashed";
		case "blocked":
			return "blocked";
		default:
			return state || "unknown";
	}
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

export function stateIndicator(state: string): string {
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
			return "■";
		default:
			return "○";
	}
}

export function stateColorName(state: string): string {
	switch (state) {
		case "running":
		case "starting":
			return "accent";
		case "paused":
		case "blocked":
			return "warning";
		case "completed":
			return "success";
		case "aborted":
		case "killed":
		case "crashed":
			return "error";
		default:
			return "muted";
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

function emphasis(theme: { fg: (color: string, text: string) => string } | undefined, text: string): string {
	return color(theme, "text", text);
}

function label(theme: { fg: (color: string, text: string) => string } | undefined, text: string): string {
	return color(theme, "dim", text);
}

function separator(theme: { fg: (color: string, text: string) => string } | undefined): string {
	return color(theme, "dim", " · ");
}

function keyValue(theme: { fg: (color: string, text: string) => string } | undefined, key: string, value: string): string {
	return `${label(theme, key)} ${emphasis(theme, value)}`;
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

// ─── Pipeline Launch: types ──────────────────────────────────────────────────

export type PipelineLaunchParams = {
	// Required
	repo: string;
	worktreeBase: string;
	ownerRepo: string;
	aiReviewProvider: string;
	aiReviewApiBase: string;
	baseBranch: string;
	issues: number[];
	branches: string[];
	// Optional
	mergeStrategy?: string;
	reviewLoopCount?: number;
	timeoutImpl?: number;
	timeoutReview?: number;
	timeoutBot?: number;
	timeoutCi?: number;
	timeoutGate?: number;
	handoffPollSeconds?: number;
	ciPollSeconds?: number;
	pausePollSeconds?: number;
	deadAgentFlushSeconds?: number;
	finalStatusSettleSeconds?: number;
	localCoderabbitPrecheck?: boolean;
	skipReview?: boolean;
	skipBot?: boolean;
	skipScopeGate?: boolean;
	forceIssues?: string;
	noMerge?: boolean;
	continueOnFailure?: boolean;
	extraImplContext?: string;
};

export type ValidateResult =
	| { ok: true; params: PipelineLaunchParams }
	| { ok: false; errors: string[] };

export type ParseResult =
	| { ok: true; params: Partial<PipelineLaunchParams> & Record<string, unknown> }
	| { ok: false; error: string };

export type LaunchSessionResult =
	| { ok: true; sessionName: string; configPath: string; logDir: string; logFile: string; statusFile: string; controlFile: string; attachCmd: string; issues: number[] }
	| { ok: false; error: string };

export type PlanLaunchAction =
	| { type: "launch"; sessionName: string; configPath: string; logDir: string; shellCmd: string; scriptPath: string }
	| { type: "session-exists"; sessionName: string; suffix: number }
	| { type: "error"; message: string };

// ─── Pipeline Launch: pure helpers ──────────────────────────────────────────

const REQUIRED_STRINGS: (keyof PipelineLaunchParams)[] = [
	"repo", "worktreeBase", "ownerRepo", "aiReviewProvider", "aiReviewApiBase", "baseBranch",
];

const POSITIVE_INT_OPTS: (keyof PipelineLaunchParams)[] = [
	"reviewLoopCount", "timeoutImpl", "timeoutReview", "timeoutBot", "timeoutCi", "timeoutGate",
	"handoffPollSeconds", "ciPollSeconds", "pausePollSeconds", "deadAgentFlushSeconds",
];

const BOOLEAN_OPTS: (keyof PipelineLaunchParams)[] = [
	"localCoderabbitPrecheck", "skipReview", "skipBot", "skipScopeGate",
	"noMerge", "continueOnFailure",
];

/**
 * Pure validation of pipeline launch parameters.
 * Does NOT check repo existence or same-repo concurrency — those are delegated to pipeline.sh.
 */
export function validateLaunchParams(raw: Partial<PipelineLaunchParams> & Record<string, unknown>): ValidateResult {
	const errors: string[] = [];

	// Required non-empty strings
	for (const key of REQUIRED_STRINGS) {
		const val = raw[key];
		if (typeof val !== "string" || val.trim() === "") {
			errors.push(`${key} is required and must be a non-empty string`);
		}
	}

	// Absolute path checks for repo and worktreeBase
	if (typeof raw.repo === "string" && raw.repo.trim() !== "" && !raw.repo.startsWith("/")) {
		errors.push("repo must be an absolute path");
	}
	if (typeof raw.worktreeBase === "string" && raw.worktreeBase.trim() !== "" && !raw.worktreeBase.startsWith("/")) {
		errors.push("worktreeBase must be an absolute path");
	}

	// AI review provider
	const provider = typeof raw.aiReviewProvider === "string" ? raw.aiReviewProvider : "";
	if (provider !== "" && provider !== "coderabbit" && provider !== "ghe-pr-bot") {
		errors.push(`aiReviewProvider must be coderabbit or ghe-pr-bot (got: ${provider})`);
	}

	// issues: non-empty array of positive integers
	if (!Array.isArray(raw.issues) || raw.issues.length === 0) {
		errors.push("issues must be a non-empty array of issue numbers");
	} else {
		for (const iss of raw.issues) {
			if (typeof iss !== "number" || !Number.isInteger(iss) || iss <= 0) {
				errors.push(`issues must contain only positive integers (got: ${JSON.stringify(iss)})`);
				break;
			}
		}
	}

	// branches: non-empty array of non-empty strings, same length as issues
	if (!Array.isArray(raw.branches) || raw.branches.length === 0) {
		errors.push("branches must be a non-empty array of branch names");
	} else {
		for (const br of raw.branches) {
			if (typeof br !== "string" || br.trim() === "") {
				errors.push("branches must contain only non-empty strings");
				break;
			}
		}
	}

	// issues and branches must be same length
	if (Array.isArray(raw.issues) && raw.issues.length > 0 && Array.isArray(raw.branches) && raw.branches.length > 0) {
		if (raw.issues.length !== raw.branches.length) {
			errors.push(`issues (${raw.issues.length}) and branches (${raw.branches.length}) must be the same length`);
		}
	}

	// mergeStrategy
	if (raw.mergeStrategy !== undefined && raw.mergeStrategy !== "squash" && raw.mergeStrategy !== "merge" && raw.mergeStrategy !== "rebase") {
		errors.push(`mergeStrategy must be squash, merge, or rebase (got: ${String(raw.mergeStrategy)})`);
	}

	// Positive integer options
	for (const key of POSITIVE_INT_OPTS) {
		const val = raw[key];
		if (val !== undefined) {
			if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
				errors.push(`${key} must be a positive integer (got: ${JSON.stringify(val)})`);
			}
		}
	}

	// finalStatusSettleSeconds: may be 0 or positive integer
	if (raw.finalStatusSettleSeconds !== undefined) {
		const val = raw.finalStatusSettleSeconds;
		if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
			errors.push(`finalStatusSettleSeconds must be a non-negative integer (got: ${JSON.stringify(val)})`);
		}
	}

	// Boolean options accept true/false or numeric 0/1 so command callers can use shell-friendly values.
	for (const key of BOOLEAN_OPTS) {
		const val = raw[key];
		if (val !== undefined && typeof val !== "boolean" && val !== 0 && val !== 1) {
			errors.push(`${key} must be a boolean or 0/1 (got: ${JSON.stringify(val)})`);
		}
	}

	if (raw.extraImplContext !== undefined && typeof raw.extraImplContext !== "string") {
		errors.push(`extraImplContext must be a string (got: ${JSON.stringify(raw.extraImplContext)})`);
	}

	if (errors.length > 0) return { ok: false, errors };

	// Build validated params
	const params: PipelineLaunchParams = {
		repo: (raw.repo as string).trim(),
		worktreeBase: (raw.worktreeBase as string).trim(),
		ownerRepo: (raw.ownerRepo as string).trim(),
		aiReviewProvider: (raw.aiReviewProvider as string).trim(),
		aiReviewApiBase: (raw.aiReviewApiBase as string).trim(),
		baseBranch: (raw.baseBranch as string).trim(),
		issues: raw.issues as number[],
		branches: raw.branches as string[],
	};

	if (raw.mergeStrategy !== undefined) params.mergeStrategy = raw.mergeStrategy as string;
	if (raw.reviewLoopCount !== undefined) params.reviewLoopCount = raw.reviewLoopCount as number;
	if (raw.timeoutImpl !== undefined) params.timeoutImpl = raw.timeoutImpl as number;
	if (raw.timeoutReview !== undefined) params.timeoutReview = raw.timeoutReview as number;
	if (raw.timeoutBot !== undefined) params.timeoutBot = raw.timeoutBot as number;
	if (raw.timeoutCi !== undefined) params.timeoutCi = raw.timeoutCi as number;
	if (raw.timeoutGate !== undefined) params.timeoutGate = raw.timeoutGate as number;
	if (raw.handoffPollSeconds !== undefined) params.handoffPollSeconds = raw.handoffPollSeconds as number;
	if (raw.ciPollSeconds !== undefined) params.ciPollSeconds = raw.ciPollSeconds as number;
	if (raw.pausePollSeconds !== undefined) params.pausePollSeconds = raw.pausePollSeconds as number;
	if (raw.deadAgentFlushSeconds !== undefined) params.deadAgentFlushSeconds = raw.deadAgentFlushSeconds as number;
	if (raw.finalStatusSettleSeconds !== undefined) params.finalStatusSettleSeconds = raw.finalStatusSettleSeconds as number;
	if (raw.localCoderabbitPrecheck !== undefined) params.localCoderabbitPrecheck = normalizeBoolean(raw.localCoderabbitPrecheck);
	if (raw.skipReview !== undefined) params.skipReview = normalizeBoolean(raw.skipReview);
	if (raw.skipBot !== undefined) params.skipBot = normalizeBoolean(raw.skipBot);
	if (raw.skipScopeGate !== undefined) params.skipScopeGate = normalizeBoolean(raw.skipScopeGate);
	if (raw.forceIssues !== undefined) params.forceIssues = String(raw.forceIssues);
	if (raw.noMerge !== undefined) params.noMerge = normalizeBoolean(raw.noMerge);
	if (raw.continueOnFailure !== undefined) params.continueOnFailure = normalizeBoolean(raw.continueOnFailure);
	if (raw.extraImplContext !== undefined) params.extraImplContext = raw.extraImplContext as string;

	return { ok: true, params };
}

/**
 * Generate a deterministic tmux session name for a new pipeline launch.
 * Format: impl-pipeline-<repo-name>-<timestamp-safe>
 */
export function launchSessionName(repoName: string, ts: string): string {
	const safeRepo = repoName.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
	const safeTs = ts.replace(/[^A-Za-z0-9]/g, "-").slice(0, 20);
	return `impl-pipeline-${safeRepo}-${safeTs}`;
}

/**
 * Render a shell-sourceable pipeline config file from validated launch params.
 * All string values are shell-quoted. Arrays use bash array syntax.
 * extraImplContext has control/newline chars collapsed.
 */
export function buildPipelineConfig(params: PipelineLaunchParams, logDir: string): string {
	const lines: string[] = [
		`# Pipeline config — generated by pipeline-run extension`,
		`REPO=${shellQuote(params.repo)}`,
		`WORKTREE_BASE=${shellQuote(params.worktreeBase)}`,
		`OWNER_REPO=${shellQuote(params.ownerRepo)}`,
		`AI_REVIEW_PROVIDER=${shellQuote(params.aiReviewProvider)}`,
		`AI_REVIEW_API_BASE=${shellQuote(params.aiReviewApiBase)}`,
		`BASE_BRANCH=${shellQuote(params.baseBranch)}`,
		`LOG_DIR=${shellQuote(logDir)}`,
	];

	// ISSUES array
	lines.push(`ISSUES=(${params.issues.map((n) => String(n)).join(" ")})`);

	// BRANCHES array — each entry shell-quoted
	const branchEntries = params.branches.map((b) => shellQuote(b)).join(" ");
	lines.push(`BRANCHES=(${branchEntries})`);

	// Optional string/int fields
	if (params.mergeStrategy !== undefined) lines.push(`MERGE_STRATEGY=${shellQuote(params.mergeStrategy)}`);
	if (params.reviewLoopCount !== undefined) lines.push(`REVIEW_LOOP_COUNT=${params.reviewLoopCount}`);
	if (params.timeoutImpl !== undefined) lines.push(`TIMEOUT_IMPL=${params.timeoutImpl}`);
	if (params.timeoutReview !== undefined) lines.push(`TIMEOUT_REVIEW=${params.timeoutReview}`);
	if (params.timeoutBot !== undefined) lines.push(`TIMEOUT_BOT=${params.timeoutBot}`);
	if (params.timeoutCi !== undefined) lines.push(`TIMEOUT_CI=${params.timeoutCi}`);
	if (params.timeoutGate !== undefined) lines.push(`TIMEOUT_GATE=${params.timeoutGate}`);
	if (params.handoffPollSeconds !== undefined) lines.push(`HANDOFF_POLL_SECONDS=${params.handoffPollSeconds}`);
	if (params.ciPollSeconds !== undefined) lines.push(`CI_POLL_SECONDS=${params.ciPollSeconds}`);
	if (params.pausePollSeconds !== undefined) lines.push(`PAUSE_POLL_SECONDS=${params.pausePollSeconds}`);
	if (params.deadAgentFlushSeconds !== undefined) lines.push(`DEAD_AGENT_FLUSH_SECONDS=${params.deadAgentFlushSeconds}`);
	if (params.finalStatusSettleSeconds !== undefined) lines.push(`FINAL_STATUS_SETTLE_SECONDS=${params.finalStatusSettleSeconds}`);

	// Optional booleans (write as 0/1)
	if (params.localCoderabbitPrecheck !== undefined) lines.push(`LOCAL_CODERABBIT_PRECHECK=${params.localCoderabbitPrecheck ? 1 : 0}`);
	if (params.skipReview !== undefined) lines.push(`SKIP_REVIEW=${params.skipReview ? 1 : 0}`);
	if (params.skipBot !== undefined) lines.push(`SKIP_BOT=${params.skipBot ? 1 : 0}`);
	if (params.skipScopeGate !== undefined) lines.push(`SKIP_SCOPE_GATE=${params.skipScopeGate ? 1 : 0}`);
	if (params.noMerge !== undefined) lines.push(`NO_MERGE=${params.noMerge ? 1 : 0}`);
	if (params.continueOnFailure !== undefined) lines.push(`CONTINUE_ON_FAILURE=${params.continueOnFailure ? 1 : 0}`);

	// forceIssues (string passthrough)
	if (params.forceIssues !== undefined && params.forceIssues !== "") {
		lines.push(`FORCE_ISSUES=${shellQuote(params.forceIssues)}`);
	}

	// extraImplContext: collapse control chars and newlines
	if (params.extraImplContext !== undefined && params.extraImplContext !== "") {
		const safe = params.extraImplContext
			.replace(/[\x00-\x1F\x7F]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (safe !== "") lines.push(`EXTRA_IMPL_CONTEXT=${shellQuote(safe)}`);
	}

	return lines.join("\n") + "\n";
}

/**
 * Plan a single launch action — pure, no I/O.
 * Returns the action type along with the session name, shell command, and paths.
 */
export function planLaunchAction(
	params: PipelineLaunchParams,
	scriptPath: string,
	ts: string,
	existingSessions: Set<string>,
	maxAttempts = 5,
): PlanLaunchAction {
	const repoName = basename(params.repo);
	let sessionName = launchSessionName(repoName, ts);
	let attempt = 0;
	while (existingSessions.has(sessionName)) {
		attempt++;
		if (attempt >= maxAttempts) {
			return { type: "session-exists", sessionName, suffix: attempt };
		}
		sessionName = launchSessionName(repoName, `${ts}-${attempt}`);
	}
	const logDir = `/tmp/${sessionName}`;
	const configPath = `${logDir}/config.sh`;
	const shellCmd = `${shellQuote(scriptPath)} ${shellQuote(configPath)}; exec bash`;
	return { type: "launch", sessionName, configPath, logDir, shellCmd, scriptPath };
}

/**
 * Parse /pipeline-run command args: JSON object (preferred) or key=value pairs.
 * issues=1,2,3 and branches=a,b,c are parsed as arrays.
 * Returns a partial params record for further validation.
 */
export function parsePipelineRunArgs(args: string): ParseResult {
	if (!args || args.trim() === "") {
		return {
			ok: false,
			error: "No arguments provided. Usage: /pipeline-run <JSON> or key=value pairs. Required: repo, worktreeBase, ownerRepo, aiReviewProvider, aiReviewApiBase, baseBranch, issues, branches.",
		};
	}

	const trimmed = args.trim();

	// Try JSON object first
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			return { ok: true, params: normalizeKvTypes(parsed) };
		} catch (e) {
			return { ok: false, error: `Invalid JSON: ${String(e)}` };
		}
	}

	// key=value parsing
	const result: Record<string, unknown> = {};
	const pairs = trimmed.match(/\S+=[^\s]*/g) ?? [];
	if (pairs.length === 0) {
		return { ok: false, error: `Cannot parse args as JSON or key=value pairs: ${trimmed.slice(0, 80)}` };
	}
	for (const pair of pairs) {
		const eqIdx = pair.indexOf("=");
		if (eqIdx < 0) continue;
		const key = pair.slice(0, eqIdx);
		const val = pair.slice(eqIdx + 1);
		// issues and branches are comma-separated arrays
		if (key === "issues") {
			result[key] = val.split(",").filter(Boolean).map((v) => Number(v.trim()));
		} else if (key === "branches") {
			result[key] = val.split(",").filter(Boolean).map((v) => v.trim());
		} else {
			result[key] = val;
		}
	}
	return { ok: true, params: normalizeKvTypes(result) };
}

/** Coerce string representations of numbers/booleans from JSON/kv parsing. */
function normalizeKvTypes(raw: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === "string") {
			if (v === "true") { out[k] = true; continue; }
			if (v === "false") { out[k] = false; continue; }
			const asNum = Number(v);
			if (v !== "" && Number.isFinite(asNum) && NUMERIC_KEYS.has(k)) { out[k] = asNum; continue; }
			if ((v === "0" || v === "1") && BOOLEAN_KEYS.has(k)) { out[k] = Number(v); continue; }
		}
		out[k] = v;
	}
	return out;
}

const NUMERIC_KEYS = new Set([
	"reviewLoopCount", "timeoutImpl", "timeoutReview", "timeoutBot", "timeoutCi", "timeoutGate",
	"handoffPollSeconds", "ciPollSeconds", "pausePollSeconds", "deadAgentFlushSeconds", "finalStatusSettleSeconds",
]);

const BOOLEAN_KEYS = new Set([
	"localCoderabbitPrecheck", "skipReview", "skipBot", "skipScopeGate", "noMerge", "continueOnFailure",
]);

function normalizeBoolean(value: unknown): boolean {
	return value === true || value === 1;
}

// ─── Pipeline Launch: I/O (not pure; used by command and tool handlers) ────────

/**
 * Resolve the pipeline.sh path relative to this extension file.
 */
function pipelineScriptPath(): string {
	// __filename in ESM-style: use import.meta.url when available, otherwise fallback
	try {
		const thisFile = fileURLToPath(import.meta.url);
		return resolve(dirname(thisFile), "../skills/implementation-pipeline/pipeline.sh");
	} catch (error) {
		throw new Error(`pipeline-status extension: cannot resolve pipeline.sh path from import.meta.url: ${String(error)}`);
	}
}

/**
 * Format a launch success result as a human-readable summary.
 */
function formatLaunchSummary(result: LaunchSessionResult & { ok: true }): string {
	return [
		`Implementation pipeline launched.`,
		`  Session: ${result.attachCmd}`,
		`  Config:  ${result.configPath}`,
		`  Log:     tail -f ${result.logFile}`,
		`  Status:  cat ${result.statusFile}`,
		`  Control: echo pause > ${result.controlFile}`,
		`  Issues:  ${result.issues.map((n) => `#${n}`).join(", ")}`,
	].join("\n");
}

/**
 * Execute a pipeline launch: write config, check tmux, check/unique session, spawn.
 * Returns success with session/config/log info or an error message.
 */
async function executeLaunch(
	pi: ExtensionAPI,
	params: PipelineLaunchParams,
	scriptPath: string,
): Promise<LaunchSessionResult> {
	// Check tmux availability
	const whichResult = await pi.exec("which", ["tmux"], { timeout: 3000 });
	if (whichResult.code !== 0) {
		return { ok: false, error: "tmux is not available. Cannot launch pipeline in detached session." };
	}

	// Generate timestamp-based session name
	const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T").slice(0, 20).replace(/[^A-Za-z0-9]/g, "-");

	const MAX_ATTEMPTS = 5;
	const existingSessions = new Set<string>();
	let action: PlanLaunchAction | undefined;
	while (true) {
		action = planLaunchAction(params, scriptPath, ts, existingSessions, MAX_ATTEMPTS);
		if (action.type !== "launch") {
			return { ok: false, error: `Could not find a unique session name after ${MAX_ATTEMPTS} attempts (last tried: ${action.sessionName}).` };
		}
		const hasSession = await pi.exec("tmux", ["has-session", "-t", action.sessionName], { timeout: 3000 });
		if (hasSession.code !== 0) break;
		existingSessions.add(action.sessionName);
	}

	const sessionName = action.sessionName;
	const logDir = action.logDir;
	const configPath = action.configPath;
	const logFile = `${logDir}/loop.log`;
	const statusFile = `${logDir}/status.json`;
	const controlFile = `${logDir}/control`;
	const attachCmd = `tmux attach -t ${sessionName}`;

	// Write config file
	try {
		await mkdir(logDir, { recursive: true });
		const configContent = buildPipelineConfig(params, logDir);
		await writeFile(configPath, configContent, { encoding: "utf8", mode: 0o600 });
	} catch (e) {
		return { ok: false, error: `Failed to write config to ${configPath}: ${String(e)}` };
	}

	// Launch detached tmux session
	const spawnResult = await pi.exec("tmux", ["new-session", "-d", "-s", sessionName, action.shellCmd], { timeout: 10000 });
	if (spawnResult.code !== 0) {
		return { ok: false, error: `tmux new-session failed: ${spawnResult.stderr.trim() || "unknown error"}` };
	}

	return { ok: true, sessionName, configPath, logDir, logFile, statusFile, controlFile, attachCmd, issues: params.issues };
}
