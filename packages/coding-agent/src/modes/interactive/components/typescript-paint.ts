import { Worker } from "node:worker_threads";
import { supportsLanguage } from "../../../utils/syntax-highlight.ts";
import type { MarkdownTheme } from "@super-pi/tui";
import type { AssistantMessageComponent } from "./assistant-message.ts";
import { paintSyntaxHtml } from "../theme/theme.ts";
import { MAX_PAINT_BLOCKS, MAX_PAINT_SOURCE_UNITS } from "./typescript-paint-limits.ts";

const TYPESCRIPT_LANGUAGE = /^(?:typescript|tsx?)$/i;

interface PaintJob {
	owner: WeakRef<MessageCodePaint>;
	generation: number;
	sources: string[];
	embeddedLanguages: boolean;
}

/** The interactive session owns one lazy parser and admits only the latest waiting completion. */
export class TypeScriptPaintQueue {
	private worker?: Worker;
	private retired = false;
	private active?: PaintJob;
	private pending?: PaintJob;

	submit(job: PaintJob): void {
		if (this.retired) return;
		if (!this.active) {
			this.start(job);
			return;
		}
		this.pending?.owner.deref()?.defer(this.pending.generation);
		this.pending = job;
	}

	private start(job: PaintJob): void {
		if (!job.owner.deref()?.isCurrent(job.generation)) return;
		try {
			if (!this.worker) {
				const name = import.meta.url.endsWith(".ts") ? "./typescript-paint-worker.ts" : "./typescript-paint-worker.js";
				const worker = new Worker(new URL(name, import.meta.url), { execArgv: [] });
				this.worker = worker;
				worker.on("message", this.receive);
				worker.once("error", () => this.failed(worker));
				worker.once("exit", () => this.failed(worker));
				worker.unref();
			}
			this.active = job;
			this.worker.postMessage({ sources: job.sources, embeddedLanguages: job.embeddedLanguages });
		} catch {
			this.active = undefined;
		}
	}

	private readonly receive = (html: string[] | null): void => {
		const job = this.active;
		this.active = undefined;
		const next = this.pending;
		this.pending = undefined;
		if (job && html) job.owner.deref()?.apply(job, html);
		if (next) this.start(next);
	};

	private failed(worker: Worker): void {
		if (this.worker !== worker) return;
		this.worker = undefined;
		this.active = undefined;
		const next = this.pending;
		this.pending = undefined;
		if (next) this.start(next);
	}

	retire(): void {
		this.retired = true;
		this.active = undefined;
		this.pending = undefined;
	}

	async close(): Promise<void> {
		this.retire();
		const worker = this.worker;
		this.worker = undefined;
		if (worker) {
			worker.off("message", this.receive);
			await worker.terminate();
		}
	}
}

/** Only the final render collects normalized Markdown tokens. A pending frame just emits its original rows. */
export class MessageCodePaint {
	private generation = 0;
	private collecting = false;
	private sources?: string[];
	private units = 0;
	private embeddedLanguages?: boolean;
	private colors?: Map<string, string>;
	private theme: MarkdownTheme;
	private readonly queue: TypeScriptPaintQueue;
	private readonly owner: AssistantMessageComponent;
	private readonly repaint: (owner: AssistantMessageComponent) => void;

	constructor(queue: TypeScriptPaintQueue, theme: MarkdownTheme, owner: AssistantMessageComponent, repaint: (owner: AssistantMessageComponent) => void) {
		this.owner = owner;
		this.queue = queue;
		this.theme = theme;
		this.repaint = repaint;
	}

	reset(collect: boolean, theme: MarkdownTheme): void {
		this.generation++;
		this.embeddedLanguages = undefined;
		this.collecting = collect;
		this.sources = undefined;
		this.units = 0;
		this.colors = undefined;
		this.theme = theme;
	}

	readonly highlight = (code: string, lang?: string): readonly string[] | undefined => {
		if (!lang || !TYPESCRIPT_LANGUAGE.test(lang)) {
			return this.theme.highlightCode?.(code, lang);
		}
		const html = this.colors?.get(code);
		if (html !== undefined) return paintSyntaxHtml(html);
		if (this.collecting && code.length <= MAX_PAINT_SOURCE_UNITS - this.units) {
			const sources = this.sources ??= [];
			if (sources.length < MAX_PAINT_BLOCKS && !sources.includes(code)) {
				sources.push(code);
				this.units += code.length;
			}
		}
		return undefined;
	};

	finishRender(): void {
		if (!this.collecting) return;
		this.collecting = false;
		const sources = this.sources;
		this.sources = undefined;
		if (sources?.length) {
			this.embeddedLanguages = supportsLanguage("xml");
			this.queue.submit({ owner: new WeakRef(this), generation: this.generation, sources, embeddedLanguages: this.embeddedLanguages });
		}
	}

	refreshGrammar(): void {
		if (this.embeddedLanguages === false && supportsLanguage("xml")) this.reset(true, this.theme);
	}

	defer(generation: number): void {
		// An overtaken waiting message can collect its blocks again on a later layout.
		if (this.isCurrent(generation)) {
			this.units = 0;
			this.collecting = true;
		}
	}

	isCurrent(generation: number): boolean { return generation === this.generation; }

	apply(job: PaintJob, html: string[]): void {
		if (!this.isCurrent(job.generation) || job.sources.length !== html.length) return;
		const colors = new Map<string, string>();
		for (let i = 0; i < html.length; i++) colors.set(job.sources[i]!, html[i]!);
		this.colors = colors;
		this.repaint(this.owner);
	}
}
