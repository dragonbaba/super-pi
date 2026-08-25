export function createExtensionHarness() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const api = {
    on(name, handler) {
      const eventHandlers = handlers.get(name) ?? [];
      eventHandlers.push(handler);
      handlers.set(name, eventHandlers);
      return () => {
        const index = eventHandlers.indexOf(handler);
        if (index >= 0) eventHandlers.splice(index, 1);
      };
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
  return { api, handlers, tools, commands };
}

export async function emitAll(harness, name, event, context) {
  for (const handler of harness.handlers.get(name) ?? []) await handler(event, context);
}
