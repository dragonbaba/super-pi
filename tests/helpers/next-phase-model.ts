// Production-free fixture: importing this module must never load either checkout's SDK/TUI.
export const ALPHA_MODEL = { id: "alpha-fixture", name: "alpha-fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
export function alphaModelRuntime(streamSimple: (...args: any[]) => any): any {
  return { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), getAuth: async () => undefined,
    isUsingOAuth: () => false, isUsingSubscription: () => false, getAvailableSnapshot: () => [ALPHA_MODEL],
    getAvailable: async () => [ALPHA_MODEL], getError: () => undefined,
    registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {}, getModel: () => ALPHA_MODEL, streamSimple };
}

/** Test-only adapter for native protocol/schema-cost fixtures. No SDK import:
 * cross-checkout measurements must load production code only from their target.
 * Default Codemode acceptance tests use the unmodified SDK. */
export function exposeNativeProtocolForFixture(session: any): void {
  const original = session.setActiveToolsByName.bind(session);
  const all = session.getAllTools.bind(session);
  session.getAllTools = () => all().filter((tool: any) => tool.name !== "codemode");
  function expose(): void {
    const tools = [];
    for (const tool of session.agent.state.tools) if (tool.name !== "codemode") {
      tool.modelExposure = undefined;
      tools.push(tool);
    }
    session.agent.state.tools = tools;
  }
  session.setActiveToolsByName = (names: string[]) => { original(names); expose(); };
  expose();
}
