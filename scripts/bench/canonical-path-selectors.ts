import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getKeybindings, setKeybindings, type Component } from "@super-pi/tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import type { ResolvedPaths } from "../../packages/coding-agent/src/core/package-manager.ts";
import { SessionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/session-selector.ts";
import { ConfigSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/config-selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { removeOwnedFixture } from "../../tests/helpers/owned-fixture-cleanup.ts";

const smoke = process.argv.includes("--smoke"), sourcePath = "packages/coding-agent/src/utils/paths.ts";
const source = fs.readFileSync(sourcePath, "utf8"), nativeImplementation = source.includes("return realpathSync.native(path)");
const sessionSource = fs.readFileSync("packages/coding-agent/src/modes/interactive/components/session-selector.ts", "utf8");
const configSource = fs.readFileSync("packages/coding-agent/src/modes/interactive/components/config-selector.ts", "utf8");
const displayIdentityCached = sessionSource.includes("this.currentSessionPaths.has(session.path)") && configSource.includes("return item.identityKey");
const warmup = 20, timingIterations = 1024, profileIterations = 64, samplingInterval = 1024;
assert.ok(globalThis.gc, "run with --expose-gc");
const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "sp-selector-paths-")));
console.error(`ownedFixture=${root}`);
const previousKeys = getKeybindings();
function noop() {}
async function gc() { for (let i = 0; i < 5; i++) { await nextTurn(); globalThis.gc!(); } }

async function fixture(kind: "session" | "config") {
	const files: string[] = [];
	for (let i = 0; i < 30; i++) { const file = join(root, `${kind}-${i}.md`); fs.writeFileSync(file, "Fixture\n"); files.push(file); }
	if (kind === "session") {
		const sessions = files.map((path, i) => ({ path, id: `fixture-${i}`, cwd: root, created: new Date(1), modified: new Date(1), messageCount: i + 1, firstMessage: `Fixture session ${i}` }));
		const load = async () => sessions;
		const component = new SessionSelectorComponent(load, load, noop, noop, noop, noop, { agentDir: root, keybindings: new KeybindingsManager() }, files[0]);
		await nextTurn();
		assert.equal((component as any).sessionList.allSessions.length, 30);
		return { component, dispose() { component.dispose(); } };
	}
	const empty = (): ResolvedPaths => ({ extensions: [], skills: [], prompts: [], themes: [] });
	const global = empty(), project = empty();
	for (const path of files) {
		global.skills.push({ path, enabled: true, metadata: { source: "local", scope: "user", origin: "top-level", baseDir: root } });
		project.skills.push({ path, enabled: true, metadata: { source: "local", scope: "project", origin: "top-level", baseDir: root } });
	}
	const component = new ConfigSelectorComponent({ global, project }, SettingsManager.inMemory(), root, root, noop, noop, noop, 24, "project");
	return { component, dispose: noop };
}

