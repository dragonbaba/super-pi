import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderStreams } from "@super-pi/ai";
import { lazyApi } from "../../packages/ai/src/api/lazy.ts";

const stream = (): never => {
	throw new Error("stream is not used by this compatibility test");
};

const externalProviderWithoutOwnership: ProviderStreams = {
	stream,
	streamSimple: stream,
};

test("ProviderStreams remains compatible with external implementations that omit ownership", () => {
	assert.equal(externalProviderWithoutOwnership.streamedToolArgumentOwnership, undefined);
	assert.equal(externalProviderWithoutOwnership.stream, stream);
});

test("lazyApi preserves the legacy capabilities-only signature", () => {
	const provider = lazyApi(async () => externalProviderWithoutOwnership, { fetchDeferred: true });
	assert.equal(provider.streamedToolArgumentOwnership, undefined);
	assert.equal(typeof provider.fetchDeferred, "function");
});

test("lazyApi accepts ownership followed by capabilities", () => {
	const provider = lazyApi(
		async () => externalProviderWithoutOwnership,
		"replacement-object",
		{ fetchDeferred: true },
	);
	assert.equal(provider.streamedToolArgumentOwnership, "replacement-object");
	assert.equal(typeof provider.fetchDeferred, "function");
});
