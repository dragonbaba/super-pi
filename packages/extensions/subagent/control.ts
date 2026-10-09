import type { ChildProcess } from "node:child_process";
import type { Message } from "@super-pi/ai";
import { appendCheckpointTurn, assertCheckpointJson, CheckpointCapacityError, CHECKPOINT_HANDOFF_BYTES, CHECKPOINT_HANDOFF_MESSAGES, type TaskCheckpoint } from "./checkpoints.ts";
import type { SubagentTasks } from "./tasks.ts";

export const CONTROL_BYTES = 2 * 1024 * 1024;
export function encodeControl(value: unknown): string {
	assertCheckpointJson(value, CONTROL_BYTES);
	return JSON.stringify(value);
}
export function decodeControl(value: unknown): any {
	if (typeof value !== "string" || Buffer.byteLength(value) > CONTROL_BYTES) throw new Error("Invalid or oversized subagent control message (maximum 2 MiB).");
	const packet = JSON.parse(value);
	assertCheckpointJson(packet, CONTROL_BYTES);
	if (!packet || !Number.isSafeInteger(packet.id) || packet.id < 1) throw new Error("Invalid subagent control sequence.");
	return packet;
}

/** One IPC owner per child. Initialization and opt-in checkpoint boundaries only. */
export class SubagentControl {
	readonly counters = { received: 0, replies: 0, starts: 0, turns: 0, checkpointWrites: 0, handoffs: 0 };
	handoff = false;
	private checkpointFrozen = false;
	private checkpointBytes = 0;
	private tasks: SubagentTasks | undefined;
	private checkpoint: TaskCheckpoint | undefined;
	private seed: Message[] | undefined;
	private pendingPrompt: Message | undefined;
	private proc: ChildProcess | undefined;
	private fail: ((reason: string) => void) | undefined;
	private sequence = 0;
	private phase: "ready" | "idle" | "turn" | "closed" = "ready";
	private failed = false;
	private readonly uncertain: boolean;
	private readonly messageListener = this.onMessage.bind(this);
	private readonly sendCallback = this.onSend.bind(this);

	constructor(tasks: SubagentTasks, checkpoint?: TaskCheckpoint, seed?: Message[], uncertain = false, pendingPrompt?: Message) {
		this.tasks = tasks; this.checkpoint = checkpoint; this.seed = seed;
		this.uncertain = uncertain; this.pendingPrompt = pendingPrompt;
	}
	attach(proc: ChildProcess, fail: (reason: string) => void): void {
		if (this.proc || this.phase !== "ready") throw new Error("Subagent control already attached or closed.");
		this.proc = proc; this.fail = fail;
		proc.on("message", this.messageListener);
	}
	private save(): void {
		if (!this.checkpoint || this.checkpointFrozen) return;
		this.checkpointBytes = this.tasks!.saveCheckpoint(this.checkpoint); this.counters.checkpointWrites++;
		if (this.checkpointBytes >= CHECKPOINT_HANDOFF_BYTES || this.checkpoint.messages.length >= CHECKPOINT_HANDOFF_MESSAGES) this.requestHandoff();
	}
	get handoffReason(): string | undefined {
		if (!this.handoff) return undefined;
		return this.checkpointFrozen
			? "Checkpoint capacity handoff: the latest turn did not fit; the last valid checkpoint is preserved with pending effects. Inspect the workspace and use this result for a fresh bounded assignment, not repeated resume."
			: "Checkpoint capacity handoff: planning threshold reached before the hard limit. Review completed and remaining work; use the handoff for a fresh bounded assignment instead of repeatedly resuming this checkpoint.";
	}
	private requestHandoff(): void { if (!this.handoff) { this.handoff = true; this.counters.handoffs++; } }
	private saveTurn(message: unknown, results: unknown): void {
		if (this.checkpointFrozen) return;
		const checkpoint = this.checkpoint!;
		const count = checkpoint.messages.length, turns = checkpoint.turns, updatedAt = checkpoint.updatedAt, pending = checkpoint.pending;
		try {
			if (this.pendingPrompt) checkpoint.messages.push(this.pendingPrompt);
			appendCheckpointTurn(checkpoint, message, results); this.save();
			this.pendingPrompt = undefined;
		} catch (error) {
			checkpoint.messages.length = count; checkpoint.turns = turns; checkpoint.updatedAt = updatedAt; checkpoint.pending = pending;
			if (!(error instanceof CheckpointCapacityError)) throw error;
			this.checkpointFrozen = true; this.requestHandoff();
		}
	}
	private stop(reason: string): void { this.failed = true; this.fail?.(reason); }
	private onSend(error: Error | null): void { if (error) this.stop(`Subagent control delivery failed: ${error.message}`); }
	private onMessage(raw: unknown): void {
		if (this.phase === "closed" || this.failed) return;
		try {
			const packet = decodeControl(raw);
			if (packet.id !== ++this.sequence) throw new Error("Out-of-order subagent control message.");
			this.counters.received++;
			if (packet.kind === "failure") throw new Error(typeof packet.reason === "string" ? packet.reason.slice(0, 1024) : "Child control failed.");
			let response: unknown;
			if (packet.kind === "ready" && this.phase === "ready") {
				this.save();
				response = { id: packet.id, ok: true, messages: this.seed ?? [], checkpoint: !!this.checkpoint,
					guidance: this.uncertain ? "Previous task stopped after its last checkpoint; later operations may already have affected files. Inspect current state before repeating anything." : "" };
				this.seed = undefined; this.phase = "idle";
			} else if (packet.kind === "begin" && this.phase === "idle" && this.checkpoint) {
				this.checkpoint.pending = true; this.checkpoint.updatedAt = Date.now(); this.save();
				this.counters.starts++; this.phase = "turn";
			} else if (packet.kind === "turn" && this.phase === "turn") {
				if (packet.completed === true) this.saveTurn(packet.message, packet.results);
				this.counters.turns++; this.phase = "idle";
			} else if (packet.kind === "handoff" && this.phase === "turn") {
				// Child projection/transport hit capacity before it could send the turn.
				this.checkpointFrozen = true; this.requestHandoff(); this.phase = "idle";
			} else throw new Error(`Unexpected subagent control ${String(packet.kind).slice(0, 64)} during ${this.phase}.`);
			const reply = (response ?? { id: packet.id, ok: true }) as Record<string, unknown>;
			if (this.checkpoint) {
				reply.checkpointBytes = this.checkpointBytes; reply.checkpointMessages = this.checkpoint.messages.length;
				reply.handoff = this.handoff; reply.checkpointFrozen = this.checkpointFrozen;
			}
			this.reply(reply);
		} catch (error) { this.stop(`Subagent control stopped: ${error instanceof Error ? error.message : String(error)}`); }
	}
	private reply(packet: unknown): void {
		this.proc!.send(encodeControl(packet), this.sendCallback); this.counters.replies++;
	}
	finish(): void {
		if (!this.failed && this.phase !== "idle" && this.phase !== "closed") this.stop(`Subagent exited before acknowledging ${this.phase}; completion/checkpoint is incomplete. Inspect the workspace before retrying.`);
	}
	dispose(): void {
		if (this.phase === "closed") return;
		this.phase = "closed";
		this.proc?.off("message", this.messageListener);
		this.proc = undefined; this.fail = undefined; this.tasks = undefined; this.checkpoint = undefined; this.seed = undefined; this.pendingPrompt = undefined;
	}
}
