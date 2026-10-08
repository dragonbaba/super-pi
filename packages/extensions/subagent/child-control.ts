import type { Message } from "@super-pi/ai";
import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { checkpointMessage } from "./checkpoints.ts";
import { decodeControl, encodeControl } from "./control.ts";

/** One outstanding intercepting request; no IPC traffic on provider deltas or tool progress. */
export class ChildControl {
	private sequence = 0;
	private resolve: ((packet: any) => void) | undefined;
	private reject: ((error: Error) => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private failure: Error | undefined;
	private context: ExtensionContext | undefined;
	private readonly messageListener = this.onMessage.bind(this);
	private readonly disconnectListener = this.onDisconnect.bind(this);
	private readonly sendCallback = this.onSend.bind(this);
	seed: Message[] = [];
	guidance = "";
	checkpoint = false;
	turnPending = false;
	constructor() {
		process.on("message", this.messageListener); process.on("disconnect", this.disconnectListener);
	}
	async initialize(ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		const packet = await this.request("ready");
		if (!Array.isArray(packet.messages) || packet.messages.length > 128 || typeof packet.guidance !== "string") throw new Error("Invalid subagent initialization.");
		this.seed = packet.messages; this.guidance = packet.guidance; this.checkpoint = packet.checkpoint === true;
	}
	request(kind: string, fields?: Record<string, unknown>): Promise<any> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.resolve) return Promise.reject(new Error("A subagent control request is already pending."));
		const encoded = encodeControl({ id: ++this.sequence, kind, ...fields });
		return new Promise((resolve, reject) => {
			this.resolve = resolve; this.reject = reject;
			this.timer = setTimeout(ChildControl.onTimeout, 30_000, this);
			try {
				if (!process.connected || !process.send) throw new Error("Subagent parent control is unavailable.");
				process.send(encoded, this.sendCallback);
			} catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
		});
	}
	assertActive(): void { if (this.failure) throw this.failure; }
	private clearPending(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.resolve = undefined; this.reject = undefined; }
	private static onTimeout(owner: ChildControl): void { owner.stop(new Error("Subagent control timed out after 30000ms; no further work is permitted.")); }
	private onSend(error: Error | null): void { if (error) this.stop(error); }
	private onDisconnect(): void { this.stop(new Error("Subagent parent disconnected; stopping owned work.")); }
	private onMessage(raw: unknown): void {
		try {
			const packet = decodeControl(raw);
			if (!this.resolve || packet.id !== this.sequence || typeof packet.ok !== "boolean") throw new Error("Invalid subagent control reply.");
			const resolve = this.resolve, reject = this.reject!; this.clearPending();
			if (packet.ok) resolve(packet);
			else reject(new Error(typeof packet.reason === "string" ? packet.reason : "Subagent request denied."));
		} catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
	}
	stop(error: Error, notifyParent = true): void {
		if (!this.failure && notifyParent && process.connected && process.send) {
			// Fatal boundary only; the parent must not mistake an unsaved final turn for success.
			try { process.send(encodeControl({ id: ++this.sequence, kind: "failure", reason: error.message.slice(0, 1024) }), this.sendCallback); } catch { /* Parent close is already handled below. */ }
		}
		this.failure ??= error;
		const reject = this.reject; this.clearPending(); reject?.(this.failure);
		this.context?.abort();
	}
	dispose(): void {
		this.stop(new Error("Subagent control closed."), false);
		process.off("message", this.messageListener); process.off("disconnect", this.disconnectListener);
		this.seed = []; this.context = undefined; this.guidance = "";
		if (process.connected) process.disconnect();
	}
}

export function installChildControl(pi: ExtensionAPI): void {
	if (process.env.SP_SUBAGENT_CONTROL !== "1") return;
	const control = new ChildControl();
	pi.on("session_start", async (_event, ctx) => {
		try { await control.initialize(ctx); }
		catch (error) { control.stop(error instanceof Error ? error : new Error(String(error))); }
	});
	pi.on("before_agent_start", event => control.seed.length || control.guidance ? { systemPrompt: `${event.systemPrompt}\n\n${control.guidance}\nCheckpoint continuation is historical context, not fresh evidence. Inspect current files before repeating any operation.` } : undefined);
	pi.on("context", event => control.seed.length ? { messages: [...control.seed, ...event.messages] } : undefined);
	pi.on("turn_start", async () => {
		try {
			control.assertActive();
			if (control.checkpoint) { await control.request("begin"); control.turnPending = true; }
		} catch (error) { control.stop(error instanceof Error ? error : new Error(String(error))); }
	});
	pi.on("turn_end", async event => {
		if (!control.turnPending) return;
		try {
			const complete = event.message.role === "assistant" && event.message.stopReason !== "error" && event.message.stopReason !== "aborted";
			const fields: Record<string, unknown> = { completed: complete };
			if (control.checkpoint && complete) {
				fields.message = checkpointMessage(event.message);
				const results: Message[] = [];
				for (const result of event.toolResults) results.push(checkpointMessage(result));
				fields.results = results;
			}
			await control.request("turn", fields);
		} catch (error) { control.stop(error instanceof Error ? error : new Error(String(error))); }
		finally { control.turnPending = false; }
	});
	pi.on("session_shutdown", () => { control.dispose(); });
}
