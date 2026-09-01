import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RELEASE_COMPONENT_RENDER_CACHE as TOOL_RELEASE_COMPONENT_RENDER_CACHE } from "@super-pi/tui";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../packages/tui/src/component-cache.ts";
import { CancellableLoader } from "../packages/tui/src/components/cancellable-loader.ts";
import type { TUI } from "../packages/tui/src/tui.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { BashExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { LoginDialogComponent } from "../packages/coding-agent/src/modes/interactive/components/login-dialog.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

type CountingTui = TUI & {
	requestRenderCalls: number;
	setFocusCalls: number;
};

function createCountingTui(): CountingTui {
	return {
		requestRenderCalls: 0,
		setFocusCalls: 0,
		requestRender(): void {
			(this as CountingTui).requestRenderCalls++;
		},
		setFocus(): void {
			(this as CountingTui).setFocusCalls++;
		},
	} as unknown as CountingTui;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.fail("timed out waiting for async owner fixture");
}

test("cache-only release aborts cancellable loader work and releases its callback", () => {
	const tui = createCountingTui();
	const loader = new CancellableLoader(tui, String, String, "pending");
	let abortCalls = 0;
	loader.onAbort = () => {
		abortCalls++;
	};

	loader[RELEASE_COMPONENT_RENDER_CACHE]();

	assert.equal(loader.signal.aborted, true);
	assert.equal(abortCalls, 1);
	assert.equal(loader.onAbort, undefined);
	loader[RELEASE_COMPONENT_RENDER_CACHE]();
	assert.equal(abortCalls, 1);
});

test("interactive stop cancels the active provider login and settles a manual prompt", async () => {
	initTheme("dark");
	const tui = createCountingTui();
	let completionCalls = 0;
	const dialog = new LoginDialogComponent(tui, "fixture", () => {
		completionCalls++;
	});
	const prompt = dialog.showManualInput("token");
	const observedPrompt = prompt.then(
		() => undefined,
		(error: unknown) => error,
	);

	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.runtimeHost = {
		session: {
			settingsManager: {
				getFullscreenExitOutput: () => "transcript",
				getShowTerminalProgress: () => false,
			},
		},
	};
	mode.ui = tui;
	mode.tuiLifecycleGeneration = 0;
	mode.activeLoginDialog = dialog;
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};

	await mode.stop();

	assert.equal(dialog.signal.aborted, true);
	assert.equal(mode.activeLoginDialog, undefined);
	assert.match(String(await observedPrompt), /Login cancelled/);
	assert.equal(completionCalls, 1);
	await mode.stop();
	assert.equal(completionCalls, 1);
});

test("provider completion and notifications are inert after final login cancellation", async () => {
	initTheme("dark");
	const tui = createCountingTui();
	let settleLogin: (() => void) | undefined;
	let loginOptions: any;
	let completeAuthenticationCalls = 0;
	let errorCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.runtimeHost = {
		session: {
			model: undefined,
			modelRuntime: {
				login(_providerId: string, _method: string, options: any): Promise<void> {
					loginOptions = options;
					return new Promise<void>((resolve) => {
						settleLogin = resolve;
					});
				},
			},
			settingsManager: {
				getFullscreenExitOutput: () => "transcript",
				getShowTerminalProgress: () => false,
			},
		},
	};
	mode.ui = tui;
	mode.tuiLifecycleGeneration = 0;
	mode.editor = {};
	mode.editorContainer = {
		children: [] as unknown[],
		clear(): void {
			this.children.length = 0;
		},
		addChild(component: unknown): void {
			this.children.push(component);
		},
	};
	mode.completeProviderAuthentication = async (): Promise<void> => {
		completeAuthenticationCalls++;
	};
	mode.showError = (): void => {
		errorCalls++;
	};
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};

	const operation = mode.showLoginDialog("fixture", "Fixture");
	await Promise.resolve();
	assert.ok(mode.activeLoginDialog);
	assert.equal(loginOptions.signal.aborted, false);
	await mode.stop();
	assert.equal(loginOptions.signal.aborted, true);
	const requestRenderCalls = tui.requestRenderCalls;
	const setFocusCalls = tui.setFocusCalls;

	loginOptions.notify({ type: "progress", message: "late" });
	await assert.rejects(
		loginOptions.prompt({ type: "manual_code", message: "late", signal: loginOptions.signal }),
		/Login cancelled/,
	);
	settleLogin?.();
	await operation;

	assert.equal(tui.requestRenderCalls, requestRenderCalls);
	assert.equal(tui.setFocusCalls, setFocusCalls);
	assert.equal(completeAuthenticationCalls, 0);
	assert.equal(errorCalls, 0);
	assert.equal(mode.activeLoginDialog, undefined);
});

