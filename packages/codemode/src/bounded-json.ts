import { isStringObject } from "node:util/types";

const isRawJSON = (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

/** Per-owner synchronous serializer. Bounds traversal and leaves before native encoding. */
export class BoundedJson {
	private remaining = 0;
	private visits = 0;
	private root = true;
	private active = false;
	private readonly count: (this: unknown, key: string, value: unknown) => unknown;
	constructor() {
		const owner = this;
		// One callback per serializer lifetime. JSON supplies the actual containing
		// object as `this`, so array indexes are never mistaken for encoded keys.
		this.count = function (key, value) { return owner.countValue(this, key, value); };
	}
	private countValue(holder: unknown, key: string, value: unknown): unknown {
		if (--this.visits < 0) throw new RangeError("Codemode JSON traversal exceeds its limit");
		const array = Array.isArray(holder);
		const omitted = value === undefined || typeof value === "function" || typeof value === "symbol";
		// Each non-root member includes a comma. Ignoring container delimiters
		// leaves at least one spare character per container, including the first member.
		let chars = this.root || (omitted && !array) ? 0 : array ? 1 : key.length + 4;
		this.root = false;
		switch (typeof value) {
			case "string": chars += value.length + 2; break;
			case "number": chars += 1; break;
			case "boolean": chars += value ? 4 : 5; break;
			case "object":
				if (value === null) chars += 4;
				else if (isStringObject(value)) {
					// Match native wrapper coercion once, including Symbol.toPrimitive.
					// The primitive is returned to JSON so a custom conversion is not repeated.
					const text = `${value}`;
					chars += text.length + 2; value = text;
				} else if (isRawJSON?.(value)) chars += (value as { rawJSON: string }).rawJSON.length;
				break;
			default: if (array && omitted) chars += 4; break;
		}
		this.remaining -= chars;
		if (this.remaining < 0) throw new RangeError("Codemode JSON value exceeds its limit");
		return value;
	}
	stringify(value: unknown, limit: number): string | undefined {
		if (this.active) throw new Error("Codemode JSON serializer cannot be reentered");
		if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid Codemode JSON limit");
		this.active = true;
		this.remaining = limit;
		this.visits = Math.max(1024, limit + 1);
		this.root = true;
		try {
			// A genuine lower bound; escaping and numeric formatting are checked
			// exactly after encoding. The separate visit bound also covers omitted values.
			const json = JSON.stringify(value, this.count);
			if (json !== undefined && json.length > limit) throw new RangeError("Codemode JSON value exceeds its limit");
			return json;
		} finally {
			this.remaining = 0;
			this.visits = 0;
			this.active = false;
		}
	}
}
