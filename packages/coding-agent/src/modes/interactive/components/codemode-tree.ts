import { Container, Text, RELEASE_COMPONENT_RENDER_CACHE, type Component } from "@super-pi/tui";
import {
	CODEMODE_DISPLAY_MAX_CALLS, CODEMODE_DISPLAY_PREVIEW_CHARS, CODEMODE_DISPLAY_JSON_CHARS,
	codemodeInputSummary, codemodeTextDigest, type CodemodeChildDisplay,
} from "../../../core/codemode-display.ts";
import { readShellExecution } from "../../../core/tools/shell-execution.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

type Result = { content: readonly { type: string; text?: string }[]; details?: any; isError?: boolean };
const PREVIEW_TRUNCATED_NOTICE = "\n… (preview truncated)";
const PARTIAL_EFFECTS_NOTICE = "Completed tool side effects are not rolled back. Do not automatically retry mutations.";
const COMPACT_CHARS = 320;
const COMPACT_WHITESPACE = /[\r\n\t]+/g;
const CHILD_SCRIPT_ERROR = /^\[CODEMODE_SCRIPT\] \[[^\]\r\n]{1,128}\] /;

function compactText(text: string): string {
	const bounded = text.length > COMPACT_CHARS ? text.slice(0, COMPACT_CHARS) + "…" : text;
	return bounded.replace(COMPACT_WHITESPACE, " ");
}

function shellStatus(status: string, exit: number | null | undefined): string {
	return status === "not_executed" ? "not executed" : `${status}; exit=${exit ?? "unknown"}`;
}

function boundedPreview(row: CodemodeTreeRow, result: Result): void {
	for (const block of result.content) if (block.type === "text" && typeof block.text === "string") {
		row.previewTruncated = block.text.length > CODEMODE_DISPLAY_PREVIEW_CHARS;
		if (row.previewTruncated) {
			if (row.preview.length !== CODEMODE_DISPLAY_PREVIEW_CHARS || !block.text.startsWith(row.preview)) {
				row.preview = block.text.slice(0, CODEMODE_DISPLAY_PREVIEW_CHARS); row.previewMaterializations++;
			}
		} else row.preview = block.text;
		return;
	}
	row.preview = ""; row.previewTruncated = false;
}