test("released edit preview rejects late completion and can rebuild under a new owner", async () => {
	initTheme("dark");
	const directory = await mkdtemp(path.join(os.tmpdir(), "super-pi-edit-preview-owner-"));
	try {
		const filePath = path.join(directory, "fixture.txt");
		await writeFile(filePath, "before\n", "utf8");
		const tui = createCountingTui();
		let visualInvalidations = 0;
		const component = new ToolExecutionComponent(
			"edit",
			"edit-preview-owner",
			{
				path: filePath,
				edits: [{ oldText: "before", newText: "after" }],
			},
			{
				onVisualInvalidate: () => {
					visualInvalidations++;
				},
			},
			undefined,
			tui,
			directory,
		);
		component.setArgsComplete();
		const state = (component as any).rendererState;
		const callComponent = state.callComponent;
		assert.equal(callComponent.previewPending, true);
		const requestRenderCalls = tui.requestRenderCalls;

		component[TOOL_RELEASE_COMPONENT_RENDER_CACHE]();
		assert.equal(callComponent.previewPending, false);
		assert.equal(callComponent.previewArgsKey, undefined);
		assert.equal(callComponent.preview, undefined);
		await waitFor(() => state.previewTasksDropped === 1);
		assert.equal(callComponent.preview, undefined);
		assert.equal(state.previewTasksScheduled, 1);
		assert.equal(state.previewTasksAccepted ?? 0, 0);
		assert.equal(visualInvalidations, 0);
		assert.equal(tui.requestRenderCalls, requestRenderCalls);

		component.invalidate();
		await waitFor(() => callComponent.preview !== undefined);
		assert.equal(callComponent.previewPending, false);
		assert.equal(state.previewTasksScheduled, 2);
		assert.equal(state.previewTasksAccepted, 1);
		assert.equal(state.previewTasksDropped, 1);
		assert.equal(visualInvalidations, 1);
		assert.ok(component.render(100).length > 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("async owner closeout remains lifecycle-only in source", () => {
	const loaderSource = readFileSync("packages/tui/src/components/cancellable-loader.ts", "utf8");
	const loaderRelease = loaderSource.match(
		/override \[RELEASE_COMPONENT_RENDER_CACHE\]\(\): void \{[\s\S]*?\n\t\}/,
	)?.[0] ?? "";
	assert.match(loaderRelease, /this\.cancel\(\)/);
	assert.match(loaderRelease, /super\[RELEASE_COMPONENT_RENDER_CACHE\]\(\)/);
	assert.doesNotMatch(loaderRelease, /new (?:Map|Set|Promise|AbortController)|=>|function\s*\(/);

	const interactiveSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		"utf8",
	);
	const stopSource = interactiveSource.match(/async stop\(fullscreenExitOutput[\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.ok(stopSource.indexOf("this.cancelActiveLoginDialog()") < stopSource.indexOf("this.stopInteractiveTui"));
	const notifySource = interactiveSource.match(
		/private notifyAuthDialog[\s\S]*?\n\t\}/,
	)?.[0] ?? "";
	assert.match(notifySource, /if \(this\.activeLoginDialog !== dialog\) return/);
	assert.match(interactiveSource, /loaderLifecycleGeneration !== this\.tuiLifecycleGeneration/);

	const toolSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/components/tool-execution.ts",
		"utf8",
	);
	const toolRelease = toolSource.match(
		/\[RELEASE_COMPONENT_RENDER_CACHE\]\(\): void \{[\s\S]*?\n\t\}/,
	)?.[0] ?? "";
	assert.match(toolRelease, /this\.renderLifecycleGeneration\+\+/);
	assert.match(toolRelease, /RELEASE_TOOL_RENDER_DERIVED_STATE/);
	const editSource = readFileSync("packages/coding-agent/src/core/tools/edit.ts", "utf8");
	assert.match(editSource, /TOOL_RENDER_LIFECYCLE_GENERATION\] !== requestGeneration/);
	assert.ok(
		editSource.indexOf("TOOL_RENDER_LIFECYCLE_GENERATION] !== requestGeneration") <
			editSource.indexOf("setEditPreview(component, preview, requestKey)"),
	);

	const bashSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/components/bash-execution.ts",
		"utf8",
	);
	assert.match(bashSource, /class BashPreviewComponent implements Component/);
	assert.match(bashSource, /this\.previewComponent\?\.\[RELEASE_COMPONENT_RENDER_CACHE\]\(\)/);
	assert.match(bashSource, /this\.loader\[RELEASE_COMPONENT_RENDER_CACHE\]\(\)/);
	assert.doesNotMatch(bashSource, /render:\s*\(width: number\)\s*=>/);

	const extensionReleaseStart = interactiveSource.indexOf("private releaseExtensionUiOwners(): void");
	const extensionReleaseEnd = interactiveSource.indexOf("\n\t/**", extensionReleaseStart);
	const extensionReleaseSource = interactiveSource.slice(extensionReleaseStart, extensionReleaseEnd);
	assert.match(extensionReleaseSource, /widget\.dispose\?\.\(\)/);
	assert.match(extensionReleaseSource, /this\.customFooter\?\.dispose\?\.\(\)/);
	assert.match(extensionReleaseSource, /this\.customHeader\?\.dispose\?\.\(\)/);
	assert.doesNotMatch(extensionReleaseSource, /requestRender|renderWidgets|new (?:Map|Set|Promise|AbortController)/);
	assert.ok(stopSource.indexOf("this.cancelActiveModelLookup()") < stopSource.indexOf("this.stopInteractiveTui"));
	assert.ok(stopSource.indexOf("this.releaseExtensionUiOwners()") < stopSource.indexOf("this.stopInteractiveTui"));
	assert.match(
		interactiveSource,
		/setTimeout\(InteractiveMode\.handleModelLookupTimeout, 15_000, this, controller, generation\)/,
	);
	const modelLookupStart = interactiveSource.indexOf("private async findExactModelMatch");
	const modelLookupEnd = interactiveSource.indexOf("\n\t/**", modelLookupStart);
	const modelLookupSource = interactiveSource.slice(modelLookupStart, modelLookupEnd);
	assert.doesNotMatch(modelLookupSource, /setTimeout\(\(\)|\.then\(|\.catch\(|Promise\.all/);
});

test("final release drops BashExecution preview and private Loader ownership", () => {
	initTheme("dark");
	const tui = createCountingTui();
	const bash = new BashExecutionComponent("fixture", tui);
	bash.appendOutput("x".repeat(64 * 1024));
	bash.setComplete(0, false);
	bash.render(80);
	const internals = bash as any;
	const preview = internals.contentContainer.children[1];
	const firstLines = preview.render(80);
	assert.ok(firstLines.length > 0);
	assert.equal(internals.loader.ui, tui);

	bash[TOOL_RELEASE_COMPONENT_RENDER_CACHE]();

	const afterReleaseLines = preview.render(80);
	assert.notEqual(afterReleaseLines, firstLines);
	assert.equal((preview as any).styledInput, undefined);
	assert.equal((preview as any).cachedLines, undefined);
	assert.equal(internals.loader.ui, null);
	assert.equal(internals.contentContainer.children.length, 0);
	assert.equal(bash.getOutput(), "x".repeat(64 * 1024));
	const candidateLines = bash.render(80);
	const reference = new BashExecutionComponent("fixture", createCountingTui());
	reference.appendOutput("x".repeat(64 * 1024));
	reference.setComplete(0, false);
	assert.deepEqual(candidateLines, reference.render(80));
	reference[TOOL_RELEASE_COMPONENT_RENDER_CACHE]();
});

test("interactive stop disposes extension widgets header and footer exactly once", async () => {
	const tui = createCountingTui();
	const calls = { above: 0, below: 0, footer: 0, header: 0 };
	const above = { render: () => [], dispose: () => { calls.above++; } };
	const below = { render: () => [], dispose: () => { calls.below++; } };
	const footer = { render: () => [], dispose: () => { calls.footer++; } };
	const header = { render: () => [], dispose: () => { calls.header++; } };
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.runtimeHost = {
		session: {
			settingsManager: {
				getFullscreenExitOutput: () => "transcript",
				getShowTerminalProgress: () => false,
			},
		},
	};
	mode.ui = tui;
	mode.tuiLifecycleGeneration = 0;
	mode.extensionWidgetsAbove = new Map([["above", above]]);
	mode.extensionWidgetsBelow = new Map([["below", below]]);
	mode.customFooter = footer;
	mode.customHeader = header;
	mode.widgetContainerAbove = { clear(): void {} };
	mode.widgetContainerBelow = { clear(): void {} };
	mode.footerContainer = { clear(): void {} };
	mode.headerContainer = { children: [header], clear(): void { this.children.length = 0; } };
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};

	await mode.stop();

	assert.deepEqual(calls, { above: 1, below: 1, footer: 1, header: 1 });
	assert.equal(mode.extensionWidgetsAbove.size, 0);
	assert.equal(mode.extensionWidgetsBelow.size, 0);
	assert.equal(mode.customFooter, undefined);
	assert.equal(mode.customHeader, undefined);
	await mode.stop();
	assert.deepEqual(calls, { above: 1, below: 1, footer: 1, header: 1 });
});

test("interactive stop isolates extension disposal errors and releases later owners", async () => {
	const firstError = new Error("first extension dispose failed");
	let laterWidgetCalls = 0;
	let footerCalls = 0;
	let headerCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.runtimeHost = {
		session: {
			settingsManager: {
				getFullscreenExitOutput: () => "transcript",
				getShowTerminalProgress: () => false,
			},
		},
	};
	mode.ui = createCountingTui();
	mode.tuiLifecycleGeneration = 0;
	mode.extensionWidgetsAbove = new Map([
		["first", { dispose(): void { throw firstError; } }],
		["later", { dispose(): void { laterWidgetCalls++; } }],
	]);
	mode.extensionWidgetsBelow = new Map();
	mode.customFooter = { dispose(): void { footerCalls++; } };
	mode.customHeader = { dispose(): void { headerCalls++; } };
	mode.widgetContainerAbove = { clear(): void {} };
	mode.widgetContainerBelow = { clear(): void {} };
	mode.footerContainer = { clear(): void {} };
	mode.headerContainer = { clear(): void {} };
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};

	await assert.rejects(mode.stop(), firstError);
	assert.equal(laterWidgetCalls, 1);
	assert.equal(footerCalls, 1);
	assert.equal(headerCalls, 1);
	assert.equal(mode.extensionWidgetsAbove.size, 0);
	assert.equal(mode.customFooter, undefined);
	assert.equal(mode.customHeader, undefined);
	await mode.stop();
	assert.equal(laterWidgetCalls, 1);
	assert.equal(footerCalls, 1);
	assert.equal(headerCalls, 1);
});

test("interactive stop aborts model lookup and rejects its late catalog result", async () => {
	const tui = createCountingTui();
	let refreshSignal: AbortSignal | undefined;
	let settleRefresh: ((value: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
	let availableModels: any[] = [];
	let setModelCalls = 0;
	let selectorCalls = 0;
	let warningCalls = 0;
	const modelRuntime = {
		getAvailableSnapshot: () => availableModels,
		refresh(options: { signal: AbortSignal }): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
			refreshSignal = options.signal;
			return new Promise((resolve) => {
				settleRefresh = resolve;
			});
		},
	};
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.runtimeHost = {
		session: {
			modelRuntime,
			scopedModels: [],
			setModel: async (): Promise<void> => {
				setModelCalls++;
			},
			settingsManager: {
				getFullscreenExitOutput: () => "transcript",
				getShowTerminalProgress: () => false,
			},
		},
	};
	mode.ui = tui;
	mode.tuiLifecycleGeneration = 0;
	mode.extensionWidgetsAbove = new Map();
	mode.extensionWidgetsBelow = new Map();
	mode.widgetContainerAbove = { clear(): void {} };
	mode.widgetContainerBelow = { clear(): void {} };
	mode.footerContainer = { clear(): void {} };
	mode.headerContainer = { clear(): void {} };
	mode.showStatus = (): void => {};
	mode.showWarning = (): void => { warningCalls++; };
	mode.showModelSelector = (): void => { selectorCalls++; };
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};

	const command = mode.handleModelCommand("target");
	await Promise.resolve();
	assert.equal(refreshSignal?.aborted, false);
	await mode.stop();
	await Promise.resolve();
	assert.equal(refreshSignal?.aborted, true);
	availableModels = [{ provider: "fixture", id: "target" }];
	settleRefresh?.({ aborted: false, errors: new Map() });
	await command;

	assert.equal(setModelCalls, 0);
	assert.equal(selectorCalls, 0);
	assert.equal(warningCalls, 0);
	assert.equal(mode.activeModelLookupController, undefined);
});
