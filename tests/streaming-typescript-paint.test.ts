import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { AssistantMessage } from "../packages/ai/src/types.ts";
import { RetainedItem } from "@super-pi/tui";
import { AssistantMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { TypeScriptPaintQueue } from "../packages/coding-agent/src/modes/interactive/components/typescript-paint.ts";
import { loadAllHighlightLanguages } from "../packages/coding-agent/src/utils/syntax-highlight.ts";
import { getMarkdownTheme, initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

function completion() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { resolve, promise };
}

function message(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", stopReason, content: [{ type: "text", text }] } as AssistantMessage;
}

test("registry readiness invalidates both finished and outstanding eager-only paint", { timeout: 10_000 }, async (t) => {
	initTheme("dark");
	const queue = new TypeScriptPaintQueue();
	const src = message('```tsx\nconst view = <div className="box">text</div>;\n```', "stop");
	const owners = [new AssistantMessageComponent(), new AssistantMessageComponent()];
	t.after(() => { owners.length = 0; });
	const signals = [completion(), completion()];
	try {
		for (let i = 0; i < owners.length; i++) {
			const owner = owners[i]!;
			owner.enableCodePaint(queue, () => { owner.invalidate(); signals[i]!.resolve(); });
			owner.updateContent(src, true);
			owner.updateContent(src, false);
			owner.render(80);
			if (i === 0) await signals[0]!.promise;
		}
		await loadAllHighlightLanguages();
		const rich = new AssistantMessageComponent(src).render(80);
		for (let i = 0; i < owners.length; i++) {
			signals[i] = completion();
			owners[i]!.invalidate();
			owners[i]!.render(80);
			await signals[i]!.promise;
			assert.deepEqual(owners[i]!.render(80), rich);
		}
	} finally { await queue.close(); }
});

test("streamed TS paint uses parsed blocks, repaints only its completion and survives an identical final body", { timeout: 10_000 }, async (t) => {
	initTheme("dark");
	await loadAllHighlightLanguages();
	const queue = new TypeScriptPaintQueue();
	const theme = getMarkdownTheme();
	const component = new AssistantMessageComponent(undefined, false, theme);
	const item = new RetainedItem(component, { id: "stream", version: 0 });
	// The UI retains a mounted item while the worker holds only a weak owner.
	t.after(() => item.release());
	const painted = completion();
	component.enableCodePaint(queue, owner => {
		assert.equal(owner, component);
		item.invalidate();
		painted.resolve();
	});
	const src = ["```TS", "const x = \"中文\";", "\t/* multiline", "comment */", "```", "", "```tsx", 'const view = <div className="box">value</div>;', 'const cssText = css`body { color: red; }`;', "```", "", "```js", "const y = 10;", "```"].join("\n");
	try {
		component.updateContent(message(src, "stop"), true);
		const mono = item.render(75);
		const reference = new AssistantMessageComponent(message(src, "stop"), false, theme);
		const rich = reference.render(75);
		assert.deepEqual(mono.map(stripVTControlCharacters), rich.map(stripVTControlCharacters));
		assert.notDeepEqual(mono, rich);
		component.updateContent(message(src, "stop"), false);
		item.complete();
		assert.deepEqual(item.render(75), mono);
		await painted.promise;
		assert.deepEqual(item.render(75), rich);
		assert.deepEqual(item.render(34), reference.render(34));
	} finally { await queue.close(); }
});

test("replaced, aborted and retired completions cannot apply stale colors", { timeout: 10_000 }, async (t) => {
	initTheme("dark");
	const queue = new TypeScriptPaintQueue();
	const component = new AssistantMessageComponent();
	const item = new RetainedItem(component, { id: "latest", version: 0 });
	t.after(() => item.release());
	let applied = 0;
	const painted = completion();
	component.enableCodePaint(queue, c => { applied++; c.invalidate(); painted.resolve(); });
	function finish(text: string) {
		component.updateContent(message(text, "stop"), true);
		component.render(80);
		component.updateContent(message(text, "stop"), false);
		component.render(80);
	}
	const src = "```typescript\n" + "// line\n".repeat(500) + "```";
	try {
		finish(src);
		component.updateContent(message(src, "aborted"), false);
		assert.match(component.render(80).join("\n"), /Operation aborted/);
		finish(src + "\nold");
		const latest = src + "\nlatest";
		finish(latest);
		await painted.promise;
		assert.equal(applied, 1);
		assert.deepEqual(component.render(80), new AssistantMessageComponent(message(latest, "stop")).render(80));
		finish(src);
		queue.retire();
		await queue.close();
		await delay(0);
		assert.equal(applied, 1);
	} finally { await queue.close(); }
});
