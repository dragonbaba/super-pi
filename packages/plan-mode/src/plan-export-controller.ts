import type { ExtensionContext } from "@super-pi/coding-agent";
import { exportStoredPlan, planExportDestination } from "./plan-export.ts";
import { configuredPlanExportPath, type PlanModeSettings } from "./settings.ts";
import type { PlanModeState } from "./state.ts";

interface PlanExportControllerOptions {
	getState(): PlanModeState;
	getSettings(): PlanModeSettings;
	finishReady(ctx: ExtensionContext): void | Promise<void>;
	trackWrite<T>(run: () => Promise<T>): Promise<T>;
}

export function createPlanExportController(options: PlanExportControllerOptions) {
	return {
		export(
			path: string | undefined,
			ctx: ExtensionContext,
			signal: AbortSignal,
			isCurrent: () => boolean,
		) {
			const state = options.getState();
			return exportStoredPlan(
				state,
				path,
				ctx,
				{
					signal,
					isCurrent,
					getState: options.getState,
					finishReady: () => options.finishReady(ctx),
					trackWrite: options.trackWrite,
				},
				configuredPlanExportPath(options.getSettings()),
			);
		},
		getDestination(ctx: ExtensionContext) {
			return planExportDestination(configuredPlanExportPath(options.getSettings()), ctx.cwd);
		},
	};
}
