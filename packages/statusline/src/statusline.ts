import type {
	ExtensionAPI,
	ExtensionContext,
} from "@super-pi/coding-agent";
import { getAgentDir } from "./pi-runtime-lite.js";
import { exceedsAutoCompactionThreshold } from "./context-usage.js";
import {
	buildExtensionStatusIconAliases,
	type ExtensionStatusIconAliasMap,
	findDuplicateExtensions,
	readInstalledExtensionPackages,
} from "./extension-status.js";
import { type GitStatusSummary, gitStatusSummaryEqual, readGitStatus } from "./git-status.js";
import { type RuntimeState, renderExtensionStatusline, renderStatuslineLines } from "./render.js";
import {
	consumeStatuslineSettingsNotice,
	type LoadedStatuslineSettings,
	loadStatuslineSettingsForAgent,
} from "./settings.js";
import { calculateTokenSpeed } from "./token-speed.js";
import { addFooterUsage, createEmptyFooterUsageSummary, summarizeFooterUsage } from "./usage.js";

const STATUSLINE_KEY = "statusline";
const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const GIT_STATUS_EVENT_DEBOUNCE_MS = 250;
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();

function contextUsageFromAssistant(
	message: { stopReason: string; usage: { totalTokens?: number; input: number; output: number; cacheRead: number; cacheWrite: number } },
	ctx: ExtensionContext,
): ReturnType<ExtensionContext["getContextUsage"]> {
	if (message.stopReason === "aborted" || message.stopReason === "error") return ctx.getContextUsage();
	const usage = message.usage;
	const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const contextWindow = ctx.model?.contextWindow ?? 0;
	if (tokens <= 0 || contextWindow <= 0) return ctx.getContextUsage();
	return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}
