import type { Message } from "@super-pi/ai";
import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { checkpointMessage, CheckpointCapacityError, CHECKPOINT_BYTES, CHECKPOINT_MESSAGES, CHECKPOINT_PLANNING } from "./checkpoints.ts";
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
	handoff = false;
	checkpointFrozen = false;
	checkpointBytes = 0;
	checkpointMessages = 0;
	constructor() {
		process.on("message", this.messageListener); process.on("disconnect", this.disconnectListener);
	}
	async initialize(ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		const packet = await this.request("ready");
		if (!Array.isArray(packet.messages) || packet.messages.length > 128 || typeof packet.guidance !== "string") throw new Error("Invalid subagent initialization.");
		this.seed = packet.messages; this.guidance = packet.guidance; this.checkpoint = packet.checkpoint === true;
		this.updateStatus(packet);
	}
	updateStatus(packet: any): boolean {
		if (!this.checkpoint) return false;
		if (!Number.isSafeInteger(packet.checkpointBytes) || packet.checkpointBytes < 0 || packet.checkpointBytes > CHECKPOINT_BYTES
			|| !Number.isSafeInteger(packet.checkpointMessages) || packet.checkpointMessages < 1 || packet.checkpointMessages > CHECKPOINT_MESSAGES
			|| typeof packet.handoff !== "boolean" || typeof packet.checkpointFrozen !== "boolean") throw new Error("Invalid checkpoint capacity update.");
		const newlyRequested = packet.handoff && !this.handoff;
		this.checkpointBytes = packet.checkpointBytes; this.checkpointMessages = packet.checkpointMessages;
		this.handoff ||= packet.handoff; this.checkpointFrozen ||= packet.checkpointFrozen;
		return newlyRequested;
	}
	capacityNotice(): string {
		return `Checkpoint capacity: ${this.checkpointBytes}/${CHECKPOINT_BYTES} bytes, ${this.checkpointMessages}/${CHECKPOINT_MESSAGES} messages; remaining ${CHECKPOINT_BYTES - this.checkpointBytes} bytes and ${CHECKPOINT_MESSAGES - this.checkpointMessages} messages. ${this.handoff
			? `HANDOFF NOW: tools are disabled. Return a concise text summary of completed work, evidence/verification, changed files, remaining work and the next bounded assignment. Do not claim the whole objective is complete. ${this.checkpointFrozen ? "The latest turn was not saved; the last valid checkpoint remains. Report possible effects and require inspection before retrying." : "Reserve the remaining space for this summary."}`
			: "Keep this phase small, bound tool output and leave room for a handoff; do not wait for the hard limit."}`;
	}
	request(kind: string, fields?: Record<string, unknown>): Promise<any> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.resolve) return Promise.reject(new Error("A subagent control request is already pending."));
		const encoded = encodeControl({ id: this.sequence + 1, kind, ...fields });
		this.sequence++;
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
		try { await control.initialize(ctx); if (control.handoff) pi.setActiveTools([]); }
		catch (error) { control.stop(error instanceof Error ? error : new Error(String(error))); }
	});
	pi.on("before_agent_start", event => control.checkpoint || control.guidance ? { systemPrompt: `${event.systemPrompt}\n\n${control.guidance}${control.checkpoint ? `\n${CHECKPOINT_PLANNING}\n${control.capacityNotice()}` : ""}${control.seed.length ? "\nCheckpoint continuation is historical context, not fresh evidence. Inspect current files before repeating any operation." : ""}` } : undefined);
	pi.on("context", event => {
		if (!control.checkpoint && !control.seed.length) return;
		const messages = [...control.seed, ...event.messages];
		if (control.checkpoint) messages.push({ role: "user", content: control.capacityNotice(), timestamp: Date.now() });
		return { messages };
	});
	pi.on("tool_call", () => control.handoff ? { block: true, reason: "Checkpoint handoff is required. Return the text summary now; no further tools may run." } : undefined);
	pi.on("turn_start", async () => {
		try {
			control.assertActive();
			if (control.checkpoint) { updateChildStatus(control, pi, await control.request("begin")); control.turnPending = true; }
		} catch (error) { control.stop(error instanceof Error ? error : new Error(String(error))); }
	});
	pi.on("turn_end", async event => {
		if (!control.turnPending) return;
		let newHandoff = false;
		try {
			const complete = event.message.role === "assistant" && event.message.stopReason !== "error" && event.message.stopReason !== "aborted";
			const fields: Record<string, unknown> = { completed: complete };
			if (control.checkpoint && complete) {
				fields.message = checkpointMessage(event.message);
				const results: Message[] = [];
				for (const result of event.toolResults) results.push(checkpointMessage(result));
				fields.results = results;
			}
			newHandoff = updateChildStatus(control, pi, await control.request("turn", fields));
		} catch (error) {
			if (error instanceof CheckpointCapacityError) {
				try { newHandoff = updateChildStatus(control, pi, await control.request("handoff")); }
				catch (failure) { control.stop(failure instanceof Error ? failure : new Error(String(failure))); }
			} else control.stop(error instanceof Error ? error : new Error(String(error)));
		}
		finally { control.turnPending = false; }
		if (newHandoff) {
			// A final text response would otherwise end the loop before it sees the notice.
			let toolCalls = false;
			if (event.message.role === "assistant") for (const part of event.message.content) if (part.type === "toolCall") toolCalls = true;
			if (!toolCalls) pi.sendMessage({ customType: "subagent-checkpoint-handoff", content: control.capacityNotice(), display: false }, { deliverAs: "followUp", triggerTurn: true });
		}
	});
	pi.on("session_shutdown", () => { control.dispose(); });
}

function updateChildStatus(control: ChildControl, pi: ExtensionAPI, packet: unknown): boolean {
	const requested = control.updateStatus(packet);
	if (requested) pi.setActiveTools([]);
	return requested;
}
