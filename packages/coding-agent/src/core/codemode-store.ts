import type { CodemodeStoreWrites } from "@super-pi/codemode";
import { BoundedJson } from "@super-pi/codemode/bounded-json";

const MAX_VALUE = 256 * 1024;
const MAX_TOTAL = 1024 * 1024;
const MAX_KEYS = 4096;
const EMPTY: Readonly<Record<string, unknown>> = Object.freeze(Object.create(null));

/** Session-branch data only. Never stores tool capabilities or read/permission receipts. */
export class CodemodeStore {
	private values: Readonly<Record<string, unknown>> = EMPTY;
	private readonly serializer = new BoundedJson();
	get snapshot(): Readonly<Record<string, unknown>> { return this.values; }
	reset(): void { this.values = EMPTY; }
	restore(value: unknown): void {
		if (value === undefined) { this.reset(); return; }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Codemode store snapshot");
		const input = value as Record<string, unknown>;
		const next: Record<string, unknown> = Object.create(null);
		let total = 0, count = 0;
		const keys = Object.keys(input);
		if (keys.length > MAX_KEYS) throw new RangeError("Codemode store keys exceed limits");
		for (const key of keys) {
			if (++count > MAX_KEYS || key.length > 1024) throw new RangeError("Codemode store keys exceed limits");
			const json = this.serializer.stringify(input[key], MAX_VALUE);
			if (json === undefined || json.length > MAX_VALUE) throw new RangeError("Codemode store value exceeds limits");
			total += key.length + json.length;
			if (total > MAX_TOTAL) throw new RangeError("Codemode store exceeds limits");
			next[key] = JSON.parse(json);
		}
		this.values = next;
	}
	apply(writes: CodemodeStoreWrites): boolean {
		if (writes.delete.length === 0 && Object.keys(writes.set).length === 0) return false;
		const next: Record<string, unknown> = Object.create(null);
		const removed = new Set(writes.delete);
		for (const key of Object.keys(this.values)) if (!removed.has(key)) next[key] = this.values[key];
		for (const key of Object.keys(writes.set)) next[key] = writes.set[key];
		const previous = this.values;
		try { this.restore(next); }
		catch (error) { this.values = previous; throw error; }
		return true;
	}
}
