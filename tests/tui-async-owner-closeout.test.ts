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
});
