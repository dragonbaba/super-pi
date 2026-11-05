import type { Writable } from "node:stream";
import type { AgentSessionEvent } from "../core/agent-session.ts";

const STREAM_HEADER = '{"type":"subagent_stream","version":1}\n';
const AGENT_START = '{"type":"agent_start"}\n';
const TURN_START = '{"type":"turn_start"}\n';
const TURN_END = '{"type":"turn_end"}\n';
const AGENT_SETTLED = '{"type":"agent_settled","aborted":false}\n';
const AGENT_ABORTED = '{"type":"agent_settled","aborted":true}\n';

export function isSubagentStreamEvent(event: { readonly type: string }): boolean {
    switch (event.type) {
        case "message_end": case "tool_execution_start": case "tool_execution_end":
        case "agent_start": case "turn_start": case "turn_end": case "agent_end": case "agent_settled": return true;
        default: return false;
    }
}

/** One print-process owner. Writable owns its bounded byte queue; no application Promise tail. */
export class SubagentStream {
    private output?: Writable;
    private write?: (text: string, callback: (error?: Error | null) => void) => boolean;
    private readonly messageFrame: { type: "message_end"; message: unknown } = { type: "message_end", message: undefined };
    private readonly toolFrame = { type: "", toolCallId: "", toolName: "", isError: undefined as boolean | undefined };
    private readonly endFrame = { type: "agent_end", willRetry: false, requiresUserInput: false };
    private pendingWrites = 0;
    private blocked = false;
    private disposed = false;
    private awaitingErrorEvent = false;
    private error?: Error;
    private waiting?: Promise<void>;
    private resolveWait?: () => void;
    private rejectWait?: (error: Error) => void;
    private readonly initializeWait = (resolve: () => void, reject: (error: Error) => void): void => {
        this.resolveWait = resolve; this.rejectWait = reject;
    };

    constructor(output: Writable, write: (text: string, callback: (error?: Error | null) => void) => boolean) {
        this.output = output; this.write = write;
        output.on("error", this.onError);
        output.on("close", this.onClose);
        output.on("drain", this.onDrain);
    }
    start(): void { this.writeLine(STREAM_HEADER); }

    readonly onEvent = (event: AgentSessionEvent): void => {
        switch (event.type) {
            case "message_end":
                this.messageFrame.message = event.message;
                try { this.writeLine(JSON.stringify(this.messageFrame) + "\n"); }
                finally { this.messageFrame.message = undefined; }
                break;
            case "tool_execution_start": case "tool_execution_end":
                this.toolFrame.type = event.type; this.toolFrame.toolCallId = event.toolCallId; this.toolFrame.toolName = event.toolName;
                this.toolFrame.isError = event.type === "tool_execution_end" ? event.isError : undefined;
                try { this.writeLine(JSON.stringify(this.toolFrame) + "\n"); }
                finally { this.toolFrame.type = ""; this.toolFrame.toolCallId = ""; this.toolFrame.toolName = ""; this.toolFrame.isError = undefined; }
                break;
            case "agent_start": this.writeLine(AGENT_START); break;
            case "turn_start": this.writeLine(TURN_START); break;
            case "turn_end": this.writeLine(TURN_END); break;
            case "agent_end":
                this.endFrame.willRetry = event.willRetry; this.endFrame.requiresUserInput = event.requiresUserInput === true;
                this.writeLine(JSON.stringify(this.endFrame) + "\n"); break;
            case "agent_settled": this.writeLine(event.aborted ? AGENT_ABORTED : AGENT_SETTLED); break;
        }
    };

    private writeLine(text: string): void {
        if (this.error) throw this.error;
        if (this.disposed) throw new Error("Subagent output is closed");
        this.pendingWrites++;
        try { if (!this.write!(text, this.onWrite)) this.blocked = true; }
        catch (error) { this.pendingWrites--; this.fail(error instanceof Error ? error : new Error(String(error))); throw this.error; }
    }
    private readonly onWrite = (error?: Error | null): void => {
        this.pendingWrites--;
        if (error) { this.awaitingErrorEvent = true; this.fail(error); }
        this.releaseWait();
    };
    private readonly onDrain = (): void => { this.blocked = false; this.releaseWait(); };
    private readonly onError = (error: Error): void => {
        this.awaitingErrorEvent = false; this.fail(error); this.releaseWait();
    };
    private readonly onClose = (): void => {
        this.blocked = false; this.awaitingErrorEvent = false;
        this.fail(new Error("Subagent output closed before shutdown")); this.releaseWait();
    };
    private fail(error: Error): void {
        this.error ??= error;
        const reject = this.rejectWait;
        this.waiting = undefined; this.resolveWait = undefined; this.rejectWait = undefined;
        reject?.(this.error);
    }
    private releaseWait(): void {
        if (this.pendingWrites !== 0) return;
        if (!this.blocked) {
            const resolve = this.resolveWait;
            this.waiting = undefined; this.resolveWait = undefined; this.rejectWait = undefined;
            resolve?.();
        }
        if (this.disposed && !this.awaitingErrorEvent) {
            this.output?.off("error", this.onError); this.output?.off("close", this.onClose); this.output?.off("drain", this.onDrain);
            this.output = undefined; this.write = undefined;
        }
    }
    /** A single deferred per blocked busy cycle, shared by concurrent critical producers. */
    private wait(): Promise<void> {
        this.waiting ??= new Promise<void>(this.initializeWait);
        return this.waiting;
    }
    readonly waitForBackpressure = (): Promise<void> | void => {
        if (this.error) throw this.error;
        if (this.blocked) return this.wait();
    };
    flush(): Promise<void> | void {
        if (this.error) throw this.error;
        if (this.pendingWrites || this.blocked) return this.wait();
    }
    dispose(): void {
        this.disposed = true;
        if (this.waiting) this.fail(new Error("Subagent output disposed"));
        this.releaseWait();
    }
}
