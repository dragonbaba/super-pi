export const FAST_RUNTIME_STATE_SYMBOL_KEY = "pi.openai-fast-mode.runtime-state.v2";

const FAST_RUNTIME_STATE_SYMBOL = Symbol.for(FAST_RUNTIME_STATE_SYMBOL_KEY);

export interface FastRuntimeState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  enabled: boolean;
  revision: number;
}

interface FastRuntimeStateRegistry {
  readonly schemaVersion: 2;
  readonly sessions: Map<string, FastRuntimeState>;
}

function isFastRuntimeState(value: unknown): value is FastRuntimeState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FastRuntimeState>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    typeof candidate.enabled === "boolean" &&
    Number.isSafeInteger(candidate.revision) &&
    (candidate.revision ?? -1) >= 0
  );
}

function readRegistry(source: object = globalThis): FastRuntimeStateRegistry | undefined {
  const value = Reflect.get(source, FAST_RUNTIME_STATE_SYMBOL) as unknown;
  if (!value || typeof value !== "object") return undefined;
  const registry = value as Partial<FastRuntimeStateRegistry>;
  return registry.schemaVersion === 2 && registry.sessions instanceof Map
    ? registry as FastRuntimeStateRegistry
    : undefined;
}

function getOrCreateRegistry(): FastRuntimeStateRegistry {
  const current = readRegistry();
  if (current) return current;
  const registry: FastRuntimeStateRegistry = { schemaVersion: 2, sessions: new Map() };
  Reflect.set(globalThis, FAST_RUNTIME_STATE_SYMBOL, registry);
  return registry;
}

export function publishFastRuntimeState(sessionId: string, enabled: boolean): FastRuntimeState {
  const state: FastRuntimeState = { schemaVersion: 1, sessionId, enabled, revision: 0 };
  getOrCreateRegistry().sessions.set(sessionId, state);
  return state;
}

export function readFastRuntimeState(sessionId: string, source: object = globalThis): FastRuntimeState | undefined {
  const state = readRegistry(source)?.sessions.get(sessionId);
  return isFastRuntimeState(state) ? state : undefined;
}

export function updateFastRuntimeState(state: FastRuntimeState, enabled: boolean): void {
  state.enabled = enabled;
  state.revision++;
}

export function clearFastRuntimeState(state: FastRuntimeState): boolean {
  const registry = readRegistry();
  if (!registry || registry.sessions.get(state.sessionId) !== state) return false;
  registry.sessions.delete(state.sessionId);
  if (registry.sessions.size === 0) Reflect.deleteProperty(globalThis, FAST_RUNTIME_STATE_SYMBOL);
  return true;
}
