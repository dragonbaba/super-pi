import type { FetchFunction } from "../types.ts";
/** One request-bound adapter; no listeners or callbacks per chunk/image. */
export function observeRequestBody(fetch: FetchFunction | undefined, observe?: (bytes: number) => void): FetchFunction | undefined {
	if (!observe) return fetch;
	const send = fetch ?? globalThis.fetch;
	return function sendObservedBody(input, init) {
		if (typeof init?.body === "string") observe(requestBodyUtf8Bytes(init.body));
		return send(input, init);
	};
}
export function requestBodyUtf8Bytes(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) bytes++;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
		else bytes += 3;
	}
	return bytes;
}
