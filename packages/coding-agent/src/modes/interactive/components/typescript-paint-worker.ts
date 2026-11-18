import { parentPort } from "node:worker_threads";
import hljs from "highlight.js/lib/core.js";
import css from "highlight.js/lib/languages/css.js";
import handlebars from "highlight.js/lib/languages/handlebars.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import xml from "highlight.js/lib/languages/xml.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import { MAX_PAINT_HTML_UNITS } from "./typescript-paint-limits.ts";

hljs.registerLanguage("typescript", typescript);
let embeddedReady = false;
parentPort!.on("message", ({ sources, embeddedLanguages }: { sources: string[]; embeddedLanguages: boolean }) => {
	if (embeddedLanguages && !embeddedReady) {
		// TSX and tagged templates use XML and CSS. XML script bodies also select JS or Handlebars.
		hljs.registerLanguage("xml", xml);
		hljs.registerLanguage("css", css);
		hljs.registerLanguage("javascript", javascript);
		hljs.registerLanguage("handlebars", handlebars);
		embeddedReady = true;
	}
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
