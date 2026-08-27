/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@super-pi/tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { createStartupTui, observeStartupLifecycle, startStartupTui } from "./startup-ui.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve, reject) => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;
		const finish = async (path: string | null, exit: boolean): Promise<void> => {
			if (resolved) return;
			resolved = true;
			await ui.dispose();
			if (exit) process.exit(0);
			resolve(path);
		};

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				observeStartupLifecycle(finish(path, false), reject);
			},
			() => {
				observeStartupLifecycle(finish(null, false), reject);
			},
			() => {
				observeStartupLifecycle(finish(null, true), reject);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}
