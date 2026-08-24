function abortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

/** Normalize an optional public signal without imposing a deadline. */
export function operationSignal(signal?: AbortSignal): AbortSignal {
	return signal ?? new AbortController().signal;
}

/** Stop waiting on abort while observing the abandoned operation through settlement. */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) {
		void operation.catch(() => {});
		return Promise.reject(abortReason(signal));
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortReason(signal));
		};

		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}

interface ActiveModelCatalogRefresh {
	controller: AbortController;
	promise: ReturnType<ModelRuntime["refresh"]>;
	waiters: number;
}

const activeModelCatalogRefreshes = new WeakMap<ModelRuntime, ActiveModelCatalogRefresh>();

export function refreshModelCatalogs(
	modelRuntime: ModelRuntime,
	signal: AbortSignal,
): ReturnType<ModelRuntime["refresh"]> {
	let active: ActiveModelCatalogRefresh;
	try {
		signal.throwIfAborted();
		const existing = activeModelCatalogRefreshes.get(modelRuntime);
		if (existing) {
			active = existing;
		} else {
			const controller = new AbortController();
			let created: ActiveModelCatalogRefresh;
			const operation = modelRuntime.refresh({ signal: controller.signal });
			const promise = raceWithAbortSignal(operation, controller.signal).finally(() => {
				if (activeModelCatalogRefreshes.get(modelRuntime) === created) {
					activeModelCatalogRefreshes.delete(modelRuntime);
				}
			});
			created = { controller, promise, waiters: 0 };
			active = created;
			activeModelCatalogRefreshes.set(modelRuntime, active);
		}
	} catch (error) {
		return Promise.reject(error);
	}

	active.waiters++;
	return raceWithAbortSignal(active.promise, signal).finally(() => {
		active.waiters--;
		if (active.waiters === 0 && activeModelCatalogRefreshes.get(modelRuntime) === active) {
			activeModelCatalogRefreshes.delete(modelRuntime);
			active.controller.abort();
		}
	});
}
import type { ModelRuntime } from "../core/model-runtime.ts";