class CodemodeTreeRow extends Container {
	readonly title = new Text("", 0, 0);
	readonly body = new Text("", 3, 0);
	input = "";
	preview = "";
	previewTruncated = false;
	previewMaterializations = 0;
	labelMaterializations = 0;
	outputPath = "";
	reported = "";
	status = "running";
	failed = false;
	last = true;
	expanded = false;
	sharedOutput = false;
	startedAt = Date.now();
	durationMs: number | undefined;
	private label = "";
	private shown = "";
	private labelInput = "";
	private labelStatus = "";
	private labelDuration: number | undefined;
	private labelFailed = false;
	private labelLast = true;
	private labelOrdinal = 0;
	private labelExpanded = false;
	private bodySource = "";
	private bodyPath = "";
	private bodyFailed = false;
	private bodyTruncated = false;
	private bodyExpanded = false;
	private bodyDirty = true;
	readonly id: string;
	readonly name: string;
	ordinal: number;
	constructor(id: string, name: string, ordinal: number) {
		super(); this.id = id; this.name = name; this.ordinal = ordinal; this.addChild(this.title);
	}
	refresh(): void {
		if (!this.label || this.labelInput !== this.input || this.labelStatus !== this.status || this.labelDuration !== this.durationMs
			|| this.labelFailed !== this.failed || this.labelLast !== this.last || this.labelOrdinal !== this.ordinal || this.labelExpanded !== this.expanded) {
			const icon = this.failed ? "✗" : this.status === "running" ? "○" : "•";
			const input = !this.expanded && this.input.length > 96 ? this.input.slice(0, 95) + "…" : this.input;
			const label = `${this.last ? "└─" : "├─"} ${icon} ${this.ordinal}. ${this.name} — ${this.status}${this.durationMs === undefined || this.status === "not executed" ? "" : " (" + (this.durationMs / 1000).toFixed(1) + "s)"}${input ? "  " + input : ""}`;
			this.labelMaterializations++;
			this.labelInput = this.input; this.labelStatus = this.status; this.labelDuration = this.durationMs;
			this.labelFailed = this.failed; this.labelLast = this.last; this.labelOrdinal = this.ordinal;
			this.labelExpanded = this.expanded;
			if (label !== this.label) { this.label = label; this.title.setText(theme.fg(this.failed ? "error" : "toolTitle", label)); }
		}
		const visible = this.expanded || this.failed;
		const shared = this.sharedOutput && !this.failed;
		const body = visible ? shared ? "Identical output is shown under Script output." : this.reported || this.preview : "";
		const path = this.expanded ? this.outputPath : "";
		const truncated = visible && !shared && !this.reported && this.previewTruncated;
		if (this.bodyDirty || this.bodySource !== body || this.bodyPath !== path || this.bodyFailed !== this.failed || this.bodyTruncated !== truncated || this.bodyExpanded !== this.expanded) {
			this.bodyDirty = false; this.bodySource = body; this.bodyPath = path; this.bodyFailed = this.failed; this.bodyTruncated = truncated;
			this.bodyExpanded = this.expanded;
			const output = (this.expanded ? body : compactText(body)) + (truncated && this.expanded ? PREVIEW_TRUNCATED_NOTICE : "") + (path ? "\nOutput: " + path : "");
			this.shown = output; this.body.setText(theme.fg(this.failed ? "error" : "toolOutput", output));
			this.children.length = 1; if (output) this.addChild(this.body);
		}
	}
	override invalidate(): void { super.invalidate(); this.label = this.shown = ""; this.bodyDirty = true; this.refresh(); }
	release(): void {
		this.preview = this.reported = this.input = this.outputPath = this.label = this.shown = "";
		this.labelInput = this.labelStatus = this.bodySource = this.bodyPath = "";
		this.title.setText(""); this.body.setText(""); this.children.length = 0;
	}
}
type OutputOwner = CodemodeTreeRow | CodemodeTreeRow[];
function compareRows(left: Component, right: Component): number { return (left as CodemodeTreeRow).ordinal - (right as CodemodeTreeRow).ordinal; }

