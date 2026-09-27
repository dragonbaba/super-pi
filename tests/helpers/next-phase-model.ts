// Production-free fixture: importing this module must never load either checkout's SDK/TUI.
export const ALPHA_MODEL = { id: "alpha-fixture", name: "alpha-fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
export function alphaModelRuntime(streamSimple: (...args: any[]) => any): any {
  return { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), getAuth: async () => undefined,
    isUsingOAuth: () => false, isUsingSubscription: () => false, getAvailableSnapshot: () => [ALPHA_MODEL],
    getAvailable: async () => [ALPHA_MODEL], getError: () => undefined,
    registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {}, getModel: () => ALPHA_MODEL, streamSimple };
}
