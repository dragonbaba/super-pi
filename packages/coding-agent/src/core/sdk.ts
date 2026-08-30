import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@super-pi/agent-core";
import type { EffectiveDispatchObservation } from "@super-pi/ai";
import {
	buildOpenAICodexRequestBody,
	compactOpenAICodexRequest,
} from "@super-pi/ai/api/openai-codex-responses";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@super-pi/ai/compat";
import { getAgentDir, getConfigDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type {
	ExtensionRunner,
	ExtensionRunnerOptions,
	LoadExtensionsResult,
	SessionStartEvent,
	ToolDefinition,
} from "./extensions/index.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { initializePowerShellPersistence } from "./powershell-persistence.ts";
import {
	buildPrefixManifest,
	createScopedContextIdentifier,
	PrefixManifestRecorder,
} from "./prefix-manifest.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	getDefaultToolNames,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";
import type { ToolOutputShadowOptions } from "./tool-output-budget.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.sp/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to agentDir/config/auth.json and agentDir/config/models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, PowerShell on Windows, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, Super Pi uses `defaultTools` for the initial built-in selection
	 * when configured. Otherwise it enables read, bash, PowerShell on Windows,
	 * edit, and write. Extension/custom tools remain enabled unless `noTools`
	 * changes that default. When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional host policy for extension observer diagnostics and hook timeouts. */
	extensionRunnerOptions?: ExtensionRunnerOptions;
	/** Optional manifest recorder. Defaults to a session-local recorder. */
	prefixManifestRecorder?: PrefixManifestRecorder;
	/** Optional Phase 5A metadata-only tool-output observation. Disabled unless explicitly enabled. */
	toolOutputShadow?: ToolOutputShadowOptions;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRunnerOptions,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

const BLOCKED_IMAGE_MESSAGE = "Image reading is disabled.";

function isBlockedImagePlaceholder(content: { type: string; text?: string }): boolean {
	return content.type === "text" && content.text === BLOCKED_IMAGE_MESSAGE;
}

function replaceBlockedImages(message: Message): Message {
	if (message.role !== "user" && message.role !== "toolResult") return message;
	const content = message.content;
	if (!Array.isArray(content)) return message;
	let firstImageIndex = -1;
	for (let index = 0; index < content.length; index++) {
		if (content[index]?.type !== "image") continue;
		firstImageIndex = index;
		break;
	}
	if (firstImageIndex < 0) return message;

	const filteredContent: typeof content = [];
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		const next = block.type === "image" ? ({ type: "text", text: BLOCKED_IMAGE_MESSAGE } as const) : block;
		const previous = filteredContent[filteredContent.length - 1];
		if (isBlockedImagePlaceholder(next) && previous && isBlockedImagePlaceholder(previous)) continue;
		filteredContent.push(next);
	}
	return { ...message, content: filteredContent };
}

