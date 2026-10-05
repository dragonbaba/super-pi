import { getProtectedWriteExecute } from "./write.ts";
import type { AgentTool, AgentToolExecutionContext } from "@super-pi/agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	const protectedExecute = getProtectedWriteExecute(definition);
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments && ctxFactory
			? (args) => definition.prepareArguments!(args, ctxFactory())
			: definition.prepareArguments,
		validateInput: definition.validateInput,
		interactionBoundary: definition.interactionBoundary,
		orchestration: definition.orchestration,
		modelOnly: definition.modelOnly,
		modelExposure: definition.modelExposure,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, context?: AgentToolExecutionContext | ExtensionContext) => {
			const nested = context && "callTool" in context ? context : undefined;
			const ctx = context && !nested ? context as ExtensionContext : ctxFactory?.() as ExtensionContext;
			return (protectedExecute ?? definition.execute).call(definition, toolCallId, params, signal, onUpdate, ctx, nested);
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		validateInput: tool.validateInput,
		interactionBoundary: tool.interactionBoundary,
		orchestration: tool.orchestration,
		modelOnly: tool.modelOnly,
		modelExposure: tool.modelExposure,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate, _ctx, executionContext) => tool.execute(toolCallId, params, signal, onUpdate, executionContext),
	};
}