/** One parent-owned tree. No child result/argument objects or image buffers are retained. */
export class CodemodeTreeComponent extends Container {
	private readonly title = new Text("", 0, 0);
	private readonly source = new Text("", 2, 0);
	private readonly rowsView = new Container();
	private readonly output = new Text("", 2, 0);
	private readonly hint = new Text("", 0, 0);
	private readonly rows = new Map<string, CodemodeTreeRow>();
	private lastRow: CodemodeTreeRow | undefined;
	private result: Result | undefined;
	private expanded = false;
	private partial = true;
	private failed = false;
	private script = "";
	private scriptOutput = "";
	private scriptPreview = "";
	private hasScriptError = false;
	private mayHaveSideEffects = false;
	private sourceText = "";
	private outputText = "";
	private titleText = "";
	private hintText = "";
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly onVisualInvalidate: (() => void) | undefined;
	private timerRefreshes = 0;
	private runningChildren = 0;
	private readonly tick = (): void => {
		if (this.released || !this.partial || this.runningChildren === 0) return;
		const now = Date.now();
		for (const row of this.rows.values()) if (row.status === "running") { row.durationMs = now - row.startedAt; row.refresh(); }
		this.timerRefreshes++; this.onVisualInvalidate?.();
	};
	private released = false;
	private rowCreations = 0;
	private progressUpdates = 0;
	private outputProjections = 0;
	constructor(onVisualInvalidate?: () => void) {
		super(); this.onVisualInvalidate = onVisualInvalidate;
		this.addChild(this.title); this.addChild(this.source); this.addChild(this.rowsView); this.addChild(this.output); this.addChild(this.hint);
	}
	startChild(id: string, name: string, args: unknown): void {
		if (this.released || this.rows.has(id) || this.rows.size >= CODEMODE_DISPLAY_MAX_CALLS) return;
		if (this.lastRow) { this.lastRow.last = false; this.lastRow.refresh(); }
		const row = new CodemodeTreeRow(id, name.slice(0, 80), this.rows.size + 1);
		row.input = codemodeInputSummary(args); row.expanded = this.expanded;
		this.rows.set(id, row); this.rowsView.addChild(row); this.lastRow = row; this.rowCreations++;
		if (this.partial) this.runningChildren++;
		if (this.partial && !this.timer && this.onVisualInvalidate) this.timer = setInterval(this.tick, 1000);
		row.refresh(); this.refreshHeader();
	}
	updateChild(id: string, result: Result, partial: boolean, failed: boolean): void {
		const row = this.rows.get(id);
		if (!row || this.released) return;
		if (partial && row.status !== "running") return;
		this.progressUpdates++;
		boundedPreview(row, result); row.failed = failed;
		if (!partial) {
			if (row.status === "running" && this.runningChildren > 0) this.runningChildren--;
			if (this.runningChildren === 0) this.stopTimer();
			row.durationMs = Date.now() - row.startedAt;
		}
		const execution = readShellExecution(result.details);
		row.status = partial ? "running" : execution ? shellStatus(execution.executionStatus, execution.exitCode) : failed ? "failed" : "completed";
		row.refresh();
	}
	updateParent(code: unknown, result: Result | undefined, partial: boolean, failed: boolean, expanded: boolean): void {
		this.released = false;
		this.partial = partial; this.failed = failed;
		if (!partial) { this.runningChildren = 0; this.stopTimer(); }
		this.script = typeof code === "string" ? code.length > CODEMODE_DISPLAY_JSON_CHARS
			? code.slice(0, CODEMODE_DISPLAY_JSON_CHARS) + "\n… (script display truncated)" : code : "";
		if (result && result !== this.result) { this.result = result; this.projectResult(result); }
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			for (const row of this.rows.values()) { row.expanded = expanded; row.refresh(); }
		}
		if (partial && this.runningChildren > 0 && !this.timer && this.onVisualInvalidate) this.timer = setInterval(this.tick, 1000);
		this.refreshHeader();
	}
	override invalidate(): void {
		super.invalidate(); this.titleText = this.sourceText = this.outputText = this.hintText = ""; this.refreshHeader();
	}
	private refreshHeader(): void {
		const title = `• Codemode (${this.rows.size} child ${this.rows.size === 1 ? "call" : "calls"}) — ${this.partial ? "running" : this.failed ? "failed" : "completed"}`;
		if (title !== this.titleText) { this.titleText = title; this.title.setText(theme.fg(this.failed ? "error" : "toolTitle", theme.bold(title))); }
		const source = this.expanded && this.script ? "Script\n" + this.script : "";
		if (source !== this.sourceText) { this.sourceText = source; this.source.setText(source ? theme.fg("muted", source) : ""); }
		const visibleOutput = this.expanded ? this.scriptOutput : this.failed ? this.scriptPreview : "";
		const output = visibleOutput ? (this.expanded ? "Script output\n" : "Script error: ") + visibleOutput : "";
		if (output !== this.outputText) { this.outputText = output; this.output.setText(output ? theme.fg(this.expanded ? "toolOutput" : "error", output) : ""); }
		let hint = this.expanded ? "" : theme.fg("muted", keyHint("app.tools.expand", "to expand script and child output"));
		if (this.failed && this.mayHaveSideEffects) hint += (hint ? "\n" : "") + theme.fg("warning", PARTIAL_EFFECTS_NOTICE);
		if (hint !== this.hintText) { this.hintText = hint; this.hint.setText(hint); }
	}
	/** Completion boundary: exact digests only; never remove unknown or hook-modified output. */
	private projectResult(result: Result): void {
		this.outputProjections++;
		const metadata = result.details?.codemode;
		this.mayHaveSideEffects = metadata?.version !== 1 || !Array.isArray(metadata.calls);
		const owners = new Map<string, OutputOwner>();
		if (metadata?.version === 1 && Array.isArray(metadata.calls)) {
			for (let index = 0; index < metadata.calls.length && index < CODEMODE_DISPLAY_MAX_CALLS; index++) {
				const fact = metadata.calls[index] as CodemodeChildDisplay;
				if (!fact || typeof fact.toolCallId !== "string" || typeof fact.toolName !== "string") continue;
				this.startChild(fact.toolCallId, fact.toolName, undefined);
				const row = this.rows.get(fact.toolCallId);
				if (!row) continue;
				row.ordinal = index + 1; row.last = false; row.sharedOutput = false;
				if (typeof fact.durationMs === "number" && Number.isFinite(fact.durationMs) && fact.durationMs >= 0) row.durationMs = fact.durationMs;
				row.input = typeof fact.inputSummary === "string" ? fact.inputSummary.slice(0, 512) : row.input;
				row.preview = typeof fact.preview === "string" ? fact.preview.slice(0, CODEMODE_DISPLAY_PREVIEW_CHARS) : row.preview;
				row.previewTruncated = fact.previewTruncated === true;
				row.outputPath = typeof fact.outputPath === "string" ? fact.outputPath.slice(0, 1024) : "";
				row.failed = fact.isError === true;
				if (fact.executionStatus !== "not_executed") this.mayHaveSideEffects = true;
				row.status = typeof fact.executionStatus === "string" ? shellStatus(fact.executionStatus.slice(0, 80), fact.exitCode) : row.failed ? "failed" : "completed";
				row.reported = "";
				if (Array.isArray(fact.outputDigests)) for (let i = 0; i < fact.outputDigests.length && i < 16; i++) {
					const digest = fact.outputDigests[i];
					if (typeof digest !== "string" || digest.length !== 64) continue;
					const previous = owners.get(digest);
					if (!previous) owners.set(digest, row);
					else if (Array.isArray(previous)) { if (!previous.includes(row)) previous.push(row); }
					else if (previous !== row) owners.set(digest, [previous, row]);
				}
			}
			this.rowsView.children.sort(compareRows);
			this.lastRow = this.rowsView.children[this.rowsView.children.length - 1] as CodemodeTreeRow | undefined;
			if (this.lastRow) this.lastRow.last = true;
		}
		this.scriptOutput = "";
		this.scriptPreview = "";
		this.hasScriptError = false;
		let remaining = CODEMODE_DISPLAY_JSON_CHARS;
		for (let blockIndex = 0; blockIndex < result.content.length; blockIndex++) {
			const block = result.content[blockIndex];
			if (block.type === "image") { this.appendScriptOutput("[image output]"); continue; }
			if (block.type !== "text" || typeof block.text !== "string") continue;
			const digest = block.text.length <= CODEMODE_DISPLAY_JSON_CHARS ? codemodeTextDigest(block.text) : "";
			if (blockIndex === 0 && digest === metadata?.summaryDigest) continue;
			if (remaining <= 0) { this.scriptOutput += "\n… (display truncated; canonical result retained)"; break; }
			const text = block.text.slice(0, remaining); remaining -= text.length;
			const owner = owners.get(digest);
			if (owner) { this.appendReported(owner, text); continue; }
			// text(result.content) is a frequent source of visible JSON. Decode only bounded,
			// all-text arrays whose every block has an exact native-result digest.
			if (text.length === block.text.length && this.projectContentArray(text, owners)) continue;
			this.appendScriptOutput(text);
			if (text.length !== block.text.length) { this.scriptOutput += "\n… (display truncated; canonical result retained)"; break; }
		}
		for (const row of this.rows.values()) {
			if (row.status !== "not executed") this.mayHaveSideEffects = true;
			if (!this.partial && row.status === "running") { row.status = "interrupted / result unavailable"; row.failed = true; }
			row.refresh();
		}
		owners.clear();
	}
	private appendScriptOutput(text: string): void {
		this.scriptOutput += (this.scriptOutput ? "\n" : "") + text;
		if (!this.failed || this.isRepeatedChildError(text)) return;
		if (this.failed && text.startsWith("[CODEMODE_")) {
			this.scriptPreview = compactText(text); this.hasScriptError = true; return;
		}
		if (this.hasScriptError || this.scriptPreview.length >= COMPACT_CHARS) return;
		this.scriptPreview = compactText(this.scriptPreview + (this.scriptPreview ? "\n" : "") + compactText(text));
	}
	private isRepeatedChildError(text: string): boolean {
		const prefix = CHILD_SCRIPT_ERROR.exec(text);
		if (!prefix) return false;
		for (const row of this.rows.values()) {
			if (!row.failed || !row.preview) continue;
			const preview = row.preview.slice(0, 512);
			if (!text.startsWith(preview, prefix[0].length)) continue;
			const rest = text.slice(prefix[0].length + preview.length);
			if (!rest || rest.startsWith("\n[Permission recovery] ")) return true;
		}
		return false;
	}
	private appendReported(owner: OutputOwner, text: string): void {
		if (Array.isArray(owner)) {
			for (const row of owner) row.sharedOutput = true;
			this.appendScriptOutput(text);
		} else owner.reported += (owner.reported ? "\n" : "") + text;
	}
	private projectContentArray(text: string, owners: Map<string, OutputOwner>): boolean {
		if (!text.startsWith("[") || text.length > CODEMODE_DISPLAY_JSON_CHARS) return false;
		let blocks: unknown;
		try { blocks = JSON.parse(text); } catch { return false; }
		if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 16) return false;
		for (const block of blocks) if (!block || block.type !== "text" || typeof block.text !== "string" || Object.keys(block).length !== 2 || !owners.has(codemodeTextDigest(block.text))) return false;
		for (const block of blocks) this.appendReported(owners.get(codemodeTextDigest(block.text))!, block.text);
		return true;
	}
	private stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }
	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.stopTimer();
		// A suspended live transcript still owns canonical, bounded row facts. Keep
		// those for resume; completed rows can be reconstructed from parent details.
		if (!this.partial) {
			for (const row of this.rows.values()) row.release();
			this.rows.clear(); this.rowsView.children.length = 0; this.lastRow = undefined;
		}
		this.result = undefined;
		this.script = this.scriptOutput = this.scriptPreview = this.sourceText = this.outputText = this.titleText = this.hintText = "";
		this.mayHaveSideEffects = false;
		this.hasScriptError = false;
		this.title.setText(""); this.source.setText(""); this.output.setText(""); this.hint.setText("");
		this.released = true;
	}
	/** Diagnostics are lifecycle-only, never called from render/update. */
	getLifecycleCounts() {
		let textChars = this.script.length + this.scriptOutput.length + this.scriptPreview.length;
		let labelMaterializations = 0, previewMaterializations = 0;
		for (const row of this.rows.values()) {
			textChars += row.preview.length + row.reported.length + row.input.length + row.outputPath.length;
			labelMaterializations += row.labelMaterializations; previewMaterializations += row.previewMaterializations;
		}
		return { rows: this.rows.size, runningChildren: this.runningChildren, resultReferences: this.result ? 1 : 0, textChars, timers: this.timer ? 1 : 0, timerRefreshes: this.timerRefreshes, rowCreations: this.rowCreations, progressUpdates: this.progressUpdates, outputProjections: this.outputProjections, labelMaterializations, previewMaterializations };
	}
}
