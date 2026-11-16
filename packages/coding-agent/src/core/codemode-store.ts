import type { CodemodeStoreWrites } from "@super-pi/codemode";
import { BoundedJson } from "@super-pi/codemode/bounded-json";
import { MAX_STORE_VALUE_CHARS, MAX_STORE_TOTAL_CHARS, MAX_STORE_KEYS, MAX_STORE_KEY_CHARS } from "@super-pi/codemode/limits";
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
		if (keys.length > MAX_STORE_KEYS) throw new RangeError("Codemode store keys exceed limits");
		for (const key of keys) {
			if (++count > MAX_STORE_KEYS || key.length > MAX_STORE_KEY_CHARS) throw new RangeError("Codemode store keys exceed limits");
			const json = this.serializer.stringify(input[key], MAX_STORE_VALUE_CHARS);
			if (json === undefined || json.length > MAX_STORE_VALUE_CHARS) throw new RangeError("Codemode store value exceeds limits");
			total += key.length + json.length;
			if (total > MAX_STORE_TOTAL_CHARS) throw new RangeError("Codemode store exceeds limits");
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
