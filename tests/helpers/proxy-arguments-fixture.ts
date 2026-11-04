import { registerHooks } from "node:module";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall } from "../../packages/ai/src/types.ts";
import type { EventStream } from "../../packages/ai/src/utils/event-stream.ts";
import type { ProxyAssistantMessageEvent, ProxyStreamOptions } from "../../packages/agent/src/proxy.ts";

// Source benchmark/test graph: proxy and parser must share the same AI module instance.
const aiUrl = new URL("../../packages/ai/src/index.ts", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier === "@super-pi/ai" ? aiUrl : specifier, context); } });
const { streamProxy } = await import("../../packages/agent/src/proxy.ts");
export const proxyModel: Model<"anthropic-messages"> = { id: "proxy-fixture", name: "fixture", api: "anthropic-messages", provider: "fixture",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
export const proxyUsage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export function proxyStart(index = 0): ProxyAssistantMessageEvent { return { type: "toolcall_start", contentIndex: index, id: "tool-" + index, toolName: "fixture" }; }
export function proxyDelta(delta: string, index = 0): ProxyAssistantMessageEvent { return { type: "toolcall_delta", contentIndex: index, delta }; }
export function proxyEnd(args: Record<string, unknown>, index = 0): ProxyAssistantMessageEvent {
  return { type: "toolcall_end", contentIndex: index, toolCall: { type: "toolCall", id: "final-" + index, name: "fixture", arguments: args,
    namespace: "fixture-ns", thoughtSignature: "fixture-signature" } };
}
export function proxyDone(reason: "stop" | "toolUse" | "length" = "toolUse"): ProxyAssistantMessageEvent { return { type: "done", reason, usage: proxyUsage }; }

export function proxyEventsFixture(events: readonly ProxyAssistantMessageEvent[], options: { chunkBytes?: number; failAfter?: number; keepOpen?: boolean; separator?: string; afterFrame?: (index: number) => void | Promise<void> } = {}) {
  const encoder = new TextEncoder(), wire = events.map(event => encoder.encode("data: " + JSON.stringify(event) + (options.separator ?? "\n\n")));
  const originalFetch = globalThis.fetch;
  let index = 0, offset = 0, reads = 0, cancellations = 0, closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(control) { controller = control; },
    pull(control) {
      reads++;
      if (options.failAfter !== undefined && index >= options.failAfter) { closed = true; control.error(new Error("proxy fixture transport error")); return; }
      if (index === wire.length) { if (!options.keepOpen) { closed = true; control.close(); } return; }
      const frame = wire[index]!;
      const end = Math.min(frame.length, offset + (options.chunkBytes ?? frame.length));
      control.enqueue(frame.subarray(offset, end)); offset = end;
      if (offset === frame.length) { index++; offset = 0; return options.afterFrame?.(index - 1); }
    },
    cancel() { cancellations++; closed = true; },
  });
  const fetchFixture: typeof fetch = async (_url, init) => {
    if (init?.signal?.aborted) throw new Error("fixture request already aborted");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  return {
    start(signal?: AbortSignal, context: Context = { messages: [] }, extra?: Partial<ProxyStreamOptions>): EventStream<AssistantMessageEvent, AssistantMessage> {
      globalThis.fetch = fetchFixture;
      return streamProxy(proxyModel, context, { proxyUrl: "https://proxy-fixture.invalid", authToken: "synthetic", ...extra, signal });
    },
    stats() { return { reads, cancellations, locked: body.locked, closed }; },
    release() { globalThis.fetch = originalFetch; if (!closed) { controller!.close(); closed = true; } wire.length = 0; controller = undefined; },
  };
}

export function proxyArgumentsFixture(inputs: readonly string[], chunkSize = 64, failAfter?: number) {
  const events: ProxyAssistantMessageEvent[] = [{ type: "start" }];
  for (let index = 0; index < inputs.length; index++) events.push(proxyStart(index));
  const maximum = Math.max(...inputs.map(input => input.length));
  for (let offset = 0; offset < maximum; offset += chunkSize) for (let index = 0; index < inputs.length; index++) {
    if (offset < inputs[index]!.length) events.push(proxyDelta(inputs[index]!.slice(offset, offset + chunkSize), index));
  }
  for (let index = 0; index < inputs.length; index++) events.push(proxyEnd(JSON.parse(inputs[index]!) as ToolCall["arguments"], index));
  events.push(proxyDone());
  return proxyEventsFixture(events, { failAfter });
}