function replaceBlockedImagesInMessages(messages: Message[]): Message[] {
	let result = messages;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const next = replaceBlockedImages(message);
		if (next === message) continue;
		if (result === messages) result = messages.slice();
		result[index] = next;
	}
	return result;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@super-pi/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(getConfigDir(agentDir), "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(getConfigDir(agentDir), "models.json") : undefined;
	const modelsStorePath = options.agentDir ? join(agentDir, "models-store.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath, modelsStorePath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to the selected model's override, then the global default.
	if (thinkingLevel === undefined && model) {
		thinkingLevel = settingsManager.getModelThinkingLevel(model.provider, model.id);
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = getDefaultToolNames();
	const configuredDefaultToolNames = settingsManager.getDefaultTools();
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const requestedActiveToolNames = options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames));
	const powerShellRequested =
		requestedActiveToolNames.includes("powershell") && !excludedToolNameSet?.has("powershell");
	const powerShellExplicitlyEnabled = powerShellRequested && options.tools?.includes("powershell") === true;
	let powerShellAvailable = process.platform === "win32";
	if (powerShellRequested && process.platform === "win32") {
		powerShellAvailable = await initializePowerShellPersistence(settingsManager, {
			forceEnable: powerShellExplicitlyEnabled,
		});
	}
	const initialActiveToolNames: string[] = [];
	for (const name of requestedActiveToolNames) {
		if (excludedToolNameSet?.has(name)) continue;
		if (name === "powershell" && !powerShellAvailable) continue;
		initialActiveToolNames.push(name);
	}

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		return settingsManager.getBlockImages() ? replaceBlockedImagesInMessages(converted) : converted;
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const prefixManifestRecorder = options.prefixManifestRecorder ?? new PrefixManifestRecorder();

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const headerRunner = extensionRunnerRef.current;
			const configuredTransport = options?.transport ?? settingsManager.getTransport();
			const requestTransformChain = headerRunner?.getHandlerChainIdentifiers([
				"context",
				"before_provider_headers",
				"before_provider_request",
			]) ?? [];
			const persistentContext = resourceLoader.getAgentsFiles().agentsFiles.map((file, index) => ({
				identifier: createScopedContextIdentifier(file.path, { workspaceRoot: cwd, globalRoot: agentDir }),
				content: file.content,
				precedence: index,
			}));
			const manifestInput = {
				provider: model.provider,
				model: model.id,
				api: model.api,
				transport: configuredTransport,
				cacheRetention: options?.cacheRetention,
				systemPrompt: context.systemPrompt ?? "",
				tools: (context.tools ?? []).map((tool) => ({ name: tool.name, schema: tool.parameters })),
				persistentContext,
				requestTransformChain,
				cacheKey: options?.sessionId,
				previousResponseMode: configuredTransport.startsWith("websocket") ? "websocket" as const : "none" as const,
			};
			try {
				prefixManifestRecorder.recordIntent(buildPrefixManifest(manifestInput));
			} catch {
				// Prefix intent diagnostics are observational and must never block a provider request.
			}
			const recordEffectiveDispatch = (observation: Readonly<EffectiveDispatchObservation>, observedModel: Model<any>) => {
				try {
					prefixManifestRecorder.record(buildPrefixManifest({
						...manifestInput,
						provider: observedModel.provider,
						model: observedModel.id,
						api: observedModel.api,
						effectiveDispatch: observation,
					}));
				} catch {
					// Effective dispatch diagnostics are observational and must never block a provider request.
				}
				try {
					const result = options?.onEffectiveDispatch?.(observation, observedModel);
					if (result && typeof result.then === "function") {
						void Promise.resolve(result).catch(() => undefined);
					}
				} catch {
					// A nested observer cannot escape the provider-owned instrumentation lane.
				}
			};
			return modelRuntime.streamSimple(model, context, {
				...options,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				onEffectiveDispatch: recordEffectiveDispatch,
				transformHeaders: async (requestHeaders) => {
					const headers = mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						requestHeaders,
					);
					return headerRunner?.hasHandlers("before_provider_headers")
						? headerRunner.emitBeforeProviderHeaders(headers ?? {})
						: (headers ?? {});
				},
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		prefixManifestRecorder,
		providerRequestPayloadBuilder: ({ model, systemPrompt, messages, tools, thinkingLevel, sessionId }) => {
			if (model.api !== "openai-codex-responses") return undefined;
			return buildOpenAICodexRequestBody(
				model,
				{ systemPrompt, messages: convertToLlmWithBlockImages(messages), tools },
				{ reasoningEffort: thinkingLevel === "off" ? undefined : thinkingLevel },
				sessionId,
			);
		},
		providerRequestCompactor: async ({
			model, apiKey, headers, env, sessionId, regularPayload, signal, shapeDiagnostics,
		}) => {
			if (model.api !== "openai-codex-responses") return undefined;
			let requestHeaders = mergeProviderAttributionHeaders(model, settingsManager, sessionId, headers);
			const runner = extensionRunnerRef.current;
			if (runner?.hasHandlers("before_provider_headers")) {
				requestHeaders = await runner.emitBeforeProviderHeaders(requestHeaders ?? {});
			}
			const configuredTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			const timeoutMs = configuredTimeoutMs === 0 ? 2147483647 : configuredTimeoutMs;
			const result = await compactOpenAICodexRequest(model, regularPayload, {
				apiKey,
				headers: requestHeaders,
				env,
				sessionId,
				signal,
				timeoutMs,
				shapeDiagnostics,
				onResponse: async (response: { status: number; headers: Record<string, string> }) => {
					if (!runner?.hasHandlers("after_provider_response")) return;
					await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
				},
			});
			return {
				compactionItem: result.compactionItem,
				usage: result.usage,
				...(result.diagnostics ? { diagnostics: { ...result.diagnostics } } : {}),
			};
		},
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		extensionRunnerOptions: options.extensionRunnerOptions,
		sessionStartEvent: options.sessionStartEvent,
		toolOutputShadow: options.toolOutputShadow,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
