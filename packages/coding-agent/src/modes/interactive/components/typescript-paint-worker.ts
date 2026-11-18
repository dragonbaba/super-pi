import { parentPort } from "node:worker_threads";
import hljs from "highlight.js/lib/core.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import { MAX_PAINT_HTML_UNITS } from "./typescript-paint-limits.ts";

hljs.registerLanguage("typescript", typescript);
parentPort!.on("message", (sources: string[]) => {
	let units = 0;
	const html: string[] = [];
	for (const code of sources) {
		const value = hljs.highlight(code, { language: "typescript", ignoreIllegals: true }).value;
		units += value.length;
		if (units > MAX_PAINT_HTML_UNITS) {
			parentPort!.postMessage(null);
			return;
		}
		html.push(value);
	}
	parentPort!.postMessage(html);
});
