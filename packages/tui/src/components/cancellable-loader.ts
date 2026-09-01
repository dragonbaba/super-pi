import { getKeybindings } from "../keybindings.ts";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../component-cache.ts";
import { Loader } from "./loader.ts";

/**
 * Loader that can be cancelled with Escape.
 * Extends Loader with an AbortSignal for cancelling async operations.
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	private abortController = new AbortController();

	/** Called when user presses Escape */
	onAbort?: () => void;

	/** AbortSignal that is aborted when user presses Escape */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** Whether the loader was aborted */
	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
		}
	}

	cancel(): void {
		if (this.abortController.signal.aborted) {
			this.onAbort = undefined;
			return;
		}
		const onAbort = this.onAbort;
		this.onAbort = undefined;
		this.abortController.abort();
		onAbort?.();
	}

	override dispose(): void {
		super.dispose();
	}

	override [RELEASE_COMPONENT_RENDER_CACHE](): void {
		try {
			this.cancel();
		} finally {
			super[RELEASE_COMPONENT_RENDER_CACHE]();
		}
	}
}
