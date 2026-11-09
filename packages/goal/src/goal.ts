import type { ExtensionAPI } from "@super-pi/coding-agent";
import { registerGoalCommand } from "./command-registration.ts";
import { GoalCommandController } from "./commands.ts";
import { registerGoalLifecycle } from "./lifecycle.ts";
import { GoalRunController } from "./run-protocol.ts";
import { GoalRuntime } from "./runtime.ts";
import { registerGoalTools } from "./tools.ts";

interface GoalOptions {
	settingsPath?: string;
}

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
	const runtime = new GoalRuntime(pi);
	const commands = new GoalCommandController(runtime);
	const runController = new GoalRunController(runtime, commands);

	// Keep registration order explicit: managed-run bus listeners exist before tools,
	// command routing, and session lifecycle bind the per-factory runtime.
	runController.register(pi);
	registerGoalTools(pi, runtime);
	registerGoalCommand(pi, runtime, commands, options);
	registerGoalLifecycle(pi, runtime, commands, runController, options);
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
	registerGoalRuntime(pi, options);
}

export {
	assistantUsageTokens,
	cumulativeAssistantTokens,
	formatDuration,
	formatTokenCount,
} from "./accounting.ts";

export {
	completeGoalArguments,
	parseCommand,
	parseTokenBudget,
	validateObjective,
} from "./command.ts";

export { buildGoalSystemPrompt } from "./prompts.ts";

export {
	findFinalAssistantMessage,
	formatStatus,
	isContradictoryCompletionSummary,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
} from "./runtime.ts";
