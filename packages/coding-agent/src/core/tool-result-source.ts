import { createHash } from "node:crypto";

/** Existing MCP transport envelope; not a token budget or a retention policy. */
export const MCP_SOURCE_BYTES = 10 * 1024 * 1024;
export const MCP_INLINE_BYTES = 50 * 1024;
const SOURCE_VERIFIED = Symbol.for("super-pi.mcp-source.verified.v1");
const MAX_DEPTH = 32;

export class McpSourceError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`MCP result rejected (${code}).`);
		this.name = "McpSourceError";
		this.code = code;
	}
}

export interface McpTypedSource {
	readonly version: 1;
	readonly kind: "audio" | "resource" | "resource_link" | "structured" | "metadata";
	readonly value: unknown;
	readonly digest: string;
	readonly bytes: number;
	readonly codeUnits: number;
}

/** Bounded structural validation before any avoidable complete serialization. */
class SourceInspection {
	bytes = 0;
	codeUnits = 0;
	readonly ancestors: object[] = [];
	readonly objects: object[] = [];
	readonly hash;
	readonly maxBytes: number;
	constructor(integrity: boolean, maxBytes = MCP_SOURCE_BYTES) { this.hash = integrity ? createHash("sha256") : undefined; this.maxBytes = maxBytes; }

	charge(bytes: number, units: number): void {
		this.bytes += bytes;
		this.codeUnits += units;
		if (this.bytes > this.maxBytes || this.codeUnits > MCP_SOURCE_BYTES) throw new McpSourceError("result-size-limit");
	}

	string(value: string): void {
		// Conservatively includes the maximum JSON escaping expansion; no Buffer.
		let bytes = 2;
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) {
				if (code <= 0xdbff && code >= 0xd800 && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
				else bytes += 6;
			} else bytes += code === 34 || code === 92 ? 2 : code < 128 ? 1 : code < 2048 ? 2 : 3;
			if (bytes + this.bytes > this.maxBytes) throw new McpSourceError("result-size-limit");
		}
		this.charge(bytes, value.length);
		this.hash?.update("s").update(value.length.toString(36)).update(":").update(value, "utf16le");
	}

	visit(value: unknown, depth = 0): void {
		if (depth > MAX_DEPTH) throw new McpSourceError("invalid-structured-content");
		this.charge(depth * 2 + 2, 0);
		if (typeof value === "string") { this.string(value); return; }
		if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			const scalar = String(value);
			this.charge(scalar.length, scalar.length);
			this.hash?.update("p").update(scalar).update(";");
			return;
		}
		if (typeof value !== "object" || value === null) throw new McpSourceError("invalid-structured-content");
		if (this.ancestors.includes(value)) throw new McpSourceError("invalid-structured-content");
		const array = Array.isArray(value);
		const prototype = Object.getPrototypeOf(value);
		if (!array && prototype !== Object.prototype && prototype !== null) throw new McpSourceError("invalid-structured-content");
		this.charge(2, 16);
		this.hash?.update(array ? "[" : "{");
		this.ancestors.push(value);
		if (this.hash) this.objects.push(value);
		try {
			if (array) {
				if (value.length > MCP_SOURCE_BYTES / 16) throw new McpSourceError("result-size-limit");
				for (let i = 0; i < value.length; i++) {
					const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
					if (!descriptor || !("value" in descriptor)) throw new McpSourceError("invalid-structured-content");
					this.charge(1, 8);
					this.visit(descriptor.value, depth + 1);
				}
			} else {
				for (const key in value) {
					if (!Object.hasOwn(value, key)) continue;
					const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
					if (!("value" in descriptor)) throw new McpSourceError("invalid-structured-content");
					this.string(key);
					this.charge(2, 8);
					this.visit(descriptor.value, depth + 1);
				}
			}
		} finally { this.ancestors.pop(); }
		this.hash?.update(array ? "]" : "}");
	}
}

export function inspectMcpValue(value: unknown, maxBytes = MCP_SOURCE_BYTES): number {
	const inspection = new SourceInspection(false, maxBytes);
	inspection.visit(value);
	return inspection.bytes;
}

/** Called at the input boundary, before delivery. No registry or source copy. */
export function createMcpTypedSource(kind: McpTypedSource["kind"], value: unknown): McpTypedSource {
	const inspection = new SourceInspection(true);
	try {
		inspection.hash!.update(`mcp-source-v1:${kind}:`);
		inspection.visit(value);
		for (const object of inspection.objects) Object.freeze(object);
		const source: McpTypedSource = { version: 1, kind, value, digest: inspection.hash!.digest("hex"), bytes: inspection.bytes, codeUnits: inspection.codeUnits };
		Object.defineProperty(source, SOURCE_VERIFIED, { value: true });
		return Object.freeze(source);
	} finally { inspection.objects.length = 0; inspection.ancestors.length = 0; }
}

/** Persisted JSON loses the in-process brand and is validated once on restore. */
export function verifiedMcpSource(source: McpTypedSource): McpTypedSource {
	if ((source as unknown as Record<symbol, unknown>)[SOURCE_VERIFIED] === true && Object.isFrozen(source)) return source;
	if (source.version !== 1 || !["audio", "resource", "resource_link", "structured", "metadata"].includes(source.kind)) throw new McpSourceError("invalid-typed-content");
	const restored = createMcpTypedSource(source.kind, source.value);
	if (restored.digest !== source.digest || restored.bytes !== source.bytes || restored.codeUnits !== source.codeUnits) throw new McpSourceError("invalid-typed-content");
	Object.defineProperty(source, SOURCE_VERIFIED, { value: true });
	return Object.freeze(source);
}

/** One size-validated model serialization, never a serialized binary payload. */
export function serializeMcpStructured(value: unknown, maxBytes = MCP_SOURCE_BYTES): string {
	inspectMcpValue(value, maxBytes);
	try { return JSON.stringify(value, null, 2); }
	catch { throw new McpSourceError("invalid-structured-content"); }
}
