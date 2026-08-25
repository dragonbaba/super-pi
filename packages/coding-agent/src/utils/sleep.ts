/**
 * Sleep helper that respects abort signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		let timeout: ReturnType<typeof setTimeout>;
		const onAbort = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("Aborted"));
		};
		const onTimeout = (): void => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};

		timeout = setTimeout(onTimeout, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
