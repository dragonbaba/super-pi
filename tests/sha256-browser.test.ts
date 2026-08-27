import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Utf8 } from "../packages/ai/src/utils/sha256.ts";

test("portable SHA-256 matches native SHA-256 without a process global", () => {
	const vectors = [
		"",
		"abc",
		"Unicode: café/咖啡/🌍",
		"multi-block:".repeat(1_000),
	];
	const expected = vectors.map((value) => createHash("sha256").update(value).digest("hex"));
	const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
	let actual: string[];
	try {
		Object.defineProperty(globalThis, "process", {
			configurable: true,
			value: undefined,
			writable: true,
		});
		actual = vectors.map(sha256Utf8);
	} finally {
		if (processDescriptor) Object.defineProperty(globalThis, "process", processDescriptor);
		else Reflect.deleteProperty(globalThis, "process");
	}

	assert.deepEqual(actual!, expected);
});