function observePaths() {
	const realpath = fs.realpathSync, native = realpath.native;
	const counts = { legacyCalls: 0, nativeCalls: 0 };
	const counted = ((...args: Parameters<typeof realpath>) => { counts.legacyCalls++; return realpath(...args); }) as typeof realpath;
	counted.native = ((...args: Parameters<typeof native>) => { counts.nativeCalls++; return native(...args); }) as typeof native;
	fs.realpathSync = counted; syncBuiltinESMExports();
	return { counts, restore() { fs.realpathSync = realpath; syncBuiltinESMExports(); } };
}
function count(component: Component) {
	const observer = observePaths();
	try { const lines = component.render(100); return { ...observer.counts, lines: lines.length, codeUnits: lines.reduce((sum, line) => sum + line.length, 0) }; }
	finally { observer.restore(); }
}
function collectFrames(component: Component) { const refs: WeakRef<object>[] = []; for (let i = 0; i < 32; i++) refs.push(new WeakRef(component.render(100))); return refs; }
function replaceSessionList(component: SessionSelectorComponent): WeakRef<object> {
	const list = component.getSessionList() as any;
	const previous = new WeakRef(list.currentSessionPaths);
	list.setSessions(list.allSessions, false);
	return previous;
}
function profileStats(root: any) {
	let total = 0; const sites = new Map<string, number>();
	function visit(node: any) { total += node.selfSize; const label = `${node.callFrame.functionName || "(anonymous)"}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`; sites.set(label, (sites.get(label) ?? 0) + node.selfSize); for (const child of node.children) visit(child); }
	visit(root); return { total, topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 8) };
}
async function measure(component: Component) {
	for (let i = 0; i < warmup; i++) component.render(100);
	await gc(); const before = process.memoryUsage(), cpu = process.cpuUsage(), times: number[] = [];
	for (let i = 0; i < timingIterations; i++) { const start = performance.now(); component.render(100); times.push(performance.now() - start); }
	const elapsedCpu = process.cpuUsage(cpu); await gc(); const after = process.memoryUsage();
	const session = new Session(); session.connect(); let profile;
	try {
		await session.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		for (let i = 0; i < profileIterations; i++) component.render(100);
		profile = (await session.post("HeapProfiler.stopSampling")).profile;
	} finally { session.disconnect(); }
	const allocations = profileStats(profile.head); times.sort((a, b) => a - b);
	return { p95Ms: times[Math.ceil(times.length * 0.95) - 1], cpuUsPerFrame: (elapsedCpu.user + elapsedCpu.system) / timingIterations,
		sampledBytesPerFrame: allocations.total / profileIterations, topSites: allocations.topSites, before, after };
}
const rows = [];
try {
	initTheme("dark"); setKeybindings(new KeybindingsManager());
	for (const kind of ["session", "config"] as const) {
		const setup = observePaths(); let owner: Awaited<ReturnType<typeof fixture>> | undefined;
		try { owner = await fixture(kind); } finally { setup.restore(); }
		const counters = count(owner.component);
		if (displayIdentityCached) assert.equal(counters.legacyCalls + counters.nativeCalls, 0);
		else assert.ok(counters.legacyCalls + counters.nativeCalls > 0);
		if (nativeImplementation) assert.equal(counters.legacyCalls, 0);
		let previousIdentitySet: WeakRef<object> | undefined;
		if (kind === "session" && displayIdentityCached) {
			previousIdentitySet = replaceSessionList(owner.component as SessionSelectorComponent);
		}
		const frames = collectFrames(owner.component); await gc();
		const retainedFrames = frames.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0); assert.equal(retainedFrames, 0);
		const retainedPreviousIdentitySet = previousIdentitySet?.deref() !== undefined; assert.equal(retainedPreviousIdentitySet, false);
		const profile = smoke ? undefined : await measure(owner.component);
		const componentRef = new WeakRef(owner.component); owner.dispose(); owner = undefined;
		await gc(); const retainedComponent = componentRef.deref() !== undefined; assert.equal(retainedComponent, false);
		rows.push({ kind, setupCalls: setup.counts, counters, retainedFrames, retainedPreviousIdentitySet, retainedComponent, profile });
	}
} finally { setKeybindings(previousKeys); removeOwnedFixture(root); }
console.log(JSON.stringify({ node: process.version, platform: process.platform, nativeImplementation, displayIdentityCached, sourceSha256: createHash("sha256").update(source).digest("hex"),
	selectorHashes: { session: createHash("sha256").update(sessionSource).digest("hex"), config: createHash("sha256").update(configSource).digest("hex") },
	warmup, timingIterations, profileIterations, samplingInterval, rows,
	notes: "Actual selector render consumers; existing layout work included. Setup/list loading counted separately and excluded from frame timing. Counts are API calls, not OS syscalls. Final display uses loaded identities; mutation checks still resolve on demand. Frames collect while selector lives; selector collects after disposal/release." }, null, 2));
