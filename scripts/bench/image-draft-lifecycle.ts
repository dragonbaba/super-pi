import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { fixture } from "../../tests/helpers/evidence-ledger-fixture.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

// Deliberately separate from heap-sampled throughput benchmarks. Counters wrap
// real I/O/encoding/projection methods; no declared or prefilled zero budgets.
initTheme("dark");
const f = await fixture(false, false);
const mode: any = new InteractiveMode({ session: f.session, setBeforeSessionInvalidate() {}, setRebindSession() {} } as never);
const path = join(f.root, "pixel.png");
writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));
const probe = await open(path, "r"); const proto = Object.getPrototypeOf(probe); await probe.close();
const originalRead = proto.read, originalString = Buffer.prototype.toString;
const originalProjection = mode.defaultEditor.setAttachmentText;
let reads = 0, encodes = 0, projections = 0;
proto.read = function (...args: any[]) { reads++; return originalRead.apply(this, args); };
Buffer.prototype.toString = function (...args: any[]) { if (args[0] === "base64") encodes++; return originalString.apply(this, args as never); };
mode.defaultEditor.setAttachmentText = function (text: string) { projections++; return originalProjection.call(this, text); };
const refs: WeakRef<object>[] = [];
try {
	for (let i = 0; i < 1000; i++) { mode.editor.setText(`plain ${i}`); mode.defaultEditor.render(80); }
	const ordinary = { reads, encodes, projections };
	await mode.imageDraft.addFiles([path], f.cwd);
	assert.equal(mode.imageDraft.items[0].state, "ready");
	const receive = { reads, encodes, projections };
	for (let i = 0; i < 1000; i++) { mode.editor.setText(`attached ${i}`); mode.defaultEditor.render(i % 2 ? 80 : 100); }
	const steady = { reads, encodes, projections };
	refs.push(new WeakRef(mode.imageDraft.items[0]), new WeakRef(mode.imageDraft.items[0].image));
	mode.imageDraft.clear();
	const start = performance.now();
	const pending = mode.imageDraft.addFiles([path], f.cwd); mode.imageDraft.clear(); await pending;
	const cancelMs = performance.now() - start;
	for (let i = 0; i < 6; i++) { await turn(); global.gc?.(); }
	const released = refs.filter(ref => ref.deref() === undefined).length;
	assert.deepEqual(ordinary, { reads: 0, encodes: 0, projections: 0 });
	assert.deepEqual(steady, receive);
	assert.equal(mode.imageDraft.items.length, 0);
	if (global.gc) assert.equal(released, refs.length);
	console.log(JSON.stringify({ ordinary, receive, steady, cancelMs, recordsAfter: mode.imageDraft.items.length,
		weakReleased: global.gc ? released : "run with --expose-gc", weakTotal: refs.length }));
} finally {
	proto.read = originalRead; Buffer.prototype.toString = originalString; mode.imageDraft.clear(); f.close();
}
