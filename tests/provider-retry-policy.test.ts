import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { AssistantMessage } from "../packages/ai/src/types.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../packages/ai/src/utils/retry.ts";

function message(errorMessage?: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
	return { role: "assistant", content: [], api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, errorMessage };
}

const capacity = "Selected model is at capacity";
const policy = { enabled: true, maxRetries: 2, baseDelayMs: 0 };

const transientErrors = [
	"server_busy",
	'{"error":{"type":"server_busy","message":"Servers are currently busy. Please try again later."}}',
	"servers are currently busy",
	"The pending stream has been canceled",
	"The pending stream has been canceled (caused by: socket closed)",
];

for (const error of transientErrors) {
	test(`transient provider failure recovers through the shared retry policy: ${error}`, async () => {
		const failed = message(error);
		assert.equal(isRetryableAssistantError(failed), true);
		let attempts = 0;
		const success = message(undefined, "stop");
		assert.equal(await retryAssistantCall(async () => ++attempts === 1 ? failed : success, policy, undefined), success);
		assert.equal(attempts, 2);
	});
}

test("transient wording preserves terminal quota priority, aborts and disabled/zero retry budgets", async () => {
	for (const error of transientErrors) {
		for (const terminal of ["insufficient_quota", "billing", "quota exceeded", "GoUsageLimitError", "FreeUsageLimitError", "ANTHROPIC_SUBSCRIPTION_DISABLED"]) {
			const failed = message(`${terminal}: ${error}`);
			let attempts = 0;
			assert.equal(isRetryableAssistantError(failed), false);
			assert.equal(await retryAssistantCall(async () => { attempts++; return failed; }, policy, undefined), failed);
			assert.equal(attempts, 1);
		}
		for (const stopReason of ["stop", "aborted"] as const) assert.equal(isRetryableAssistantError(message(error, stopReason)), false);
		for (const limited of [{ ...policy, enabled: false }, { ...policy, maxRetries: 0 }]) {
			let attempts = 0;
			const failed = message(error);
			assert.equal(await retryAssistantCall(async () => { attempts++; return failed; }, limited, undefined), failed);
			assert.equal(attempts, 1);
		}
	}
	for (const error of ["400 invalid_request_error: invalid parameter", "401 invalid_api_key", "Request canceled", "Provider stopped with: unmapped_error"]) {
		assert.equal(isRetryableAssistantError(message(error)), false);
	}
});

test("transient retries retain exponential backoff, bounded attempts and cancellation cleanup", async () => {
	for (const error of transientErrors) {
		const controller = new AbortController();
		const failed = message(error);
		const scheduled: number[][] = [];
		let attempts = 0;
		assert.equal(await retryAssistantCall(async () => { attempts++; return failed; }, { ...policy, baseDelayMs: 1 }, controller.signal, {
			onRetryScheduled(attempt, max, delay) { scheduled.push([attempt, max, delay]); },
		}), failed);
		assert.equal(attempts, 3);
		assert.deepEqual(scheduled, [[1, 2, 1], [2, 2, 2]]);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		attempts = 0;
		const result = await retryAssistantCall(async () => { attempts++; return failed; }, { ...policy, baseDelayMs: 60_000 }, controller.signal, {
			onRetryScheduled() { setImmediate(() => controller.abort()); },
		});
		assert.equal(result.stopReason, "aborted");
		assert.equal(attempts, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	}
});

for (const error of [capacity, "MODEL IS AT CAPACITY. Please wait.", '{"error":{"message":"Selected model is at capacity"}}']) {
	test(`capacity classifier accepts transient provider text: ${error}`, () => {
		assert.equal(isRetryableAssistantError(message(error)), true);
	});
}

for (const terminal of ["insufficient_quota", "billing", "ANTHROPIC_SUBSCRIPTION_DISABLED"]) {
	test(`capacity wording cannot override terminal ${terminal}`, async () => {
		const failed = message(`${terminal}: ${capacity}`);
		let calls = 0;
		assert.equal(isRetryableAssistantError(failed), false);
		assert.equal(await retryAssistantCall(async () => { calls++; return failed; }, policy, undefined), failed);
		assert.equal(calls, 1);
	});
}

test("capacity retry returns the successful response and releases its abort listener", async () => {
	const controller = new AbortController();
	const success = message(undefined, "stop"), calls: string[] = [];
	let attempts = 0;
	const result = await retryAssistantCall(async () => {
		calls.push("produce");
		return ++attempts === 1 ? message(capacity) : success;
	}, policy, controller.signal, {
		onRetryScheduled(attempt, max, delay, error) {
			assert.deepEqual([attempt, max, delay, error], [1, 2, 0, capacity]); calls.push("scheduled");
		},
		onRetryAttemptStart() { calls.push("start"); },
		onRetryFinished(ok, attempt) { assert.equal(ok, true); assert.equal(attempt, 1); calls.push("finished"); },
	});
	assert.equal(result, success);
	assert.deepEqual(calls, ["produce", "scheduled", "start", "produce", "finished"]);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("capacity retries stop exactly at the configured budget", async () => {
	const failed = message(capacity);
	let attempts = 0;
	const scheduled: number[] = [], finished: unknown[] = [];
	assert.equal(await retryAssistantCall(async () => { attempts++; return failed; }, policy, undefined, {
		onRetryScheduled(attempt) { scheduled.push(attempt); },
		onRetryFinished(ok, attempt, error) { finished.push([ok, attempt, error]); },
	}), failed);
	assert.equal(attempts, 3);
	assert.deepEqual(scheduled, [1, 2]);
	assert.deepEqual(finished, [[false, 2, capacity]]);
});

test("capacity backoff cancellation does not start another request or retain listeners", async () => {
	const controller = new AbortController();
	let attempts = 0, finished = 0;
	const result = await retryAssistantCall(async () => { attempts++; return message(capacity); }, policy, controller.signal, {
		onRetryScheduled() { controller.abort(); },
		onRetryFinished(ok, attempt) { assert.equal(ok, false); assert.equal(attempt, 1); finished++; },
	});
	assert.equal(result.stopReason, "aborted");
	assert.equal(result.errorMessage, undefined);
	assert.equal(attempts, 1);
	assert.equal(finished, 1);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("capacity wording is inert for success, abort and disabled retry", async () => {
	for (const stopReason of ["stop", "aborted"] as const) {
		const response = message(capacity, stopReason);
		let calls = 0;
		assert.equal(isRetryableAssistantError(response), false);
		assert.equal(await retryAssistantCall(async () => { calls++; return response; }, policy, undefined), response);
		assert.equal(calls, 1);
	}
	let calls = 0;
	const failed = message(capacity);
	assert.equal(await retryAssistantCall(async () => { calls++; return failed; }, { ...policy, enabled: false }, undefined), failed);
	assert.equal(calls, 1);
});
