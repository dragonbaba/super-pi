import { stream as streamPiMessages } from "../../packages/ai/src/api/pi-messages.ts";
import { piMessagesArgumentsModel, piMessagesUsage } from "./pi-messages-arguments-fixture.ts";

/** A large authoritative tool-end event fragmented across reads; no argument deltas. */
export function piMessagesWireFixture(input: string, chunkBytes: number) {
	const events = [
		{ type: "toolcall_start", contentIndex: 0, id: "tool", toolName: "fixture" },
		{ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "tool", name: "fixture", arguments: JSON.parse(input) } },
		{ type: "done", reason: "toolUse", usage: piMessagesUsage },
	];
	const wire = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
	const bytes = new TextEncoder().encode(wire), chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.length; offset += chunkBytes) chunks.push(bytes.slice(offset, offset + chunkBytes));
	const decodedChunks = new Set(chunks.map(chunk => new TextDecoder().decode(chunk)));
	let body: ReadableStream<Uint8Array> | undefined, cancelled = false;
	return {
		wireCodeUnits: wire.length, readChunks: chunks.length, decodedChunks,
		start(factory: typeof streamPiMessages = streamPiMessages) {
			let cursor = 0; cancelled = false;
			body = new ReadableStream<Uint8Array>({ pull(controller) {
				if (cursor < chunks.length) controller.enqueue(chunks[cursor++]); else controller.close();
			}, cancel() { cancelled = true; } }, { highWaterMark: 0 });
			return factory(piMessagesArgumentsModel, { messages: [] }, { apiKey: "fixture", fetch: async () => new Response(body) });
		},
		inspect() { return { cancelled, locked: body?.locked }; },
		release() { chunks.length = 0; decodedChunks.clear(); body = undefined; },
	};
}
