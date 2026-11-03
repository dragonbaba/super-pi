import type { StreamFn } from "@super-pi/agent-core";
import type { Context, Model, SimpleStreamOptions } from "@super-pi/ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { OpenAICodexDispatch, SupplementalSummaryHookScope } from "./extensions/types.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";

export interface SupplementalSummaryDependencies {
  runtime: ModelRuntime;
  settings: SettingsManager;
  runner: ExtensionRunner;
  codex: OpenAICodexDispatch;
  codexGeneration: number;
  sessionId: string;
  assertCurrent(): void;
  customStream?: StreamFn;
}

/** One low-frequency callback scope; no delta observer, transport cache or ordinary-state writer. */
export class SupplementalSummaryScope {
  private dependencies: SupplementalSummaryDependencies | undefined;
  private pending: Promise<void> | undefined;
  private resolvePending: (() => void) | undefined;
  private readonly cancellation = new AbortController();
  private readonly signal: AbortSignal;
  private failed = false;
  private failure: unknown;

  constructor(dependencies: SupplementalSummaryDependencies, signal: AbortSignal) {
    this.dependencies = dependencies;
    this.signal = AbortSignal.any([signal, this.cancellation.signal]);
  }

  readonly assertCurrent = (): void => {
    if (!this.dependencies) throw new Error("Supplemental summary scope is closed");
    this.signal.throwIfAborted();
    if (this.failed) throw this.failure;
    this.dependencies.assertCurrent();
  };

  private readonly finishRequest = (failed = false, error?: unknown): void => {
    if (failed) { this.failed = true; this.failure = error; }
    this.resolvePending?.();
    this.resolvePending = undefined;
    this.pending = undefined;
  };

  readonly stream: StreamFn = async (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
    this.assertCurrent();
    if (this.pending) throw new Error("Supplemental summary scope already has an unfinished request");
    const state = this.dependencies!;
    const requestSignal = options?.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    const assertRequestCurrent = () => { this.assertCurrent(); requestSignal.throwIfAborted(); };
    assertRequestCurrent();
    const auth = { model, apiKey: options?.apiKey, headers: options?.headers, env: options?.env };
    const scope: SupplementalSummaryHookScope = { purpose: "supplemental-summary", model, assertCurrent: assertRequestCurrent };
    const retry = state.settings.getProviderRetrySettings();
    const idle = state.settings.getHttpIdleTimeoutMs();
    const settled = this.pending = new Promise<void>(resolve => { this.resolvePending = resolve; });
    let output;
    try { output = state.runtime.streamSimple(model, context, {
      ...options,
      signal: requestSignal,
      sessionId: state.sessionId,
      cacheRetention: "none",
      transport: "sse",
      codexRemoteCompaction: false,
      timeoutMs: retry.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
      maxRetries: retry.maxRetries,
      maxRetryDelayMs: retry.maxRetryDelayMs,
      // Summary instrumentation must not update the ordinary prefix/tool-budget baseline.
      onEffectiveDispatch: undefined,
      transformHeaders: async headers => {
        assertRequestCurrent();
        try {
          const prepared = mergeProviderAttributionHeaders(model, state.settings, state.sessionId, headers) ?? {};
          const result = await state.runner.emitBeforeProviderHeaders(prepared, scope);
          assertRequestCurrent();
          return result;
        } catch (error) { this.failed = true; this.failure = error; throw error; }
      },
      onPayload: async (payload, effectiveModel, prepared) => {
        assertRequestCurrent();
        try {
          const result = await state.runner.emitBeforeProviderRequest(payload, false,
            { model: effectiveModel, apiKey: prepared?.apiKey, headers: prepared?.headers, env: prepared?.env }, scope);
          assertRequestCurrent();
          if (result && typeof result === "object" && "previous_response_id" in result && result.previous_response_id !== undefined) {
            throw new Error("Supplemental summaries cannot use a previous response ID");
          }
          return result;
        } catch (error) { this.failed = true; this.failure = error; throw error; }
      },
      onResponse: undefined,
    }, { auth, assertCurrent: assertRequestCurrent, onStreamSettled: this.finishRequest }, undefined, state.codex, state.codexGeneration, state.customStream);
    } catch (error) { this.finishRequest(); throw error; }
    // Summaries consume complete results. Joining here also serializes algorithm fallback.
    await settled;
    assertRequestCurrent();
    return output;
  };

  async run<T>(callback: (stream: StreamFn) => Promise<T>): Promise<T> {
    try {
      this.assertCurrent();
      const result = await callback(this.stream);
      this.assertCurrent();
      return result;
    } finally {
      this.cancellation.abort();
      try {
        await this.pending;
        if (this.failed) throw this.failure;
        this.dependencies?.assertCurrent();
      }
      finally { this.dependencies = undefined; this.failure = undefined; }
    }
  }
}
