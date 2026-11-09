import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@super-pi/coding-agent";
import { rm } from "node:fs/promises";
import { shutdownManagedBrowser } from "./browser-manager.ts";
import { state } from "./runtime.ts";
import { loadSettings } from "./settings.ts";
import {
	allChromeDevtoolsTools,
	applyChromeDevtoolsTools,
	buildCommandGuide,
	buildQuickstartMessage,
	buildToolStatusMessage,
	showToolSelector,
	updateChromeDevtoolsTools,
	waitForChromeDevtoolsSettings,
} from "./tool-selector.ts";
import {
	evaluateTool,
	listPagesTool,
	navigateTool,
	screenshotTool,
	selectPageTool,
} from "./tools.ts";

type CommandAction = "menu" | "help" | "quickstart" | "status" | "tools" | "enable" | "disable";
type CommandContext = ExtensionCommandContext;
const STATUS_KEY = "chrome-devtools";
const COMMAND_COMPLETIONS = [
	{ value: "help", label: "help", description: "Show command usage" },
	{ value: "quickstart", label: "quickstart", description: "Show endpoint and launch help" },
	{ value: "status", label: "status", description: "Show tool and settings status" },
	{ value: "tools", label: "tools", description: "Select Chrome DevTools tools" },
	{ value: "toggle", label: "toggle", description: "Select Chrome DevTools tools" },
	{ value: "enable", label: "enable", description: "Enable all Chrome DevTools tools" },
	{ value: "disable", label: "disable", description: "Disable all Chrome DevTools tools" },
];
const MENU_OPTIONS = {
	quickstart: "Quick start / endpoint help",
	help: "Command usage guide",
	status: "Show tool status",
	tools: "Select Chrome DevTools tools",
	enable: "Enable all Chrome DevTools tools",
	disable: "Disable all Chrome DevTools tools",
} as const;

