/**
 * TUI config selector for `pi config` command
 */

import { ProcessTerminal, type TUI, TuiAltScreen } from "@super-pi/tui";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent, type ScopedResolvedPaths } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";
import { observeStartupLifecycle, STARTUP_DIALOG_SCREEN_OPTIONS } from "./startup-ui.ts";

export interface ConfigSelectorOptions {
	resolvedPaths: ScopedResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	writeScope: "global" | "project";
	projectModeAvailable: boolean;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve, reject) => {
		const ui: TUI = new TuiAltScreen(new ProcessTerminal(), undefined, options.agentDir, STARTUP_DIALOG_SCREEN_OPTIONS);
		let resolved = false;
		const finish = async (exit: boolean): Promise<void> => {
			if (resolved) return;
			resolved = true;
			try {
				// Leaving the alternate screen restores the terminal as it was before the selector.
				await ui.dispose({ preserveScreen: true });
			} finally {
				stopThemeWatcher();
			}
			if (exit) process.exit(0);
			resolve();
		};

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				observeStartupLifecycle(finish(false), reject);
			},
			() => {
				observeStartupLifecycle(finish(true), reject);
			},
			() => ui.requestRender(),
			ui.terminal.rows,
			options.writeScope,
			options.projectModeAvailable,
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
