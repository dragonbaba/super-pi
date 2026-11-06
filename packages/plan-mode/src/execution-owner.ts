import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ReadOnlyShellSubcommands } from "@super-pi/coding-agent";

/** Owns actual UI and file operations, not the menu action that may request a switch. */
export class PlanExecutionOwner {
	private pending = 0;
	private idle: Promise<void> | undefined;
	private finish: (() => void) | undefined;
	private accepting = true;
	private authority = new AbortController();
	private readonly pi: ExtensionAPI;
	constructor(pi: ExtensionAPI, stopMenus: () => void, resumeMenus: () => void, waitSettings: () => Promise<void>, toolSelectionMode: () => "plan" | undefined,
		readOnlyShellSubcommands: () => ReadOnlyShellSubcommands | undefined) {
		this.pi = pi;
		pi.registerExecutionOwner?.("plan", {
			toolSelectionMode,
			readOnlyShellSubcommands,
			revoke: () => {
				this.accepting = false;
				const reason = new DOMException("Plan interaction replaced", "AbortError"); reason.stack = "AbortError: Plan interaction replaced";
				this.authority.abort(reason); stopMenus();
			},
			drain: async () => {
				await this.idle; await waitSettings();
				this.authority = new AbortController(); this.accepting = true; resumeMenus();
			},
		});
	}
	async track<T>(run: () => Promise<T>): Promise<T> {
		this.pi.assertExecutionCurrent?.();
		if (!this.accepting || this.pending >= 8) throw new Error("Plan interaction is closing or at capacity.");
		if (this.pending++ === 0) this.idle = new Promise(resolve => { this.finish = resolve; });
		try { return await run(); }
		finally {
			if (--this.pending === 0) {
				const finish = this.finish; this.finish = undefined; this.idle = undefined; finish?.();
			}
		}
	}
	context<T extends ExtensionContext>(ctx: T): T {
		const original = ctx.ui, ui = Object.create(original) as ExtensionUIContext;
		const signalFor = (signal?: AbortSignal) => {
			const run = ctx.signal;
			return run || signal ? AbortSignal.any([this.authority.signal, ...(run ? [run] : []), ...(signal ? [signal] : [])]) : this.authority.signal;
		};
		ui.custom = <R>(...args: Parameters<ExtensionUIContext["custom"]>) => this.track(() => original.custom(...args) as Promise<R>);
		ui.select = (title, choices, options) => this.track(() => original.select(title, choices, { ...options,
			signal: signalFor(options?.signal) }));
		ui.input = (title, placeholder, options) => this.track(() => original.input(title, placeholder, { ...options,
			signal: signalFor(options?.signal) }));
		ui.confirm = (title, message, options) => this.track(() => original.confirm(title, message, { ...options,
			signal: signalFor(options?.signal) }));
		ui.editor = (...args) => this.track(() => original.editor(...args));
		return Object.create(ctx, { ui: { value: ui } }) as T;
	}
}