export default function chromeDevtools(pi: ExtensionAPI) {
	const screenshots = new Set<string>();
	pi.registerTool(listPagesTool);
	pi.registerTool(selectPageTool);
	pi.registerTool(navigateTool);
	pi.registerTool(evaluateTool);
	pi.registerTool({
		...screenshotTool,
		async execute(id, params, signal, onUpdate, ctx) {
			const result = await screenshotTool.execute(id, params, signal, onUpdate, ctx);
			// Only this producer's generated temporary paths belong to this instance.
			if (result.details.isDefaultPath) screenshots.add(result.details.savedPath);
			return result;
		},
	});

	pi.registerCommand("chrome-devtools", {
		description: "Open Chrome DevTools help and tool controls",
		getArgumentCompletions: (prefix) => commandCompletions(prefix),
		handler: async (args, ctx) => {
			const generation = state.sessionGeneration;
			await handleChromeDevtoolsCommand(pi, args, ctx, generation);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++state.sessionGeneration;
		replaceSessionController("Chrome DevTools session replaced");
		state.shuttingDown = false;
		state.settingsNotice = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		// Action methods are unavailable during extension loading. Hide schemas
		// only after session_start initializes the runtime, before settings load.
		applyChromeDevtoolsTools(pi, [], { preservePlanModeSelection: true });
		const settings = await loadSettings();
		if (generation !== state.sessionGeneration) return;
		state.settingsNotice = settings.notice;
		if (settings.notice) ctx.ui.notify(settings.notice, "warning");
		if (settings.kind === "loaded") {
			applyChromeDevtoolsTools(pi, settings.settings.tools, {
				preservePlanModeSelection: true,
			});
			return;
		}
		if (settings.kind === "invalid") {
			ctx.ui.notify(`Chrome DevTools settings ignored: ${settings.reason}`, "warning");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try { await shutdownManagedBrowser(); }
		finally { await cleanupScreenshots(screenshots, ctx); }
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state.sessionGeneration += 1;
		replaceSessionController("Chrome DevTools session shut down");
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const browserShutdown = shutdownManagedBrowser(undefined, { cancelLaunch: true });
		try {
			await waitForChromeDevtoolsSettings();
			await browserShutdown;
		} finally { await cleanupScreenshots(screenshots, ctx); }
	});
}

async function cleanupScreenshots(screenshots: Set<string>, ctx: ExtensionContext): Promise<void> {
	for (const file of screenshots) {
		try {
			await rm(file, { force: true });
			screenshots.delete(file);
		} catch (error) {
			ctx.ui.notify(`Chrome screenshot cleanup failed: ${file}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}
}

async function handleChromeDevtoolsCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: CommandContext,
	generation: number,
) {
	const command = parseCommand(args);
	switch (command) {
		case "menu":
			await showMenu(pi, ctx, generation);
			return;
		case "help":
			ctx.ui.notify(buildCommandGuide(), "info");
			return;
		case "quickstart":
			ctx.ui.notify(buildQuickstartMessage(), "info");
			return;
		case "status": {
			const status = await buildToolStatusMessage(pi);
			if (generation !== state.sessionGeneration) return;
			ctx.ui.notify(status, "info");
			return;
		}
		case "tools":
			await showToolSelector(pi, ctx);
			return;
		case "enable":
			await updateChromeDevtoolsTools(pi, ctx, allChromeDevtoolsTools(), "enabled all", true);
			return;
		case "disable":
			await updateChromeDevtoolsTools(pi, ctx, [], "disabled all");
			return;
	}

	ctx.ui.notify(
		`Unknown /chrome-devtools command: ${args.trim()}

${buildCommandGuide()}`,
		"warning",
	);
}

async function showMenu(pi: ExtensionAPI, ctx: CommandContext, generation: number) {
	if (!ctx.hasUI) {
		const status = await buildToolStatusMessage(pi);
		if (generation !== state.sessionGeneration) return;
		ctx.ui.notify(`${buildCommandGuide()}\n\n${status}`, "info");
		return;
	}
	const menuSignal = state.sessionController.signal;
	const isCurrent = () => generation === state.sessionGeneration && !menuSignal.aborted;
	const { defineMenu, runMenu } = await import("@super-pi/tui-kit");
	if (!isCurrent()) return;

	type Screen = "main";
	type Action = keyof typeof MENU_OPTIONS;
	const menu = defineMenu<undefined, Screen, Action>({
		start: "main",
		screens: {
			main: () => ({
				kind: "actions",
				title: "Chrome DevTools",
				items: Object.entries(MENU_OPTIONS).map(([id, label]) => ({
					id,
					label,
					action: id as Action,
				})),
				hint: "close",
			}),
		},
		actions: {
			quickstart: async () => {
				ctx.ui.notify(buildQuickstartMessage(), "info");
				return { kind: "close" };
			},
			help: async () => {
				ctx.ui.notify(buildCommandGuide(), "info");
				return { kind: "close" };
			},
			status: async () => {
				const status = await buildToolStatusMessage(pi);
				if (generation === state.sessionGeneration) ctx.ui.notify(status, "info");
				return { kind: "close" };
			},
			tools: async () => {
				await showToolSelector(pi, ctx);
				return { kind: "close" };
			},
			enable: async () => {
				await updateChromeDevtoolsTools(pi, ctx, allChromeDevtoolsTools(), "enabled all", true);
				return { kind: "close" };
			},
			disable: async () => {
				await updateChromeDevtoolsTools(pi, ctx, [], "disabled all");
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: menuSignal,
		isCurrent,
	});
}

function replaceSessionController(reason: string) {
	state.sessionController.abort(new DOMException(reason, "AbortError"));
	state.sessionController = new AbortController();
}

export function parseCommand(args: string): CommandAction | "unknown" {
	const command = args.trim().toLowerCase();
	if (!command) return "menu";
	if (command === "help") return "help";
	if (command === "quickstart") return "quickstart";
	if (command === "status") return "status";
	if (command === "tools" || command === "select" || command === "toggle") return "tools";
	if (command === "enable" || command === "on") return "enable";
	if (command === "disable" || command === "off") return "disable";
	return "unknown";
}

export function commandCompletions(prefix: string) {
	const normalized = prefix.trimStart().toLowerCase();
	if (/\s/.test(normalized)) return null;

	const matches = COMMAND_COMPLETIONS.filter((completion) =>
		completion.value.startsWith(normalized),
	);
	return matches.length > 0 ? matches : null;
}

export {
	formatHostForUrl,
	isLocalDevToolsHost,
	quoteCommandPart,
} from "./browser-manager.ts";
export { parseConfiguredPort } from "./runtime.ts";
export {
	hasParentPathSegment,
	isPathInsideRoot,
	resolveScreenshotPath,
	selectAllowedRoot,
} from "./screenshot.ts";
export { normalizeChromeDevtoolsSettings } from "./settings.ts";
export { orderedChromeDevtoolsTools } from "./tool-selector.ts";