export function registerStatusline(pi: ExtensionAPI) {
	let loaded: LoadedStatuslineSettings | undefined;
	let activeSessionManager: ExtensionContext["sessionManager"] | undefined;
	const runtime: RuntimeState = {
		turnCount: 0,
		contextUsage: undefined,
		compactionPending: false,
		activeTools: new Map(),
		isStreaming: false,
		thinkingLevel: "off",
		duplicateExtensions: [],
		extensionStatusIconAliases: EMPTY_EXTENSION_STATUS_ICON_ALIASES,
		usageSummary: createEmptyFooterUsageSummary(),
	};

	let sessionGeneration = 0;
	let gitStatusRequestId = 0;
	let activeGitStatusTarget: { cwd: string; generation: number } | undefined;
	let gitStatusRefreshInFlight = false;
	let gitStatusDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingGitStatusRefresh: { cwd: string; generation: number; requestId: number } | undefined;

	const refresh = () => runtime.requestRender?.();
	const ownsRuntime = (ctx: ExtensionContext) => ctx.sessionManager === activeSessionManager;

	const setGitStatus = (summary: GitStatusSummary | undefined) => {
		if (gitStatusSummaryEqual(runtime.gitStatus, summary)) return;
		runtime.gitStatus = summary;
		refresh();
	};

	const clearGitStatusDebounce = () => {
		if (!gitStatusDebounceTimer) return;
		clearTimeout(gitStatusDebounceTimer);
		gitStatusDebounceTimer = undefined;
	};

	const isActiveGitStatusTarget = (cwd: string, generation: number) =>
		activeGitStatusTarget?.cwd === cwd &&
		activeGitStatusTarget.generation === generation &&
		generation === sessionGeneration;

	const isCurrentGitStatusRequest = (cwd: string, generation: number, requestId: number) =>
		isActiveGitStatusTarget(cwd, generation) && requestId === gitStatusRequestId;

	const runGitStatusRefresh = (cwd: string, generation: number, requestId: number) => {
		if (!isCurrentGitStatusRequest(cwd, generation, requestId)) return;
		if (gitStatusRefreshInFlight) {
			pendingGitStatusRefresh = { cwd, generation, requestId };
			return;
		}

		gitStatusRefreshInFlight = true;
		void (async () => {
			try {
				const summary = await readGitStatus(pi, cwd);
				if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(summary);
			} catch {
				if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(undefined);
			} finally {
				gitStatusRefreshInFlight = false;
				const pending = pendingGitStatusRefresh;
				pendingGitStatusRefresh = undefined;
				if (pending) runGitStatusRefresh(pending.cwd, pending.generation, pending.requestId);
			}
		})();
	};

	const refreshGitStatus = (cwd: string, generation = sessionGeneration) => {
		if (!isActiveGitStatusTarget(cwd, generation)) return;
		runGitStatusRefresh(cwd, generation, ++gitStatusRequestId);
	};

	const scheduleGitStatusRefresh = (cwd: string, generation = sessionGeneration) => {
		if (!isActiveGitStatusTarget(cwd, generation)) return;
		const requestId = ++gitStatusRequestId;
		clearGitStatusDebounce();
		gitStatusDebounceTimer = setTimeout(() => {
			gitStatusDebounceTimer = undefined;
			runGitStatusRefresh(cwd, generation, requestId);
		}, GIT_STATUS_EVENT_DEBOUNCE_MS);
	};

	const scheduleGitStatusRefreshForContext = (ctx: ExtensionContext) => {
		if (!loaded?.config.segments.includes("branch")) return;
		if (!activeGitStatusTarget || activeGitStatusTarget.cwd !== ctx.cwd) return;
		scheduleGitStatusRefresh(activeGitStatusTarget.cwd, activeGitStatusTarget.generation);
	};

	const installFooter = (ctx: ExtensionContext) => {
		const generation = ++sessionGeneration;
		const cwd = ctx.cwd;
		activeSessionManager = ctx.sessionManager;
		clearGitStatusDebounce();
		activeGitStatusTarget = ctx.mode === "tui" ? { cwd, generation } : undefined;
		runtime.gitStatus = undefined;
		runtime.duplicateExtensions = [];
		runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		if (!activeGitStatusTarget || !loaded) return;
		const installedPackages = readInstalledExtensionPackages(cwd, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		runtime.duplicateExtensions = findDuplicateExtensions(installedPackages);
		runtime.extensionStatusIconAliases = buildExtensionStatusIconAliases(installedPackages);
		ctx.ui.setFooter((tui, theme, footerData) => {
			runtime.requestRender = () => tui.requestRender();

			const refreshFooterGitStatus = () => refreshGitStatus(cwd, generation);
			const branchUnsubscribe = footerData.onBranchChange(() => {
				if (!loaded?.config.segments.includes("branch")) return;
				runtime.gitStatus = undefined;
				clearGitStatusDebounce();
				refreshFooterGitStatus();
				tui.requestRender();
			});
			const clock = setInterval(() => {
				const segments = loaded?.config.segments ?? [];
				const showsBranch = segments.includes("branch");
				const showsTime = segments.includes("time");

				// Avoid idle footer redraws when no periodically changing segment is visible.
				// Periodic full-TUI renders can interrupt Windows IME pre-edit text and make
				// Pinyin input flicker even though the displayed footer has not changed.
				if (!showsBranch && !showsTime) return;
				if (showsBranch) {
					clearGitStatusDebounce();
					refreshFooterGitStatus();
				}
				tui.requestRender();
			}, GIT_STATUS_REFRESH_INTERVAL_MS);

			return {
				dispose() {
					branchUnsubscribe();
					clearInterval(clock);
					if (isActiveGitStatusTarget(cwd, generation)) {
						activeGitStatusTarget = undefined;
						clearGitStatusDebounce();
						pendingGitStatusRefresh = undefined;
						runtime.gitStatus = undefined;
						runtime.duplicateExtensions = [];
						runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
						runtime.requestRender = undefined;
					}
				},
				invalidate() {},
				render(width: number): string[] {
					if (!loaded) return [];
					const config = loaded.config;
					const lines = renderStatuslineLines(width, ctx, footerData, theme, config, runtime);
					lines.push(
						...renderExtensionStatusline(width, footerData, theme, config, runtime, lines),
					);
					return lines;
				},
			};
		});
		if (loaded.config.segments.includes("branch")) refreshGitStatus(cwd, generation);
	};

	const agentDir = getAgentDir();
	pi.on("session_start", (_event, ctx) => {
		runtime.turnCount = 0;
		runtime.contextUsage = ctx.getContextUsage();
		runtime.compactionPending = false;
		runtime.usageSummary = summarizeFooterUsage(ctx.sessionManager.getEntries());
		runtime.activeTools.clear();
		runtime.isStreaming = false;
		runtime.generationStartedAtMs = undefined;
		runtime.tokenSpeed = undefined;
		loaded = loadStatuslineSettingsForAgent(agentDir);
		const settingsNotice = consumeStatuslineSettingsNotice();
		if (settingsNotice) ctx.ui.notify(settingsNotice, "warning");
		if (loaded.diagnostics.length > 0) {
			ctx.ui.notify(formatSettingsDiagnostics(loaded), "warning");
		}
		runtime.thinkingLevel = pi.getThinkingLevel();
		installFooter(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		runtime.generationStartedAtMs = undefined;
		runtime.contextUsage = ctx.getContextUsage();
		runtime.compactionPending = false;
		runtime.usageSummary = summarizeFooterUsage(ctx.sessionManager.getEntries());
		runtime.tokenSpeed = undefined;
		installFooter(ctx);
		refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		sessionGeneration += 1;
		activeSessionManager = undefined;
		activeGitStatusTarget = undefined;
		clearGitStatusDebounce();
		pendingGitStatusRefresh = undefined;
		runtime.gitStatus = undefined;
		runtime.activeTools.clear();
		runtime.isStreaming = false;
		runtime.compactionPending = false;
		runtime.generationStartedAtMs = undefined;
		runtime.tokenSpeed = undefined;
		runtime.duplicateExtensions = [];
		runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
		ctx.ui.setFooter(undefined);
		ctx.ui.setStatus(STATUSLINE_KEY, undefined);
		runtime.requestRender = undefined;
	});

	pi.on("model_select", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.contextUsage = ctx.getContextUsage();
		runtime.compactionPending = false;
		refresh();
	});

	pi.on("thinking_level_select", (event) => {
		runtime.thinkingLevel = event.level;
		refresh();
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.contextUsage = ctx.getContextUsage();
		runtime.compactionPending = exceedsAutoCompactionThreshold(runtime.contextUsage);
		refresh();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.activeTools.clear();
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.isStreaming = false;
		runtime.compactionPending = false;
		runtime.activeTools.clear();
		refresh();
	});

	pi.on("message_start", (event, ctx) => {
		if (!ownsRuntime(ctx) || event.message.role !== "assistant") return;
		runtime.generationStartedAtMs = performance.now();
		runtime.tokenSpeed = undefined;
		refresh();
	});

	pi.on("message_end", (event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		if (event.message.role === "assistant") {
			addFooterUsage(runtime.usageSummary, event.message.usage, true);
			runtime.contextUsage = contextUsageFromAssistant(event.message, ctx);
			runtime.compactionPending = exceedsAutoCompactionThreshold(runtime.contextUsage);
			runtime.tokenSpeed = calculateTokenSpeed(
				event.message.usage.output,
				runtime.generationStartedAtMs,
				performance.now(),
			);
			runtime.generationStartedAtMs = undefined;
			refresh();
		} else if (event.message.role === "toolResult") {
			addFooterUsage(runtime.usageSummary, event.message.usage);
			refresh();
		}
	});

	pi.on("session_compact", (event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		addFooterUsage(runtime.usageSummary, event.compactionEntry.usage);
		runtime.contextUsage = ctx.getContextUsage();
		runtime.compactionPending = false;
		refresh();
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		runtime.turnCount += 1;
		runtime.isStreaming = true;
		refresh();
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		runtime.activeTools.set(event.toolName, currentCount + 1);
		refresh();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!ownsRuntime(ctx)) return;
		const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
		if (currentCount <= 1) runtime.activeTools.delete(event.toolName);
		else runtime.activeTools.set(event.toolName, currentCount - 1);

		scheduleGitStatusRefreshForContext(ctx);
		refresh();
	});
}

function formatSettingsDiagnostics(loaded: LoadedStatuslineSettings): string {
	const details = loaded.diagnostics.slice(0, 5).map((item) => item.message);
	const remaining = loaded.diagnostics.length - details.length;
	return [
		`pi-statusline settings: ${details.join("; ")}`,
		...(remaining > 0 ? [`+${remaining} more`] : []),
	].join(" ");
}
