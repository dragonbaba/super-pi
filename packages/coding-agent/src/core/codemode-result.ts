import type { ToolResultMessage } from "@super-pi/ai";
import { OutputAccumulator } from "./tools/output-accumulator.ts";
import { estimateToolOutputTokens } from "./tool-output-budget.ts";
import type { TextContent, ImageContent } from "@super-pi/ai";
import { serializeMcpStructured, verifiedMcpSource, type McpTypedSource } from "./tool-result-source.ts";
import { BoundedJson } from "@super-pi/codemode/bounded-json";

const MAX_INLINE_CHARS = 128 * 1024;
const CHUNK_CHARS = 16 * 1024;
const OUTPUT_OPTIONS = Object.freeze({ maxBytes: 32 * 1024, maxLines: 400 });
const FORCE_SPILL_OPTIONS = Object.freeze({ maxBytes: 1, maxLines: 1 });
/** Images stay attachable blocks; base64 in a text spill file is useless to the model. */
const MAX_KEPT_IMAGES = 16;

function appendText(output: OutputAccumulator, text: string): void {
	for (let offset = 0; offset < text.length;) {
		let end = Math.min(text.length, offset + CHUNK_CHARS);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		output.append(Buffer.from(text.slice(offset, end), "utf8"));
		offset = end;
	}
}

/**
 * Reuse the native capped spill/cleanup mechanism; never join a large result to make a preview.
 * Only text counts toward the inline bound: up to MAX_KEPT_IMAGES image blocks are kept as images.
 */
export async function boundCodemodeResult(result: ToolResultMessage, serializer: BoundedJson): Promise<ToolResultMessage> {
	let chars = 0, images = 0, needsRecovery = false;
	let detailsNeedRecovery = false;
	let details: unknown;
	if (result.details !== undefined) {
		try { const json = serializer.stringify(result.details, 64 * 1024); if (json !== undefined) details = JSON.parse(json); }
		catch { needsRecovery = true; detailsNeedRecovery = true; }
	}
	for (const block of result.content) {
		if (block.type === "text") chars += block.text.length;
		else images++;
		if ((block as { mcpSource?: unknown }).mcpSource) needsRecovery = true;
	}
	if (!needsRecovery && chars <= MAX_INLINE_CHARS && images <= MAX_KEPT_IMAGES && result.content.length <= 128) return details === undefined ? result : { ...result, details };
	const output = new OutputAccumulator(OUTPUT_OPTIONS);
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: "" }];
	try {
		for (const block of result.content) {
			if (block.type === "text") {
				appendText(output, block.text);
				const source = (block as { mcpSource?: McpTypedSource }).mcpSource;
				if (source) appendText(output, serializeMcpStructured(verifiedMcpSource(source).value));
			} else if (content.length <= MAX_KEPT_IMAGES) {
				content.push(block);
				appendText(output, `[image ${block.mimeType} kept as attachment ${content.length - 1}]`);
			} else {
				appendText(output, `data:${block.mimeType};base64,`);
				appendText(output, block.data);
			}
			appendText(output, "\n");
		}
		if (detailsNeedRecovery) appendText(output, serializer.stringify(result.details, 8 * 1024 * 1024) ?? "");
		output.finish();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		await output.closeTempFile();
		const recovery = snapshot.fullOutputPath
			? `${snapshot.spillFileCapped ? "Capped output (5 MiB; later data was not saved)" : "Full output"}: ${snapshot.fullOutputPath}`
			: "Complete source is included below.";
		content[0] = { type: "text", text: `${snapshot.content}\n[Codemode bounded result. ${recovery}]` };
		return { ...result, content,
			details: { ...(detailsNeedRecovery ? {} : details as object), codemodeOutput: { path: snapshot.fullOutputPath, capped: snapshot.spillFileCapped } } };
	} catch (error) { await output.discardTempFile(); throw error; }
	finally { await output.closeTempFile(); }
}

export function codemodeContentChars(result: Pick<ToolResultMessage, "content">): number {
	let chars = 0;
	for (const block of result.content) if (block.type === "text") chars += block.text.length;
	return chars;
}

export function codemodeImageChars(content: readonly (TextContent | ImageContent)[]): number {
	let chars = 0;
	for (const block of content) if (block.type === "image") chars += block.data.length;
	return chars;
}

/** One bounded scratch block/array per result, reused by synchronous estimation. */
export async function capCodemodeOutput(content: (TextContent | ImageContent)[], tokens: number): Promise<(TextContent | ImageContent)[]> {
	if (estimateToolOutputTokens(content).estimatedTokens <= tokens) return content;
	const output = new OutputAccumulator(FORCE_SPILL_OPTIONS);
	let path: string | undefined;
	let capped = false;
	try {
		for (const block of content) {
			appendText(output, block.type === "text" ? block.text : `data:${block.mimeType};base64,`);
			if (block.type === "image") appendText(output, block.data);
			appendText(output, "\n");
		}
		output.finish();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		path = snapshot.fullOutputPath;
		capped = snapshot.spillFileCapped;
		await output.closeTempFile();
	} catch (error) { await output.discardTempFile(); throw error; }
	finally { await output.closeTempFile(); }
	const notice: TextContent = { type: "text", text: `[Codemode output truncated. ${capped ? "Only the first 5 MiB was saved; later data is unavailable. " : ""}Recover the saved output with read: ${path ?? "unavailable"}. Do not repeat completed side effects.]` };
	const scratch: TextContent = { type: "text", text: "" };
	const sample: (TextContent | ImageContent)[] = [notice];
	let remaining = tokens - estimateToolOutputTokens(sample).estimatedTokens - 2;
	if (remaining < 0) throw new Error("Codemode output budget cannot fit the recovery notice");
	const projected: (TextContent | ImageContent)[] = [];
	let truncated = false;
	for (const block of content) {
		// Images are budgeted when retained and shown; beside the text notice they add no estimated
		// tokens, so keep every image, including those after the text was cut.
		if (block.type === "image") { projected.push(block); continue; }
		if (truncated) continue;
		sample[0] = block;
		const cost = estimateToolOutputTokens(sample).estimatedTokens + 1;
		if (cost <= remaining) { projected.push(block); remaining -= cost; continue; }
		if (remaining > 0) {
			sample[0] = scratch;
			let low = 0, high = Math.min(block.text.length, remaining * 8);
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				scratch.text = block.text.slice(0, mid);
				if (estimateToolOutputTokens(sample).estimatedTokens <= remaining) low = mid;
				else high = mid - 1;
			}
			if (low && low < block.text.length && block.text.charCodeAt(low - 1) >= 0xd800 && block.text.charCodeAt(low - 1) <= 0xdbff) low--;
			if (low) projected.push({ type: "text", text: block.text.slice(0, low) });
		}
		truncated = true;
	}
	projected.push(notice);
	if (estimateToolOutputTokens(projected).estimatedTokens > tokens) throw new Error("Codemode output budget could not be satisfied");
	return projected;
}
