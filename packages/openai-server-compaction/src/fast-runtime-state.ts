export const FAST_RUNTIME_STATE_SYMBOL_KEY = "pi.openai-fast-mode.runtime-state.v2";

const FAST_RUNTIME_STATE_SYMBOL = Symbol.for(FAST_RUNTIME_STATE_SYMBOL_KEY);

type FastRuntimeStateContract = {
  schemaVersion?: unknown;
  sessionId?: unknown;
  enabled?: unknown;
};

export function isFastRuntimeEnabled(sessionId: string, source: object = globalThis): boolean {
  const value = Reflect.get(source, FAST_RUNTIME_STATE_SYMBOL) as unknown;
  if (!value || typeof value !== "object") return false;
  const registry = value as { schemaVersion?: unknown; sessions?: unknown };
  if (registry.schemaVersion !== 2 || !(registry.sessions instanceof Map)) return false;
  const state = registry.sessions.get(sessionId) as FastRuntimeStateContract | undefined;
  return state?.schemaVersion === 1 && state.sessionId === sessionId && state.enabled === true;
}
