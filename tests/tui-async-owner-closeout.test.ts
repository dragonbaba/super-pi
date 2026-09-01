import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RELEASE_COMPONENT_RENDER_CACHE as TOOL_RELEASE_COMPONENT_RENDER_CACHE } from "@super-pi/tui";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../packages/tui/src/component-cache.ts";
import { CancellableLoader } from "../packages/tui/src/components/cancellable-loader.ts";
import type { TUI } from "../packages/tui/src/tui.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { AgentSessionRuntime } from "../packages/coding-agent/src/core/agent-session-runtime.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { BashExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { LoginDialogComponent } from "../packages/coding-agent/src/modes/interactive/components/login-dialog.ts";
import { SessionSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/session-selector.ts";
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
	assert.ok(
		stopSource.indexOf("this.cancelActiveProviderAuthentication()") < stopSource.indexOf("this.stopInteractiveTui"),
	);
	assert.ok(stopSource.indexOf("this.cancelActiveExtensionCustom()") < stopSource.indexOf("this.stopInteractiveTui"));
	assert.ok(stopSource.indexOf("this.releaseExtensionUiOwners()") < stopSource.indexOf("this.stopInteractiveTui"));
	assert.match(stopSource, /finally \{\s*this\.isInitialized = false/);
	assert.ok(stopSource.indexOf("this.unregisterSignalHandlers()") < stopSource.indexOf("if (cleanupFailed) throw cleanupError"));
	assert.match(
		interactiveSource,
		/setTimeout\(InteractiveMode\.handleModelLookupTimeout, 15_000, this, controller, generation\)/,
	);
	assert.match(interactiveSource, /private activeModelLookupTimeout: ReturnType<typeof setTimeout>/);
	const cancelModelLookup = interactiveSource.match(/private cancelActiveModelLookup\(\): void \{[\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.match(cancelModelLookup, /this\.activeModelLookupTimeout = undefined/);
	assert.match(cancelModelLookup, /clearTimeout\(timeout\)/);
	const shellSource = readFileSync("packages/coding-agent/src/core/tools/bash.ts", "utf8");
	assert.match(shellSource, /RELEASE_TOOL_RENDER_DERIVED_STATE\] = releaseBashRenderDerivedState/);
	assert.match(shellSource, /TOOL_RENDER_LIFECYCLE_GENERATION\] !== intervalGeneration/);
	assert.match(interactiveSource, /private static handleProviderAuthenticationTimeout/);
	const providerRefreshStart = interactiveSource.indexOf("private async refreshProviderAuthenticationCatalog");
	const providerCompletionStart = interactiveSource.indexOf("private async completeProviderAuthentication");
	const providerCompletionEnd = interactiveSource.indexOf("\n\tprivate showAmbientAuthDialog", providerCompletionStart);
	const providerRefreshSource = interactiveSource.slice(providerRefreshStart, providerCompletionStart);
	const providerCompletionSource = interactiveSource.slice(providerCompletionStart, providerCompletionEnd);
	assert.match(providerCompletionSource, /const lifecycleGeneration = this\.tuiLifecycleGeneration/);
	assert.match(providerCompletionSource, /this\.providerAuthenticationGeneration !== generation/);
	assert.match(providerCompletionSource, /this\.refreshProviderAuthenticationCatalog/);
	assert.match(providerRefreshSource, /this\.activeProviderAuthenticationController !== controller/);
	assert.match(providerRefreshSource, /InteractiveMode\.handleProviderAuthenticationTimeout/);
	assert.doesNotMatch(providerRefreshSource, /\.then\(|\.catch\(|\.finally\(|setTimeout\(\(\)/);
	const modelLookupStart = interactiveSource.indexOf("private async findExactModelMatch");
	const modelLookupEnd = interactiveSource.indexOf("\n\t/**", modelLookupStart);
	const modelLookupSource = interactiveSource.slice(modelLookupStart, modelLookupEnd);
	assert.doesNotMatch(modelLookupSource, /setTimeout\(\(\)|\.then\(|\.catch\(|Promise\.all/);
	const modelCommandStart = interactiveSource.indexOf("private async handleModelCommand");
	const modelCommandSource = interactiveSource.slice(modelCommandStart, modelLookupStart);
	assert.match(modelCommandSource, /const commandGeneration = \+\+this\.modelCommandGeneration/);
	assert.ok(modelCommandSource.indexOf("this.cancelActiveModelLookup()") < modelCommandSource.indexOf("if (!searchTerm)"));
	assert.ok(
		modelCommandSource.indexOf("this.cancelActiveModelLookup()") <
			modelCommandSource.indexOf("await this.findExactModelMatch(searchTerm)"),
	);
	assert.match(modelCommandSource, /this\.modelCommandGeneration !== commandGeneration/);
	const extensionCustomStart = interactiveSource.indexOf("private async showExtensionCustom");
	const extensionCustomEnd = interactiveSource.indexOf("\n\t/**", extensionCustomStart);
	const extensionCustomSource = interactiveSource.slice(extensionCustomStart, extensionCustomEnd);
	assert.match(extensionCustomSource, /this\.activeExtensionCustomCancel = cancel/);
	assert.match(extensionCustomSource, /this\.tuiLifecycleGeneration !== lifecycleGeneration/);
	assert.match(extensionCustomSource, /c\.dispose\?\.\(\)/);
	assert.match(extensionCustomSource, /let overlayHandle: OverlayHandle \| undefined/);
	assert.match(extensionCustomSource, /overlayHandle\?\.hide\(\)/);
	assert.doesNotMatch(extensionCustomSource, /this\.ui\.hideOverlay\(\)/);
	const cancelLoginStart = interactiveSource.indexOf("private cancelActiveLoginDialog");
	const cancelLoginEnd = interactiveSource.indexOf("\n\tprivate cancelActiveProviderAuthentication", cancelLoginStart);
	const cancelLoginSource = interactiveSource.slice(cancelLoginStart, cancelLoginEnd);
	assert.ok(cancelLoginSource.indexOf("this.activeLoginDialog = undefined") < cancelLoginSource.indexOf("this.cancelActiveAuthSelector()"));
	assert.ok(cancelLoginSource.indexOf("this.cancelActiveAuthSelector()") < cancelLoginSource.indexOf("dialog?.cancel()"));
	const externalEditorStart = interactiveSource.indexOf("private async handleOpenExternalEditor");
	const externalEditorEnd = interactiveSource.indexOf("\n\tprivate runExternalEditor", externalEditorStart);
	const externalEditorSource = interactiveSource.slice(externalEditorStart, externalEditorEnd);
	assert.match(externalEditorSource, /const lifecycleGeneration = this\.tuiLifecycleGeneration/);
	assert.match(externalEditorSource, /lifecycleGeneration !== this\.tuiLifecycleGeneration/);
	const modelSelectorStart = interactiveSource.indexOf("private showModelSelector");
	const modelSelectorEnd = interactiveSource.indexOf("\n\tprivate showModelsSelector", modelSelectorStart);
	const modelSelectorSource = interactiveSource.slice(modelSelectorStart, modelSelectorEnd);
	assert.match(modelSelectorSource, /const lifecycleGeneration = this\.tuiLifecycleGeneration/);
	assert.match(modelSelectorSource, /lifecycleGeneration !== this\.tuiLifecycleGeneration/);
	const shareStart = interactiveSource.indexOf("private async handleShareCommand");
	const shareEnd = interactiveSource.indexOf("\n\tprivate async handleCopyCommand", shareStart);
	const shareSource = interactiveSource.slice(shareStart, shareEnd);
	assert.ok(
		shareSource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") <
			shareSource.indexOf("await this.session.exportToHtml(tmpFile)"),
	);
	assert.ok(
		shareSource.indexOf("lifecycleGeneration !== this.tuiLifecycleGeneration") >
			shareSource.indexOf("await this.session.exportToHtml(tmpFile)"),
	);
	const copyStart = interactiveSource.indexOf("private async handleCopyCommand");
	const copyEnd = interactiveSource.indexOf("\n\tprivate handleNameCommand", copyStart);
	const copySource = interactiveSource.slice(copyStart, copyEnd);
	assert.ok(copySource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") < copySource.indexOf("await this.copyTextToClipboard(text)"));
	assert.equal(copySource.match(/this\.tuiLifecycleGeneration !== lifecycleGeneration/g)?.length, 2);
	assert.ok(copySource.indexOf("this.tuiLifecycleGeneration !== lifecycleGeneration") < copySource.indexOf("this.renderer.flash"));
	assert.ok(copySource.lastIndexOf("this.tuiLifecycleGeneration !== lifecycleGeneration") < copySource.lastIndexOf("this.showError"));
	const startupRefreshStart = interactiveSource.indexOf("private startStartupModelRefresh");
	const startupRefreshEnd = interactiveSource.indexOf("\n\tprivate cancelActiveModelLookup", startupRefreshStart);
	const startupRefreshSource = interactiveSource.slice(startupRefreshStart, startupRefreshEnd);
	assert.match(startupRefreshSource, /InteractiveMode\.handleStartupModelRefreshTimeout/);
	assert.doesNotMatch(startupRefreshSource, /setTimeout\(\(\)|\.then\(|\.catch\(|\.finally\(/);
	assert.ok(stopSource.indexOf("this.cancelActiveStartupModelRefresh()") < stopSource.indexOf("this.stopInteractiveTui"));
	assert.ok(stopSource.indexOf("this.cancelActiveStartupDiagnostics()") < stopSource.indexOf("this.stopInteractiveTui"));
	assert.ok(stopSource.indexOf("this.cancelActiveSuspend()") < stopSource.indexOf("this.stopInteractiveTui"));
	assert.ok(stopSource.indexOf("this.runtimeHost.cancelPendingReplacements?.()") < stopSource.indexOf("this.stopInteractiveTui"));
	const startupDiagnosticsStart = interactiveSource.indexOf("private startStartupDiagnostics");
	const startupDiagnosticsEnd = interactiveSource.indexOf("\n\t/**", startupDiagnosticsStart);
	const startupDiagnosticsSource = interactiveSource.slice(startupDiagnosticsStart, startupDiagnosticsEnd);
	assert.match(startupDiagnosticsSource, /this\.startupDiagnosticsGeneration !== generation/);
	assert.match(startupDiagnosticsSource, /this\.tuiLifecycleGeneration !== lifecycleGeneration/);
	assert.match(interactiveSource, /private cancelActiveStartupDiagnostics\(\): void/);
	assert.match(interactiveSource, /firstProcess\?\.kill\(\)/);
	assert.match(interactiveSource, /secondProcess\?\.kill\(\)/);
	const cycleModelStart = interactiveSource.indexOf("private async cycleModel");
	const cycleModelEnd = interactiveSource.indexOf("\n\tprivate toggleToolOutputExpansion", cycleModelStart);
	const cycleModelSource = interactiveSource.slice(cycleModelStart, cycleModelEnd);
	assert.ok(cycleModelSource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") < cycleModelSource.indexOf("await this.session.cycleModel(direction)"));
	assert.equal(cycleModelSource.match(/this\.tuiLifecycleGeneration !== lifecycleGeneration/g)?.length, 2);
	const treeStart = interactiveSource.indexOf("private showTreeSelector");
	const treeEnd = interactiveSource.indexOf("\n\tprivate showSessionSelector", treeStart);
	const treeSource = interactiveSource.slice(treeStart, treeEnd);
	assert.ok(treeSource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") < treeSource.indexOf("await this.session.navigateTree"));
	assert.ok(treeSource.indexOf("this.tuiLifecycleGeneration !== lifecycleGeneration", treeSource.indexOf("await this.session.navigateTree")) > 0);
	const reloadStart = interactiveSource.indexOf("private async handleReloadCommand");
	const reloadEnd = interactiveSource.indexOf("\n\tprivate async handleExportCommand", reloadStart);
	const reloadSource = interactiveSource.slice(reloadStart, reloadEnd);
	assert.ok(reloadSource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") < reloadSource.indexOf("await this.session.reload"));
	assert.match(reloadSource, /const restoreChatBeforeSessionStart = \(\) => \{\s*if \(this\.tuiLifecycleGeneration !== lifecycleGeneration\) return/);
	assert.ok(reloadSource.indexOf("this.tuiLifecycleGeneration !== lifecycleGeneration", reloadSource.indexOf("await this.session.reload")) > 0);
	assert.doesNotMatch(`${cycleModelSource}\n${treeSource}\n${reloadSource}`, /Promise\.all|new AbortController|\.then\(|\.catch\(|\.finally\(/);
	const exportStart = interactiveSource.indexOf("private async handleExportCommand");
	const exportEnd = interactiveSource.indexOf("\n\tprivate getPathCommandArgument", exportStart);
	const exportSource = interactiveSource.slice(exportStart, exportEnd);
	assert.ok(exportSource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") < exportSource.indexOf("await this.session.exportToHtml"));
	assert.equal(exportSource.match(/this\.tuiLifecycleGeneration !== lifecycleGeneration/g)?.length, 3);
	const followUpStart = interactiveSource.indexOf("private async handleFollowUp");
	const followUpEnd = interactiveSource.indexOf("\n\tprivate handleDequeue", followUpStart);
	const followUpSource = interactiveSource.slice(followUpStart, followUpEnd);
	assert.ok(
		followUpSource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") <
			followUpSource.indexOf('await this.session.prompt(text, { streamingBehavior: "followUp" })'),
	);
	assert.equal(followUpSource.match(/this\.tuiLifecycleGeneration !== lifecycleGeneration/g)?.length, 2);
	const suspendStart = interactiveSource.indexOf("private async handleCtrlZ");
	const suspendEnd = interactiveSource.indexOf("\n\tprivate suspendProcessGroup", suspendStart);
	const suspendSource = interactiveSource.slice(suspendStart, suspendEnd);
	assert.match(suspendSource, /process\.once\("SIGCONT", this\.handleSuspendContinue\)/);
	assert.match(suspendSource, /this\.activeSuspendGeneration !== generation/);
	assert.doesNotMatch(suspendSource, /setInterval\(\(\)|process\.once\("SIGCONT", \(\)/);
	const logoutStart = interactiveSource.indexOf("private async showOAuthSelector");
	const logoutEnd = interactiveSource.indexOf("\n\tprivate async refreshProviderAuthenticationCatalog", logoutStart);
	const logoutSource = interactiveSource.slice(logoutStart, logoutEnd);
	assert.ok(logoutSource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") < logoutSource.indexOf("await this.getLogoutProviderOptions"));
	assert.ok(logoutSource.indexOf("this.tuiLifecycleGeneration !== lifecycleGeneration", logoutSource.indexOf("await this.session.modelRuntime.logout")) > 0);
	assert.ok(logoutSource.indexOf("this.tuiLifecycleGeneration !== lifecycleGeneration", logoutSource.indexOf("await this.updateAvailableProviderCount")) > 0);
	const bashCommandStart = interactiveSource.indexOf("private async handleBashCommand");
	const bashCommandEnd = interactiveSource.indexOf("\n\tprivate async handleCompactCommand", bashCommandStart);
	const bashCommandSource = interactiveSource.slice(bashCommandStart, bashCommandEnd);
	assert.ok(
		bashCommandSource.indexOf("const lifecycleGeneration = this.tuiLifecycleGeneration") <
			bashCommandSource.indexOf("await extensionRunner.emitUserBash"),
	);
	assert.ok(
		bashCommandSource.indexOf("this.tuiLifecycleGeneration !== lifecycleGeneration") >
			bashCommandSource.indexOf("await extensionRunner.emitUserBash"),
	);
	assert.ok(
		bashCommandSource.indexOf("this.tuiLifecycleGeneration !== lifecycleGeneration") <
			bashCommandSource.indexOf("new BashExecutionComponent"),
	);
	const executeBashIndex = bashCommandSource.indexOf("await this.session.executeBash");
	assert.ok(bashCommandSource.indexOf("this.tuiLifecycleGeneration === lifecycleGeneration", executeBashIndex) > executeBashIndex);
	assert.ok(bashCommandSource.indexOf("this.bashComponent === bashComponent", executeBashIndex) > executeBashIndex);
	assert.ok(
		bashCommandSource.indexOf("this.tuiLifecycleGeneration !== lifecycleGeneration", executeBashIndex) > executeBashIndex,
	);
	const shutdownStart = interactiveSource.indexOf("private async shutdown");
	const shutdownEnd = interactiveSource.indexOf("\n\tprivate emergencyTerminalExit", shutdownStart);
	const shutdownSource = interactiveSource.slice(shutdownStart, shutdownEnd);
	assert.ok(shutdownSource.lastIndexOf("await this.runtimeHost.dispose()") > shutdownSource.lastIndexOf("await this.stop()"));
	assert.ok(shutdownSource.lastIndexOf("if (cleanupFailed) throw cleanupError") > shutdownSource.lastIndexOf("await this.runtimeHost.dispose()"));
	const runtimeSource = readFileSync("packages/coding-agent/src/core/agent-session-runtime.ts", "utf8");
	assert.match(runtimeSource, /cancelPendingReplacements\(\): void/);
	assert.match(runtimeSource, /this\.replacementGeneration === generation/);
	assert.ok(runtimeSource.indexOf("if (!this.isReplacementCurrent(generation))") < runtimeSource.indexOf("this.apply(result)"));
	assert.doesNotMatch(runtimeSource, /Promise\.all|new (?:Map|Set|AbortController)/);

	const sessionSelectorSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/components/session-selector.ts",
		"utf8",
	);
	const deleteStart = sessionSelectorSource.indexOf("this.sessionList.onDeleteSession = async");
	const deleteEnd = sessionSelectorSource.indexOf("\n\t\t};", deleteStart);
	const deleteSource = sessionSelectorSource.slice(deleteStart, deleteEnd);
	assert.match(deleteSource, /const lifecycleGeneration = this\.lifecycleGeneration/);
	assert.ok(
		deleteSource.indexOf("lifecycleGeneration !== this.lifecycleGeneration") >
			deleteSource.indexOf("await this.deleteSessionOperation(sessionPath)"),
	);
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
	mode.modelCommandGeneration = 0;
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

test("model lookup cancellation clears its owned deadline before a deferred refresh settles", async () => {
	let settleRefresh: ((value: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
	const modelRuntime = {
		getAvailableSnapshot: () => [],
		refresh(): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
			return new Promise((resolve) => {
				settleRefresh = resolve;
			});
		},
	};
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.runtimeHost = { session: { modelRuntime, scopedModels: [] } };
	mode.tuiLifecycleGeneration = 0;
	mode.modelLookupGeneration = 0;
	mode.modelLookupTimedOutGeneration = 0;
	mode.showStatus = (): void => {};
	mode.showWarning = (): void => {};

	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const deadline = { fixture: "model-lookup-deadline" } as unknown as ReturnType<typeof setTimeout>;
	let deadlineCreated = 0;
	let deadlineCleared = 0;
	globalThis.setTimeout = ((_callback: TimerHandler, delay?: number) => {
		if (delay === 15_000) {
			deadlineCreated++;
			return deadline;
		}
		return originalSetTimeout(_callback, delay);
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
		if (handle === deadline) {
			deadlineCleared++;
			return;
		}
		originalClearTimeout(handle);
	}) as typeof clearTimeout;

	let lookup: Promise<unknown> | undefined;
	try {
		lookup = mode.findExactModelMatch("target");
		await Promise.resolve();
		assert.equal(deadlineCreated, 1);
		mode.cancelActiveModelLookup();
		assert.equal(deadlineCleared, 1);
		assert.equal(mode.activeModelLookupTimeout, undefined);
	} finally {
		settleRefresh?.({ aborted: true, errors: new Map() });
		await lookup;
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
});

test("a superseded model lookup cannot open its stale selector", async () => {
	let settleRefresh: ((value: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
	const selectorSearches: string[] = [];
	const modelRuntime = {
		getAvailableSnapshot: () => [],
		refresh(): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
			return new Promise((resolve) => {
				settleRefresh = resolve;
			});
		},
	};
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.runtimeHost = { session: { modelRuntime, scopedModels: [] } };
	mode.tuiLifecycleGeneration = 0;
	mode.modelCommandGeneration = 0;
	mode.modelLookupGeneration = 0;
	mode.modelLookupTimedOutGeneration = 0;
	mode.showStatus = (): void => {};
	mode.showWarning = (): void => {};
	mode.showModelSelector = (search: string): void => { selectorSearches.push(search); };

	const first = mode.handleModelCommand("first");
	await Promise.resolve();
	const second = mode.handleModelCommand("second");
	await Promise.resolve();
	settleRefresh?.({ aborted: false, errors: new Map() });
	await Promise.all([first, second]);

	assert.deepEqual(selectorSearches, ["second"]);
});

test("a cached model command cancels the previous uncached lookup before selecting", async () => {
	let availableModels: any[] = [];
	let refreshSignal: AbortSignal | undefined;
	let settleRefresh: ((value: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
	const selectedModels: string[] = [];
	let warningCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.runtimeHost = { session: {
		scopedModels: [],
		modelRuntime: {
			getAvailableSnapshot: () => availableModels,
			refresh(options: { signal: AbortSignal }): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
				refreshSignal = options.signal;
				return new Promise((resolve) => { settleRefresh = resolve; });
			},
		},
		setModel: async (model: { id: string }): Promise<void> => { selectedModels.push(model.id); },
	} };
	mode.tuiLifecycleGeneration = 0;
	mode.modelCommandGeneration = 0;
	mode.modelLookupGeneration = 0;
	mode.modelLookupTimedOutGeneration = 0;
	mode.footer = { invalidate(): void {} };
	mode.showStatus = (): void => {};
	mode.showWarning = (): void => { warningCalls++; };
	mode.showError = (): void => assert.fail("cached replacement must not fail");
	mode.showModelSelector = (): void => assert.fail("exact cached model must not open the selector");
	mode.updateEditorBorderColor = (): void => {};
	mode.observeLifecyclePromise = (): void => {};
	mode.maybeWarnAboutAnthropicSubscriptionAuth = async (): Promise<void> => {};
	mode.checkDaxnutsEasterEgg = (): void => {};

	const first = mode.handleModelCommand("uncached-a") as Promise<void>;
	await Promise.resolve();
	assert.equal(refreshSignal?.aborted, false);
	availableModels = [{ provider: "fixture", id: "cached-b" }];
	try {
		await mode.handleModelCommand("cached-b");
		assert.equal(refreshSignal?.aborted, true);
		assert.equal(mode.activeModelLookupController, undefined);
		assert.equal(mode.activeModelLookupTimeout, undefined);
		assert.deepEqual(selectedModels, ["cached-b"]);
	} finally {
		settleRefresh?.({ aborted: false, errors: new Map() });
		await first;
	}
	assert.equal(warningCalls, 0);
});

test("clipboard completion is inert after the interactive lifecycle closes", async () => {
	for (const rejects of [false, true]) {
		let settleCopy: (() => void) | undefined;
		let rejectCopy: ((error: Error) => void) | undefined;
		let statusCalls = 0;
		let errorCalls = 0;
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.tuiLifecycleGeneration = 0;
		mode.runtimeHost = { session: { getLastAssistantText: () => "copy fixture" } };
		mode.copyTextToClipboard = (): Promise<void> => new Promise((resolve, reject) => {
			settleCopy = resolve;
			rejectCopy = reject;
		});
		mode.showStatus = (): void => { statusCalls++; };
		mode.showError = (): void => { errorCalls++; };
		assert.equal(typeof InteractiveMode.prototype["copyTextToClipboard" as keyof InteractiveMode], "function");

		const operation = mode.handleCopyCommand() as Promise<void>;
		await Promise.resolve();
		mode.tuiLifecycleGeneration++;
		if (rejects) rejectCopy?.(new Error("late clipboard failure"));
		else settleCopy?.();
		await operation;

		assert.equal(statusCalls, 0);
		assert.equal(errorCalls, 0);
	}
});

test("interactive stop cancels the startup model catalog refresh and owned deadline", async () => {
	let refreshSignal: AbortSignal | undefined;
	let settleRefresh: ((value: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
	let providerCountUpdates = 0;
	const observed: Promise<unknown>[] = [];
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.init = async (): Promise<void> => {};
	mode.runtimeHost = { session: {
		modelRuntime: {
			getError: () => undefined,
			refresh(options: { signal: AbortSignal }): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
				refreshSignal = options.signal;
				return new Promise((resolve) => { settleRefresh = resolve; });
			},
		},
		settingsManager: {
			getFullscreenExitOutput: () => "transcript",
			getShowTerminalProgress: () => false,
		},
	} };
	mode.options = {};
	mode.isInitialized = false;
	mode.tuiLifecycleGeneration = 0;
	mode.startupModelRefreshGeneration = 0;
	mode.observeLifecyclePromise = (promise: Promise<unknown>): void => { observed.push(promise); };
	mode.checkForPackageUpdates = async (): Promise<string[]> => [];
	mode.checkTmuxKeyboardSetup = async (): Promise<undefined> => undefined;
	mode.maybeWarnAboutAnthropicSubscriptionAuth = async (): Promise<void> => {};
	mode.updateAvailableProviderCount = (): void => { providerCountUpdates++; };
	mode.getUserInput = (): Promise<string> => new Promise(() => {});
	mode.showWarning = (): void => {};
	mode.showError = (): void => {};
	mode.ui = createCountingTui();
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};
	mode.stopInteractiveTui = async (): Promise<void> => {};
	mode.releaseExtensionUiOwners = (): void => {};
	mode.cancelExtensionDialogs = (): void => {};
	mode.disposeActiveSelector = (): void => {};
	mode.cancelActiveLoginDialog = (): void => {};
	mode.cancelActiveProviderAuthentication = (): void => {};
	mode.cancelActiveModelLookup = (): void => {};
	mode.cancelActiveExtensionCustom = (): void => {};

	const originalOffline = process.env.SP_OFFLINE;
	delete process.env.SP_OFFLINE;
	try {
		void mode.run();
		await waitFor(() => refreshSignal !== undefined);
		assert.equal(refreshSignal?.aborted, false);
		await mode.stop();
		assert.equal(refreshSignal?.aborted, true);
		assert.equal(mode.activeStartupModelRefreshController, undefined);
		assert.equal(mode.activeStartupModelRefreshTimeout, undefined);
		settleRefresh?.({ aborted: false, errors: new Map() });
		await Promise.all(observed);
		assert.equal(providerCountUpdates, 0);
	} finally {
		if (originalOffline === undefined) delete process.env.SP_OFFLINE;
		else process.env.SP_OFFLINE = originalOffline;
		settleRefresh?.({ aborted: true, errors: new Map() });
	}
});

test("final shutdown rejects remaining startup diagnostic UI", async () => {
	let settleUpdates: ((updates: string[]) => void) | undefined;
	let notificationCalls = 0;
	let warningCalls = 0;
	const observed: Promise<unknown>[] = [];
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.init = async (): Promise<void> => {};
	mode.options = {};
	mode.isInitialized = false;
	mode.tuiLifecycleGeneration = 0;
	mode.observeLifecyclePromise = (promise: Promise<unknown>): void => { observed.push(promise); };
	mode.checkForPackageUpdates = (): Promise<string[]> => new Promise((resolve) => { settleUpdates = resolve; });
	mode.checkTmuxKeyboardSetup = async (): Promise<undefined> => undefined;
	mode.maybeWarnAboutAnthropicSubscriptionAuth = async (): Promise<void> => {};
	mode.showPackageUpdateNotification = (): void => { notificationCalls++; };
	mode.showWarning = (): void => { warningCalls++; };
	mode.showError = (): void => {};
	mode.getUserInput = (): Promise<string> => new Promise(() => {});
	mode.runtimeHost = { session: { modelRuntime: { getError: () => undefined } } };

	const originalOffline = process.env.SP_OFFLINE;
	process.env.SP_OFFLINE = "1";
	try {
		void mode.run();
		await waitFor(() => settleUpdates !== undefined);
		mode.tuiLifecycleGeneration++;
		settleUpdates?.(["late-package"]);
		await Promise.all(observed);
		assert.equal(notificationCalls, 0);
		assert.equal(warningCalls, 0);
	} finally {
		if (originalOffline === undefined) delete process.env.SP_OFFLINE;
		else process.env.SP_OFFLINE = originalOffline;
	}
});

test("startup diagnostic cancellation releases both tmux process slots and deadlines", () => {
	let firstKills = 0;
	let secondKills = 0;
	let firstSettles = 0;
	let secondSettles = 0;
	const firstTimer = setTimeout(() => assert.fail("first tmux timer leaked"), 60_000);
	const secondTimer = setTimeout(() => assert.fail("second tmux timer leaked"), 60_000);
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.startupDiagnosticsGeneration = 3;
	mode.activeTmuxExtendedKeysProcess = { kill(): void { firstKills++; } };
	mode.activeTmuxExtendedKeysTimeout = firstTimer;
	mode.activeTmuxExtendedKeysResolve = (): void => { firstSettles++; };
	mode.activeTmuxExtendedKeysFormatProcess = { kill(): void { secondKills++; } };
	mode.activeTmuxExtendedKeysFormatTimeout = secondTimer;
	mode.activeTmuxExtendedKeysFormatResolve = (): void => { secondSettles++; };

	mode.cancelActiveStartupDiagnostics();

	assert.equal(firstKills, 1);
	assert.equal(secondKills, 1);
	assert.equal(firstSettles, 1);
	assert.equal(secondSettles, 1);
	assert.equal(mode.activeTmuxExtendedKeysProcess, undefined);
	assert.equal(mode.activeTmuxExtendedKeysTimeout, undefined);
	assert.equal(mode.activeTmuxExtendedKeysResolve, undefined);
	assert.equal(mode.activeTmuxExtendedKeysFormatProcess, undefined);
	assert.equal(mode.activeTmuxExtendedKeysFormatTimeout, undefined);
	assert.equal(mode.activeTmuxExtendedKeysFormatResolve, undefined);
});

test("runtime disposal rejects an in-flight session replacement before apply", async () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	let settleRuntime: ((result: any) => void) | undefined;
	let oldDisposeCalls = 0;
	let replacementDisposeCalls = 0;
	const extensionRunner = { hasHandlers: () => false };
	const oldSession = {
		extensionRunner,
		sessionFile: undefined,
		sessionManager,
		abort: async (): Promise<void> => {},
		dispose(): void { oldDisposeCalls++; },
	};
	const replacementSession = {
		extensionRunner,
		sessionFile: undefined,
		sessionManager: SessionManager.inMemory(process.cwd()),
		agent: { state: { messages: [] } },
		createReplacedSessionContext: () => ({}),
		dispose(): void { replacementDisposeCalls++; },
	};
	const services = { cwd: process.cwd(), agentDir: process.cwd() };
	const runtime = new AgentSessionRuntime(
		oldSession as never,
		services as never,
		() => new Promise((resolve) => { settleRuntime = resolve; }),
	);

	const replacement = runtime.newSession();
	await waitFor(() => settleRuntime !== undefined);
	const disposal = runtime.dispose();
	settleRuntime?.({ session: replacementSession, services, diagnostics: [] });
	const replacementResult = await replacement;
	await disposal;

	assert.equal(replacementResult.cancelled, true);
	assert.notEqual(runtime.session, replacementSession);
	assert.equal(replacementDisposeCalls, 1);
	assert.ok(oldDisposeCalls >= 1);
});

test("final shutdown rejects new-session command completion UI", async () => {
	let settleReplacement: ((result: { cancelled: boolean }) => void) | undefined;
	let transcriptCalls = 0;
	let renderCalls = 0;
	let fatalCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.runtimeHost = {
		newSession: () => new Promise((resolve) => { settleReplacement = resolve; }),
	};
	mode.clearStatusIndicator = (): void => {};
	mode.chatContainer = { addChild(): void { transcriptCalls++; } };
	mode.ui = { requestRender(): void { renderCalls++; } };
	mode.handleFatalRuntimeError = async (): Promise<never> => {
		fatalCalls++;
		throw new Error("unexpected fatal runtime path");
	};

	const operation = mode.handleClearCommand() as Promise<void>;
	await Promise.resolve();
	mode.tuiLifecycleGeneration++;
	settleReplacement?.({ cancelled: false });
	await operation;

	assert.equal(transcriptCalls, 0);
	assert.equal(renderCalls, 0);
	assert.equal(fatalCalls, 0);
});

test("final shutdown rejects a late keyboard model-cycle continuation", async () => {
	let settleCycle: ((value: any) => void) | undefined;
	let footerCalls = 0;
	let borderCalls = 0;
	let statusCalls = 0;
	let errorCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.runtimeHost = { session: {
		cycleModel: () => new Promise((resolve) => { settleCycle = resolve; }),
		scopedModels: [],
	} };
	mode.footer = { invalidate(): void { footerCalls++; } };
	mode.updateEditorBorderColor = (): void => { borderCalls++; };
	mode.showStatus = (): void => { statusCalls++; };
	mode.showError = (): void => { errorCalls++; };
	mode.maybeWarnAboutAnthropicSubscriptionAuth = async (): Promise<void> => {};
	mode.observeLifecyclePromise = (): void => {};

	const operation = mode.cycleModel("forward") as Promise<void>;
	await Promise.resolve();
	mode.tuiLifecycleGeneration++;
	settleCycle?.({ model: { id: "late-model", name: "Late", reasoning: false }, thinkingLevel: "off" });
	await operation;

	assert.equal(footerCalls, 0);
	assert.equal(borderCalls, 0);
	assert.equal(statusCalls, 0);
	assert.equal(errorCalls, 0);
});

test("final shutdown rejects a late tree-navigation continuation after selector close", async () => {
	initTheme("dark");
	let settleNavigation: ((value: any) => void) | undefined;
	let selector: any;
	let selectorShows = 0;
	let statusCalls = 0;
	let transcriptRebuilds = 0;
	let renderCalls = 0;
	const tree = [{
		entry: {
			id: "target",
			parentId: null,
			type: "message",
			message: { role: "user", content: "target" },
			timestamp: new Date().toISOString(),
		},
		children: [],
	}];
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.runtimeHost = { session: {
		isStreaming: false,
		navigateTree: () => new Promise((resolve) => { settleNavigation = resolve; }),
		sessionManager: {
			getTree: () => tree,
			getLeafId: () => "current",
			appendLabelChange(): void {},
		},
		settingsManager: {
			getTreeFilterMode: () => "default",
			getBranchSummarySkipPrompt: () => true,
		},
	} };
	mode.ui = { terminal: { rows: 40 }, requestRender(): void { renderCalls++; } };
	mode.showSelector = (factory: (done: () => void) => { component: unknown }): void => {
		selectorShows++;
		selector = factory((): void => {}).component;
	};
	mode.showStatus = (): void => { statusCalls++; };
	mode.showError = (): void => assert.fail("stale navigation must not report an error");
	mode.chatContainer = { clear(): void { transcriptRebuilds++; } };
	mode.renderInitialMessages = (): void => { transcriptRebuilds++; };
	mode.editor = { getText: () => "", setText(): void {} };
	mode.defaultEditor = { onEscape: undefined };
	mode.flushCompactionQueue = async (): Promise<void> => {};
	mode.clearStatusIndicator = (): void => {};

	mode.showTreeSelector();
	const operation = selector.getTreeList().onSelect("target") as Promise<void>;
	await Promise.resolve();
	mode.tuiLifecycleGeneration++;
	settleNavigation?.({ aborted: true, cancelled: false });
	await operation;

	assert.equal(selectorShows, 1);
	assert.equal(statusCalls, 0);
	assert.equal(transcriptRebuilds, 0);
	assert.equal(renderCalls, 0);

	mode.showTreeSelector();
	const successOperation = selector.getTreeList().onSelect("target") as Promise<void>;
	await Promise.resolve();
	mode.tuiLifecycleGeneration++;
	settleNavigation?.({ aborted: false, cancelled: false, editorText: "late" });
	await successOperation;

	assert.equal(selectorShows, 2);
	assert.equal(statusCalls, 0);
	assert.equal(transcriptRebuilds, 0);
	assert.equal(renderCalls, 0);
});

test("final shutdown rejects reload callbacks and completion UI", async () => {
	initTheme("dark");
	let settleReload: (() => void) | undefined;
	let beforeSessionStart: (() => void | Promise<void>) | undefined;
	let rebuildCalls = 0;
	let postReloadCalls = 0;
	let statusCalls = 0;
	let errorCalls = 0;
	const editorChildren: unknown[] = [];
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.runtimeHost = { session: {
		isStreaming: false,
		isCompacting: false,
		reload(options: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
			beforeSessionStart = options.beforeSessionStart;
			return new Promise((resolve) => { settleReload = resolve; });
		},
		settingsManager: {
			getHideThinkingBlock: () => false,
			getOutputPad: () => 0,
		},
		resourceLoader: { getThemes: () => ({ themes: [] }) },
		extensionRunner: {},
		modelRuntime: { getError: () => undefined },
	} };
	mode.resetExtensionUI = (): void => {};
	mode.editor = { render: () => [] };
	mode.editorContainer = {
		clear(): void { editorChildren.length = 0; },
		addChild(child: unknown): void { editorChildren.push(child); },
	};
	mode.ui = { setFocus(): void {}, requestRender(): void {} };
	mode.rebuildChatFromMessages = (): void => { rebuildCalls++; };
	mode.keybindings = { reload(): void { postReloadCalls++; } };
	mode.builtInHeader = undefined;
	mode.customHeader = undefined;
	mode.themeController = { applyFromSettings: async (): Promise<void> => { postReloadCalls++; } };
	mode.applyRuntimeSettings = (): void => { postReloadCalls++; };
	mode.setupAutocompleteProvider = (): void => { postReloadCalls++; };
	mode.setupExtensionShortcuts = (): void => { postReloadCalls++; };
	mode.showLoadedResources = (): void => { postReloadCalls++; };
	mode.maybeSaveImplicitProjectTrustAfterReload = (): boolean => false;
	mode.showStatus = (): void => { statusCalls++; };
	mode.showError = (): void => { errorCalls++; };

	const operation = mode.handleReloadCommand() as Promise<void>;
	await waitFor(() => settleReload !== undefined);
	mode.tuiLifecycleGeneration++;
	await beforeSessionStart?.();
	settleReload?.();
	await operation;

	assert.equal(rebuildCalls, 0);
	assert.equal(postReloadCalls, 0);
	assert.equal(statusCalls, 0);
	assert.equal(errorCalls, 0);
});

test("final shutdown rejects late export completion UI", async () => {
	for (const rejects of [false, true]) {
		let settleExport: ((path: string) => void) | undefined;
		let rejectExport: ((error: Error) => void) | undefined;
		let statusCalls = 0;
		let errorCalls = 0;
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.tuiLifecycleGeneration = 0;
		mode.runtimeHost = { session: {
			exportToHtml(): Promise<string> {
				return new Promise((resolve, reject) => {
					settleExport = resolve;
					rejectExport = reject;
				});
			},
		} };
		mode.showStatus = (): void => { statusCalls++; };
		mode.showError = (): void => { errorCalls++; };

		const operation = mode.handleExportCommand("/export") as Promise<void>;
		await Promise.resolve();
		mode.tuiLifecycleGeneration++;
		if (rejects) rejectExport?.(new Error("late export failure"));
		else settleExport?.("late.html");
		await operation;

		assert.equal(statusCalls, 0);
		assert.equal(errorCalls, 0);
	}
});

test("final shutdown rejects logout work after its selector closes", async () => {
	initTheme("dark");
	let selector: any;
	let settleLogout: (() => void) | undefined;
	let providerCountCalls = 0;
	let statusCalls = 0;
	let errorCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.getLogoutProviderOptions = async () => [{
		id: "fixture",
		name: "Fixture",
		authType: "oauth",
	}];
	mode.runtimeHost = { session: { modelRuntime: {
		logout(): Promise<void> {
			return new Promise((resolve) => { settleLogout = resolve; });
		},
	} } };
	mode.showSelector = (factory: (done: () => void) => { component: unknown }): void => {
		selector = factory((): void => {}).component;
	};
	mode.updateAvailableProviderCount = async (): Promise<void> => { providerCountCalls++; };
	mode.showStatus = (): void => { statusCalls++; };
	mode.showError = (): void => { errorCalls++; };
	mode.ui = { requestRender(): void {} };

	await mode.showOAuthSelector("logout");
	const operation = selector.onSelectCallback("fixture", "oauth") as Promise<void>;
	await Promise.resolve();
	mode.tuiLifecycleGeneration++;
	settleLogout?.();
	await operation;

	assert.equal(providerCountCalls, 0);
	assert.equal(statusCalls, 0);
	assert.equal(errorCalls, 0);
});

test("final shutdown rejects logout provider-count completion UI", async () => {
	initTheme("dark");
	let selector: any;
	let settleProviderCount: (() => void) | undefined;
	let statusCalls = 0;
	let errorCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.getLogoutProviderOptions = async () => [{ id: "fixture", name: "Fixture", authType: "oauth" }];
	mode.runtimeHost = { session: { modelRuntime: { logout: async (): Promise<void> => {} } } };
	mode.showSelector = (factory: (done: () => void) => { component: unknown }): void => {
		selector = factory((): void => {}).component;
	};
	mode.updateAvailableProviderCount = (): Promise<void> => new Promise((resolve) => { settleProviderCount = resolve; });
	mode.showStatus = (): void => { statusCalls++; };
	mode.showError = (): void => { errorCalls++; };
	mode.ui = { requestRender(): void {} };

	await mode.showOAuthSelector("logout");
	const operation = selector.onSelectCallback("fixture", "oauth") as Promise<void>;
	await waitFor(() => settleProviderCount !== undefined);
	mode.tuiLifecycleGeneration++;
	settleProviderCount?.();
	await operation;

	assert.equal(statusCalls, 0);
	assert.equal(errorCalls, 0);
});

test("final shutdown rejects follow-up prompt completion UI", async () => {
	for (const rejects of [false, true]) {
		let settlePrompt: (() => void) | undefined;
		let rejectPrompt: ((error: Error) => void) | undefined;
		let pendingDisplayCalls = 0;
		let renderCalls = 0;
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.tuiLifecycleGeneration = 0;
		mode.editor = {
			getText: () => "follow-up",
			setText(): void {},
			addToHistory(): void {},
		};
		mode.runtimeHost = { session: {
			isCompacting: false,
			isStreaming: true,
			prompt(): Promise<void> {
				return new Promise((resolve, reject) => {
					settlePrompt = resolve;
					rejectPrompt = reject;
				});
			},
		} };
		mode.updatePendingMessagesDisplay = (): void => { pendingDisplayCalls++; };
		mode.ui = { requestRender(): void { renderCalls++; } };

		const operation = mode.handleFollowUp() as Promise<void>;
		await Promise.resolve();
		mode.tuiLifecycleGeneration++;
		if (rejects) rejectPrompt?.(new Error("late prompt failure"));
		else settlePrompt?.();
		await operation;

		assert.equal(pendingDisplayCalls, 0);
		assert.equal(renderCalls, 0);
	}
});

test("final shutdown cancels a pending suspend handoff", async () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	const originalSigintListeners = process.listeners("SIGINT");
	const originalSigcontListeners = process.listeners("SIGCONT");
	let settleStop: (() => void) | undefined;
	let suspendCalls = 0;
	let startCalls = 0;
	let renderCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.suspendGeneration = 0;
	mode.activeSuspendGeneration = 0;
	mode.activeSuspendLifecycleGeneration = 0;
	mode.ignoreSuspendSigint = (): void => {};
	mode.handleSuspendContinue = (): void => {
		const generation = mode.activeSuspendGeneration;
		if (generation === 0) return;
		const lifecycleGeneration = mode.activeSuspendLifecycleGeneration;
		mode.clearActiveSuspend(generation);
		if (mode.tuiLifecycleGeneration !== lifecycleGeneration) return;
		mode.ui.start();
		mode.ui.requestRender(true);
	};
	mode.ui = {
		stop: () => new Promise<void>((resolve) => { settleStop = resolve; }),
		start(): void { startCalls++; },
		requestRender(): void { renderCalls++; },
	};
	mode.suspendProcessGroup = (): void => { suspendCalls++; };

	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
		const operation = mode.handleCtrlZ() as Promise<void>;
		await Promise.resolve();
		mode.tuiLifecycleGeneration++;
		mode.cancelActiveSuspend();
		assert.equal(mode.activeSuspendGeneration, 0);
		assert.equal(mode.activeSuspendKeepAlive, undefined);
		settleStop?.();
		await operation;
		process.emit("SIGCONT");

		assert.equal(suspendCalls, 0);
		assert.equal(startCalls, 0);
		assert.equal(renderCalls, 0);
	} finally {
		const currentSigint = process.listeners("SIGINT");
		for (const listener of currentSigint) {
			if (!originalSigintListeners.includes(listener)) process.removeListener("SIGINT", listener);
		}
		const currentSigcont = process.listeners("SIGCONT");
		for (const listener of currentSigcont) {
			if (!originalSigcontListeners.includes(listener)) process.removeListener("SIGCONT", listener);
		}
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
});

test("interactive stop settles a pending extension custom factory and disposes its late result", async () => {
	const tui = createCountingTui() as any;
	let settleFactory: ((component: { render(): string[]; dispose(): void }) => void) | undefined;
	let disposeCalls = 0;
	let mountedLateComponent = false;
	let operationSettled = false;
	const component = {
		render(): string[] { return []; },
		dispose(): void { disposeCalls++; },
	};
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
	mode.keybindings = {};
	mode.editor = { getText: () => "draft", setText(): void {} };
	mode.editorContainer = {
		clear(): void {},
		addChild(child: unknown): void { if (child === component) mountedLateComponent = true; },
	};
	mode.extensionWidgetsAbove = new Map();
	mode.extensionWidgetsBelow = new Map();
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

	void mode.showExtensionCustom(
		() => new Promise((resolve) => { settleFactory = resolve; }),
	).then(
		() => { operationSettled = true; },
		() => assert.fail("shutdown cancellation must not reject extension custom UI"),
	);
	await Promise.resolve();
	await mode.stop();
	settleFactory?.(component);
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(operationSettled, true);
	assert.equal(disposeCalls, 1);
	assert.equal(mountedLateComponent, false);
});

test("interactive custom cancellation disposes an already mounted component", async () => {
	let disposeCalls = 0;
	let mounted = false;
	const component = {
		render(): string[] { return []; },
		dispose(): void { disposeCalls++; },
	};
	const editor = { getText: () => "draft", setText(): void {} };
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.ui = createCountingTui();
	mode.tuiLifecycleGeneration = 0;
	mode.keybindings = {};
	mode.editor = editor;
	mode.editorContainer = {
		clear(): void {},
		addChild(child: unknown): void { if (child === component) mounted = true; },
	};

	const operation = mode.showExtensionCustom(() => component) as Promise<void>;
	await Promise.resolve();
	assert.equal(mounted, true);
	mode.cancelActiveExtensionCustom();
	await operation;

	assert.equal(disposeCalls, 1);
	assert.equal(mode.activeExtensionCustomCancel, undefined);
});

test("interactive custom cancellation closes an already mounted overlay", async () => {
	let disposeCalls = 0;
	let showOverlayCalls = 0;
	let hideOverlayCalls = 0;
	const component = {
		render(): string[] { return []; },
		dispose(): void { disposeCalls++; },
	};
	const tui = createCountingTui() as any;
	tui.showOverlay = (): object => {
		showOverlayCalls++;
		return { hide(): void { hideOverlayCalls++; } };
	};
	tui.hideOverlay = (): void => assert.fail("custom overlays must close their exact handle");
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.ui = tui;
	mode.tuiLifecycleGeneration = 0;
	mode.keybindings = {};
	mode.editor = { getText: () => "draft", setText(): void {} };

	const operation = mode.showExtensionCustom(
		() => component,
		{ overlay: true },
	) as Promise<void>;
	await Promise.resolve();
	assert.equal(showOverlayCalls, 1);
	mode.cancelActiveExtensionCustom();
	await operation;

	assert.equal(hideOverlayCalls, 1);
	assert.equal(disposeCalls, 1);
	assert.equal(mode.activeExtensionCustomCancel, undefined);
});

test("custom overlay cancellation hides its own entry without removing a nested overlay", async () => {
	const stack: unknown[] = [];
	let hideTopCalls = 0;
	let firstDisposeCalls = 0;
	const first = { render(): string[] { return []; }, dispose(): void { firstDisposeCalls++; } };
	const nested = { render(): string[] { return []; } };
	const tui = createCountingTui() as any;
	tui.showOverlay = (component: unknown): { hide(): void } => {
		stack.push(component);
		return {
			hide(): void {
				const index = stack.indexOf(component);
				if (index !== -1) stack.splice(index, 1);
			},
		};
	};
	tui.hideOverlay = (): void => {
		hideTopCalls++;
		stack.pop();
	};
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.ui = tui;
	mode.tuiLifecycleGeneration = 0;
	mode.keybindings = {};
	mode.editor = { getText: () => "draft", setText(): void {} };

	const operation = mode.showExtensionCustom(
		() => first,
		{
			overlay: true,
			onHandle(): void { tui.showOverlay(nested); },
		},
	) as Promise<void>;
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(stack, [first, nested]);
	mode.cancelActiveExtensionCustom();
	await operation;

	assert.deepEqual(stack, [nested]);
	assert.equal(hideTopCalls, 0);
	assert.equal(firstDisposeCalls, 1);
});

test("login cancellation settles and removes an auth selector without a prompt signal", async () => {
	initTheme("dark");
	const tui = createCountingTui();
	const dialog = new LoginDialogComponent(tui, "fixture", () => {});
	const children: unknown[] = [];
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.ui = tui;
	mode.editorContainer = {
		children,
		clear(): void { children.length = 0; },
		addChild(component: unknown): void { children.push(component); },
	};
	mode.activeLoginDialog = dialog;
	const selection = mode.showAuthSelect(dialog, {
		type: "select",
		message: "Choose authentication",
		options: [{ id: "fixture", label: "Fixture" }],
	}) as Promise<string>;
	let settlement: "pending" | "resolved" | "rejected" = "pending";
	const observed = selection.then(
		() => { settlement = "resolved"; },
		() => { settlement = "rejected"; },
	);
	assert.equal(children.length, 1);
	mode.cancelActiveLoginDialog();
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(settlement, "rejected");
	assert.equal(mode.activeLoginDialog, undefined);
	assert.equal(mode.activeAuthSelector, undefined);
	assert.equal(children.length, 0);
	await observed;
});

test("auth prompt signal cancellation releases its tracked selector and restores the live dialog", async () => {
	initTheme("dark");
	const tui = createCountingTui();
	const dialog = new LoginDialogComponent(tui, "fixture", () => {});
	const children: unknown[] = [];
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.ui = tui;
	mode.editorContainer = {
		children,
		clear(): void { children.length = 0; },
		addChild(component: unknown): void { children.push(component); },
	};
	mode.activeLoginDialog = dialog;
	const controller = new AbortController();
	const selection = mode.showAuthPrompt(dialog, {
		type: "select",
		message: "Choose authentication",
		options: [{ id: "fixture", label: "Fixture" }],
		signal: controller.signal,
	}) as Promise<string>;
	assert.equal(children.length, 1);
	controller.abort();
	await assert.rejects(selection, /Login cancelled/);

	assert.equal(mode.activeAuthSelector, undefined);
	assert.deepEqual(children, [dialog]);
	assert.equal(mode.activeLoginDialog, dialog);
});

test("disposed session selector rejects a late deletion continuation", async () => {
	let settleDelete: ((result: { ok: boolean; method: "trash" | "unlink" }) => void) | undefined;
	let requestRenderCalls = 0;
	const selector = new SessionSelectorComponent(
		async () => [],
		async () => [],
		() => {},
		() => {},
		() => {},
		() => { requestRenderCalls++; },
	);
	await Promise.resolve();
	const state = selector as any;
	state.currentSessions = [{ path: "fixture-session.jsonl" }];
	state.deleteSessionOperation = () => new Promise((resolve) => { settleDelete = resolve; });
	const deletion = state.sessionList.onDeleteSession("fixture-session.jsonl");
	await Promise.resolve();
	assert.ok(settleDelete);
	selector.dispose();
	const rendersAfterDispose = requestRenderCalls;
	settleDelete?.({ ok: true, method: "trash" });
	await deletion;

	assert.equal(state.header.statusTimeout, null);
	assert.equal(requestRenderCalls, rendersAfterDispose);
	assert.equal(state.currentSessions.length, 1);
});

test("final shutdown rejects a late main external-editor completion", async () => {
	let settleEditor: ((result: { status: "complete"; content: string }) => void) | undefined;
	let setTextCalls = 0;
	let startCalls = 0;
	let renderCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.runtimeHost = {
		session: { settingsManager: { getExternalEditorCommand: () => "fixture-editor" } },
	};
	mode.editor = {
		getText: () => "before",
		setText(): void { setTextCalls++; },
	};
	mode.ui = {
		stop: async (): Promise<void> => {},
		start(): void { startCalls++; },
		requestRender(): void { renderCalls++; },
	};
	mode.runExternalEditor = () => new Promise((resolve) => { settleEditor = resolve; });

	const operation = mode.handleOpenExternalEditor();
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(settleEditor);
	mode.tuiLifecycleGeneration++;
	settleEditor?.({ status: "complete", content: "late" });
	await operation;

	assert.equal(setTextCalls, 0);
	assert.equal(startCalls, 0);
	assert.equal(renderCalls, 0);
});

test("final shutdown rejects a late model-selector selection", async () => {
	initTheme("dark");
	let settleModel: (() => void) | undefined;
	let selector: any;
	let doneCalls = 0;
	let footerCalls = 0;
	let statusCalls = 0;
	let warningCalls = 0;
	let easterEggCalls = 0;
	const model = { provider: "fixture", id: "fixture-model" } as any;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.ui = createCountingTui();
	mode.runtimeHost = { session: {
		model: undefined,
		settingsManager: {
			getDefaultProvider: () => undefined,
			getDefaultModel: () => undefined,
		},
		modelRuntime: {
			getAvailableSnapshot: () => [model],
			getModel: () => model,
			refresh: async () => ({ aborted: false, errors: new Map() }),
		},
		scopedModels: [],
		setModel: () => new Promise<void>((resolve) => { settleModel = resolve; }),
	} };
	mode.footer = { invalidate(): void { footerCalls++; } };
	mode.updateEditorBorderColor = (): void => {};
	mode.showStatus = (): void => { statusCalls++; };
	mode.showError = (): void => assert.fail("late model selection must not report an error");
	mode.observeLifecyclePromise = (): void => { warningCalls++; };
	mode.maybeWarnAboutAnthropicSubscriptionAuth = async (): Promise<void> => {};
	mode.checkDaxnutsEasterEgg = (): void => { easterEggCalls++; };
	mode.showSelector = (create: (done: () => void) => { component: unknown }) => {
		selector = create(() => { doneCalls++; }).component;
	};

	mode.showModelSelector();
	const selection = (selector as any).onSelectCallback(model) as Promise<void>;
	assert.ok(settleModel);
	mode.tuiLifecycleGeneration++;
	settleModel?.();
	await selection;
	selector.dispose();

	assert.equal(doneCalls, 0);
	assert.equal(footerCalls, 0);
	assert.equal(statusCalls, 0);
	assert.equal(warningCalls, 0);
	assert.equal(easterEggCalls, 0);
});

test("final shutdown rejects a late share export before mounting its loader", async () => {
	initTheme("dark");
	const directory = await mkdtemp(path.join(os.tmpdir(), "super-pi-share-export-owner-"));
	const previousTmp = process.env.TMP;
	const previousTemp = process.env.TEMP;
	const previousTmpdir = process.env.TMPDIR;
	process.env.TMP = directory;
	process.env.TEMP = directory;
	process.env.TMPDIR = directory;
	try {
		let settleExport: (() => void) | undefined;
		let mountedOwners = 0;
		let focusCalls = 0;
		let renderCalls = 0;
		let exportedPath = "";
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.tuiLifecycleGeneration = 0;
		mode.getGitHubCliAuthStatus = () => ({ status: 0 });
		mode.runtimeHost = { session: {
			exportToHtml: async (filePath: string) => {
				exportedPath = filePath;
				await new Promise<void>((resolve) => { settleExport = resolve; });
				await writeFile(filePath, "late export", "utf8");
			},
		} };
		mode.ui = {
			requestRender(): void { renderCalls++; },
			setFocus(): void { focusCalls++; },
		};
		mode.editor = {};
		mode.editorContainer = {
			clear(): void {},
			addChild(): void { mountedOwners++; },
		};
		mode.showError = (): void => {};
		mode.showStatus = (): void => {};

		const operation = mode.handleShareCommand();
		await Promise.resolve();
		assert.ok(settleExport);
		mode.tuiLifecycleGeneration++;
		settleExport?.();
		await operation;

		assert.equal(mountedOwners, 0);
		assert.equal(focusCalls, 0);
		assert.equal(renderCalls, 0);
		await assert.rejects(access(exportedPath));
	} finally {
		if (previousTmp === undefined) delete process.env.TMP;
		else process.env.TMP = previousTmp;
		if (previousTemp === undefined) delete process.env.TEMP;
		else process.env.TEMP = previousTemp;
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("final shutdown rejects post-login model selection before catalog refresh", async () => {
	initTheme("dark");
	let settleModel: (() => void) | undefined;
	let refreshCalls = 0;
	let footerInvalidations = 0;
	let statusCalls = 0;
	let renderCalls = 0;
	const defaultModel = {
		provider: "anthropic",
		id: "claude-opus-4-8",
		api: "anthropic-messages",
	} as any;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.providerAuthenticationGeneration = 0;
	mode.runtimeHost = { session: {
		modelRuntime: {
			getAvailableSnapshot: () => [defaultModel],
			refresh: async () => {
				refreshCalls++;
				return { aborted: false, errors: new Map() };
			},
		},
		scopedModels: [],
		setModel: () => new Promise<void>((resolve) => { settleModel = resolve; }),
		settingsManager: {
			getFullscreenExitOutput: () => "transcript",
			getShowTerminalProgress: () => false,
		},
	} };
	mode.ui = { requestRender(): void { renderCalls++; } };
	mode.footer = {
		invalidate(): void { footerInvalidations++; },
		dispose(): void {},
	};
	mode.footerDataProvider = {
		setAvailableProviderCount(): void {},
		dispose(): void {},
	};
	mode.updateEditorBorderColor = (): void => {};
	mode.showStatus = (): void => { statusCalls++; };
	mode.showError = (): void => {};
	mode.showWarning = (): void => {};
	mode.observeLifecyclePromise = (): void => {};
	mode.maybeWarnAboutAnthropicSubscriptionAuth = async (): Promise<void> => {};
	mode.checkDaxnutsEasterEgg = (): void => {};
	mode.themeController = { disableAutoSync(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};

	const operation = mode.completeProviderAuthentication("anthropic", "Anthropic", "oauth", {
		provider: "unknown",
		id: "unknown",
		api: "unknown",
	});
	await Promise.resolve();
	assert.ok(settleModel);
	await mode.stop();
	const footerAfterStop = footerInvalidations;
	const statusAfterStop = statusCalls;
	const rendersAfterStop = renderCalls;
	settleModel?.();
	await operation;
	await Promise.resolve();

	assert.equal(refreshCalls, 0);
	assert.equal(footerInvalidations, footerAfterStop);
	assert.equal(statusCalls, statusAfterStop);
	assert.equal(renderCalls, rendersAfterStop);
});

test("final shutdown aborts the post-login catalog refresh and rejects its late completion", async () => {
	initTheme("dark");
	let settleRefresh: ((result: { aborted: boolean; errors: Map<string, Error> }) => void) | undefined;
	let refreshSignal: AbortSignal | undefined;
	let footerInvalidations = 0;
	let warningCalls = 0;
	let renderCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.providerAuthenticationGeneration = 0;
	mode.runtimeHost = { session: {
		modelRuntime: {
			getAvailableSnapshot: () => [],
			refresh: ({ signal }: { signal: AbortSignal }) => {
				refreshSignal = signal;
				return new Promise((resolve) => { settleRefresh = resolve; });
			},
		},
		scopedModels: [],
		settingsManager: {
			getFullscreenExitOutput: () => "transcript",
			getShowTerminalProgress: () => false,
		},
	} };
	mode.ui = { requestRender(): void { renderCalls++; } };
	mode.footer = {
		invalidate(): void { footerInvalidations++; },
		dispose(): void {},
	};
	mode.footerDataProvider = {
		setAvailableProviderCount(): void {},
		dispose(): void {},
	};
	mode.updateEditorBorderColor = (): void => {};
	mode.showStatus = (): void => {};
	mode.showError = (): void => {};
	mode.showWarning = (): void => { warningCalls++; };
	mode.observeLifecyclePromise = (): void => {};
	mode.maybeWarnAboutAnthropicSubscriptionAuth = async (): Promise<void> => {};
	mode.themeController = { disableAutoSync(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};

	const operation = mode.completeProviderAuthentication("fixture", "Fixture", "oauth", {
		provider: "fixture",
		id: "known",
		api: "fixture",
	});
	await waitFor(() => refreshSignal !== undefined);
	await operation;
	await mode.stop();
	assert.equal(refreshSignal?.aborted, true);
	assert.equal(mode.activeProviderAuthenticationController, undefined);
	assert.equal(mode.activeProviderAuthenticationTimeout, undefined);
	const footerAfterStop = footerInvalidations;
	const warningsAfterStop = warningCalls;
	const rendersAfterStop = renderCalls;
	settleRefresh?.({ aborted: true, errors: new Map() });
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(footerInvalidations, footerAfterStop);
	assert.equal(warningCalls, warningsAfterStop);
	assert.equal(renderCalls, rendersAfterStop);
	assert.equal(mode.activeProviderAuthenticationController, undefined);
	assert.equal(mode.activeProviderAuthenticationTimeout, undefined);
});

test("final shutdown rejects late extension bash setup before constructing its loader", async () => {
	initTheme("dark");
	let settleExtension: ((result: undefined) => void) | undefined;
	let settleBash: ((result: any) => void) | undefined;
	let executeCalls = 0;
	let mountedBashOwners = 0;
	let renderCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.runtimeHost = { session: {
		extensionRunner: {
			emitUserBash: () => new Promise<undefined>((resolve) => { settleExtension = resolve; }),
		},
		isStreaming: false,
		executeBash: () => {
			executeCalls++;
			return new Promise((resolve) => { settleBash = resolve; });
		},
		recordBashResult(): void {},
		settingsManager: {
			getFullscreenExitOutput: () => "transcript",
			getShowTerminalProgress: () => false,
		},
		sessionManager: { getCwd: () => process.cwd() },
	} };
	mode.ui = createCountingTui();
	mode.ui.requestRender = (): void => { renderCalls++; };
	mode.chatContainer = {
		addChild(): void { mountedBashOwners++; },
		invalidateViewportChild(): void {},
	};
	mode.pendingMessagesContainer = { addChild(): void { mountedBashOwners++; } };
	mode.pendingBashComponents = [];
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};
	mode.showError = (): void => {};

	const operation = mode.handleBashCommand("echo late");
	await Promise.resolve();
	assert.ok(settleExtension);
	await mode.stop();
	const rendersAfterStop = renderCalls;
	settleExtension?.(undefined);
	await Promise.resolve();
	await Promise.resolve();
	settleBash?.({ exitCode: 0, cancelled: false, truncated: false, output: "", fullOutputPath: undefined });
	await operation;

	assert.equal(executeCalls, 0);
	assert.equal(mountedBashOwners, 0);
	assert.equal(renderCalls, rendersAfterStop);
	assert.equal(mode.bashComponent, undefined);
});

test("final shutdown rejects late active bash chunks and completion after display release", async () => {
	initTheme("dark");
	let onChunk: ((chunk: string) => void) | undefined;
	let settleBash: ((result: any) => void) | undefined;
	let mountedComponent: BashExecutionComponent | undefined;
	let renderCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.runtimeHost = { session: {
		extensionRunner: { emitUserBash: async () => undefined },
		isStreaming: false,
		executeBash: (_command: string, chunk: (value: string) => void) => {
			onChunk = chunk;
			return new Promise((resolve) => { settleBash = resolve; });
		},
		recordBashResult(): void {},
		settingsManager: {
			getFullscreenExitOutput: () => "transcript",
			getShowTerminalProgress: () => false,
		},
		sessionManager: { getCwd: () => process.cwd() },
	} };
	mode.ui = createCountingTui();
	mode.ui.requestRender = (): void => { renderCalls++; };
	mode.chatContainer = {
		addChild(component: BashExecutionComponent): void { mountedComponent = component; },
		invalidateViewportChild(): void {},
	};
	mode.pendingMessagesContainer = { addChild(): void {} };
	mode.pendingBashComponents = [];
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};
	mode.showError = (): void => assert.fail("stale bash completion must not report an error");

	const operation = mode.handleBashCommand("echo late");
	await waitFor(() => onChunk !== undefined && mountedComponent !== undefined);
	await mode.stop();
	mountedComponent?.[TOOL_RELEASE_COMPONENT_RENDER_CACHE]();
	const rendersAfterStop = renderCalls;
	onChunk?.("late output");
	settleBash?.({ exitCode: 0, cancelled: false, truncated: false, output: "late output", fullOutputPath: undefined });
	await operation;

	assert.equal(mountedComponent?.getOutput(), "");
	assert.equal((mountedComponent as any).contentContainer.children.length, 0);
	assert.equal(renderCalls, rendersAfterStop);
	assert.equal(mode.bashComponent, undefined);
});

test("final shutdown rejects a late active bash error continuation", async () => {
	initTheme("dark");
	let rejectBash: ((error: Error) => void) | undefined;
	let mountedComponent: BashExecutionComponent | undefined;
	let errorCalls = 0;
	let renderCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.runtimeHost = { session: {
		extensionRunner: { emitUserBash: async () => undefined },
		isStreaming: false,
		executeBash: () => new Promise((_resolve, reject) => { rejectBash = reject; }),
		recordBashResult(): void {},
		settingsManager: {
			getFullscreenExitOutput: () => "transcript",
			getShowTerminalProgress: () => false,
		},
		sessionManager: { getCwd: () => process.cwd() },
	} };
	mode.ui = createCountingTui();
	mode.ui.requestRender = (): void => { renderCalls++; };
	mode.chatContainer = {
		addChild(component: BashExecutionComponent): void { mountedComponent = component; },
		invalidateViewportChild(): void {},
	};
	mode.pendingMessagesContainer = { addChild(): void {} };
	mode.pendingBashComponents = [];
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = false;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.unregisterSignalHandlers = (): void => {};
	mode.showError = (): void => { errorCalls++; };

	const operation = mode.handleBashCommand("exit 1");
	await waitFor(() => rejectBash !== undefined && mountedComponent !== undefined);
	await mode.stop();
	mountedComponent?.[TOOL_RELEASE_COMPONENT_RENDER_CACHE]();
	const rendersAfterStop = renderCalls;
	rejectBash?.(new Error("late failure"));
	await operation;

	assert.equal(errorCalls, 0);
	assert.equal((mountedComponent as any).contentContainer.children.length, 0);
	assert.equal(renderCalls, rendersAfterStop);
	assert.equal(mode.bashComponent, undefined);
});

test("cache-only release clears the built-in Bash elapsed timer and timing sidecars", () => {
	initTheme("dark");
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const interval = { unref(): void {} } as unknown as ReturnType<typeof setInterval>;
	let intervalCallback: (() => void) | undefined;
	let clearCalls = 0;
	globalThis.setInterval = ((callback: () => void) => {
		intervalCallback = callback;
		return interval;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
		if (handle === interval) clearCalls++;
		else originalClearInterval(handle);
	}) as typeof clearInterval;
	const tui = createCountingTui();
	try {
		const component = new ToolExecutionComponent(
			"bash",
			"bash-render-lifecycle",
			{ command: "sleep 30" },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial" }] }, true, false);
		const state = (component as any).rendererState as {
			startedAt: number | undefined;
			endedAt: number | undefined;
			interval: ReturnType<typeof setInterval> | undefined;
		};
		assert.equal(state.interval, interval);
		const rendersBeforeRelease = tui.requestRenderCalls;
		component[TOOL_RELEASE_COMPONENT_RENDER_CACHE]();
		assert.equal(state.interval, undefined);
		assert.equal(state.startedAt, undefined);
		assert.equal(state.endedAt, undefined);
		assert.equal(clearCalls, 1);
		intervalCallback?.();
		assert.equal(tui.requestRenderCalls, rendersBeforeRelease);
		component.updateResult({ content: [{ type: "text", text: "remounted partial" }] }, true, false);
		assert.equal(state.interval, interval);
		assert.notEqual(state.startedAt, undefined);
		component[TOOL_RELEASE_COMPONENT_RENDER_CACHE]();
		assert.equal(clearCalls, 2);
		assert.equal(state.interval, undefined);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test("mode stop preserves its first error while finishing TUI and signal cleanup", async () => {
	const extensionError = new Error("extension release failed");
	const terminalError = new Error("terminal dispose failed");
	let unregisterCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.tuiLifecycleGeneration = 0;
	mode.providerAuthenticationGeneration = 0;
	mode.runtimeHost = { session: { settingsManager: {
		getFullscreenExitOutput: () => "transcript",
		getShowTerminalProgress: () => false,
	} } };
	mode.ui = createCountingTui();
	mode.themeController = { disableAutoSync(): void {} };
	mode.footer = { dispose(): void {} };
	mode.footerDataProvider = { dispose(): void {} };
	mode.isInitialized = true;
	mode.clearStatusIndicator = (): void => {};
	mode.clearExtensionTerminalInputListeners = (): void => {};
	mode.releaseExtensionUiOwners = (): void => { throw extensionError; };
	mode.stopInteractiveTui = async (): Promise<void> => { throw terminalError; };
	mode.unregisterSignalHandlers = (): void => { unregisterCalls++; };

	await assert.rejects(mode.stop(), (error: unknown) => error === extensionError);
	assert.equal(mode.isInitialized, false);
	assert.equal(unregisterCalls, 1);
});

test("normal shutdown disposes the runtime after TUI stop rejects", async () => {
	const stopError = new Error("stop failed");
	let runtimeDisposeCalls = 0;
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.isShuttingDown = false;
	mode.tuiLifecycleGeneration = 0;
	mode.ui = { terminal: { drainInput: async (): Promise<void> => {} } };
	mode.themeController = { disableAutoSync(): void {} };
	mode.stop = async (): Promise<void> => { throw stopError; };
	mode.runtimeHost = { dispose: async (): Promise<void> => { runtimeDisposeCalls++; } };

	await assert.rejects(mode.shutdown(), (error: unknown) => error === stopError);
	assert.equal(runtimeDisposeCalls, 1);
});
