import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, toNamespacedPath } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getKeybindings, setKeybindings } from "@super-pi/tui";
import { getConfigDir } from "../packages/coding-agent/src/config.ts";
import { ProjectTrustStore } from "../packages/coding-agent/src/core/trust-manager.ts";
import { loadSkills } from "../packages/coding-agent/src/core/skills.ts";
import { canonicalizePath } from "../packages/coding-agent/src/utils/paths.ts";
import { KeybindingsManager } from "../packages/coding-agent/src/core/keybindings.ts";
import { SessionSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/session-selector.ts";
import { ConfigSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/config-selector.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

function fixture(t: TestContext) {
	const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "sp-canonical-")));
	t.diagnostic(`ownedFixture=${root}`);
	t.after(() => removeOwnedFixture(root));
	const cwd = join(root, "Project", "Child"), agentDir = join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(getConfigDir(agentDir), { recursive: true });
	const trustPath = join(getConfigDir(agentDir), "trust.json"), store = new ProjectTrustStore(agentDir);
	return { root, cwd, agentDir, trustPath, store };
}
const windowsOnly = { skip: process.platform !== "win32" };

test("canonical existing Windows paths agree across case, drive and namespace spellings", windowsOnly, t => {
	const f = fixture(t);
	for (const path of [f.cwd, f.cwd.toUpperCase(), f.cwd.toLowerCase(), toNamespacedPath(f.cwd)]) assert.equal(canonicalizePath(path), f.cwd);
});
test("junction/symlink identity resolves while missing paths retain exact input", t => {
	const f = fixture(t), alias = join(f.root, "Alias");
	fs.symlinkSync(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
	assert.equal(canonicalizePath(alias), f.cwd);
	const missing = join(f.root, "Missing", "child"); assert.equal(canonicalizePath(missing), missing);
});
test("different case-sensitive filesystem objects must not collapse", t => {
	const f = fixture(t), directory = join(f.root, "Sensitive"); fs.mkdirSync(directory);
	if (process.platform === "win32") {
		try { execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", directory, "enable"], { stdio: "pipe", windowsHide: true }); }
		catch { t.skip("Windows filesystem/host does not permit enabling per-directory case sensitivity"); return; }
	}
	const upper = join(directory, "Case"), lower = join(directory, "case");
	fs.mkdirSync(upper); fs.mkdirSync(lower);
	assert.notEqual(fs.statSync(upper, { bigint: true }).ino, fs.statSync(lower, { bigint: true }).ino);
	assert.notEqual(canonicalizePath(upper), canonicalizePath(lower));
	f.store.set(upper, false); f.store.set(lower, true);
	assert.equal(f.store.get(upper), false); assert.equal(f.store.get(lower), true);
});
test("new trust decisions and parent inheritance are independent of Windows spelling", windowsOnly, t => {
	const f = fixture(t);
	f.store.set(dirname(f.cwd).toUpperCase(), false); assert.equal(f.store.get(f.cwd.toLowerCase()), false);
	f.store.set(f.cwd.toUpperCase(), true); assert.equal(f.store.get(f.cwd), true);
	f.store.set(f.cwd.toLowerCase(), null); assert.equal(f.store.get(f.cwd), false);
});
test("legacy Windows denial survives canonical lookup without rewriting the file", windowsOnly, t => {
	const f = fixture(t);
	const original = JSON.stringify({ [f.cwd.toUpperCase()]: false, [dirname(f.cwd)]: true }); fs.writeFileSync(f.trustPath, original);
	assert.deepEqual(f.store.getEntry(f.cwd.toLowerCase()), { path: f.cwd, decision: false });
	assert.equal(fs.readFileSync(f.trustPath, "utf8"), original);
});
test("conflicting legacy aliases fail only for the relevant identity; explicit choice resolves them", windowsOnly, t => {
	const f = fixture(t), other = join(f.root, "Other"); fs.mkdirSync(other);
	const original = JSON.stringify({ [f.cwd.toUpperCase()]: false, [f.cwd.toLowerCase()]: true, [other]: false }); fs.writeFileSync(f.trustPath, original);
	assert.throws(() => f.store.get(f.cwd), /Conflicting trust decisions/);
	assert.equal(f.store.get(other), false); assert.equal(fs.readFileSync(f.trustPath, "utf8"), original);
	f.store.set(f.cwd, false);
	assert.deepEqual(JSON.parse(fs.readFileSync(f.trustPath, "utf8")), { [f.cwd]: false, [other]: false });
	assert.equal(f.store.get(f.cwd), false);
});
test("explicit clear removes only aliases of that directory; null never erases a denial on read", windowsOnly, t => {
	const f = fixture(t), similar = `${f.cwd}-other`; fs.mkdirSync(similar);
	fs.writeFileSync(f.trustPath, JSON.stringify({ [f.cwd.toUpperCase()]: false, [f.cwd.toLowerCase()]: null, [similar]: true }));
	assert.equal(f.store.get(f.cwd), false);
	f.store.set(f.cwd.toLowerCase(), null);
	assert.deepEqual(JSON.parse(fs.readFileSync(f.trustPath, "utf8")), { [similar]: true });
});
test("relative legacy trust keys do not become current-directory grants", t => {
	const f = fixture(t); fs.writeFileSync(f.trustPath, JSON.stringify({ ".": true, "..": true }));
	assert.equal(f.store.get(process.cwd()), null);
});
test("replacing a previously trusted directory with a link does not transfer its decision", t => {
	const f = fixture(t), previous = join(f.root, "PreviouslyTrusted");
	fs.mkdirSync(previous);
	f.store.set(previous, true);
	const original = fs.readFileSync(f.trustPath, "utf8");
	fs.rmdirSync(previous);
	fs.symlinkSync(f.cwd, previous, process.platform === "win32" ? "junction" : "dir");
	assert.equal(f.store.get(f.cwd), null);
	assert.equal(f.store.get(previous), null);
	assert.equal(fs.readFileSync(f.trustPath, "utf8"), original);
	f.store.set(f.cwd, false);
	assert.deepEqual(JSON.parse(fs.readFileSync(f.trustPath, "utf8")), { [previous]: true, [f.cwd]: false });
});
test("trust lookup resolves each recorded absolute identity once before walking ancestors", t => {
	const f = fixture(t), data: Record<string, boolean> = {};
	for (let i = 0; i < 8; i++) { const path = join(f.root, `record-${i}`); fs.mkdirSync(path); data[path] = false; }
	data[dirname(f.cwd)] = false; fs.writeFileSync(f.trustPath, JSON.stringify(data));
	const realpath = fs.realpathSync, native = realpath.native; let legacyCalls = 0, nativeCalls = 0;
	fs.realpathSync = Object.assign((...args: Parameters<typeof realpath>) => { legacyCalls++; return realpath(...args); }, {
		native: (...args: Parameters<typeof native>) => { nativeCalls++; return native(...args); },
	}) as typeof realpath;
	syncBuiltinESMExports();
	try {
		assert.equal(f.store.get(f.cwd), false);
		assert.deepEqual([legacyCalls, nativeCalls], [9, 10], "9 saved-key guards + 9 canonical keys + cwd, no repeated ancestor I/O");
		legacyCalls = 0; nativeCalls = 0;
		f.store.setMany([{ path: f.cwd, decision: false }, { path: dirname(f.cwd), decision: true }]);
		assert.deepEqual([legacyCalls, nativeCalls], [9, 11], "9 saved-key guards + 9 canonical keys + 2 updates, no per-update key resolution");
	} finally { fs.realpathSync = realpath; syncBuiltinESMExports(); }
});
test("Skills silently deduplicate a Windows case alias but retain distinct-file collisions", windowsOnly, t => {
	const f = fixture(t), skill = join(f.root, "Skills", "demo"), distinct = join(f.root, "OtherSkills", "demo");
	for (const path of [skill, distinct]) { fs.mkdirSync(path, { recursive: true }); fs.writeFileSync(join(path, "SKILL.md"), "---\nname: demo\ndescription: Fixture skill\n---\nFixture instructions\n"); }
	const same = loadSkills({ cwd: f.cwd, agentDir: f.agentDir, skillPaths: [skill, skill.toUpperCase()], includeDefaults: false });
	assert.equal(same.skills.length, 1); assert.equal(same.diagnostics.filter(d => d.type === "collision").length, 0);
	const different = loadSkills({ cwd: f.cwd, agentDir: f.agentDir, skillPaths: [skill, distinct], includeDefaults: false });
	assert.equal(different.skills.length, 1); assert.equal(different.diagnostics.filter(d => d.type === "collision").length, 1);
});

test("session selector refuses deleting the active file through a Windows alias", windowsOnly, async t => {
	const f = fixture(t), file = join(f.cwd, "session.jsonl"); fs.writeFileSync(file, "Fixture\n");
	initTheme("dark");
	const previousKeys = getKeybindings(), keybindings = new KeybindingsManager(); setKeybindings(keybindings);
	const load = async () => [{ path: file, id: "fixture", cwd: f.cwd, created: new Date(1), modified: new Date(1), messageCount: 1, firstMessage: "Fixture" }];
	const selector = new SessionSelectorComponent(load, load, () => {}, () => {}, () => {}, () => {}, { agentDir: f.agentDir, keybindings }, file.toUpperCase());
	try {
		await nextTurn(); const list = (selector as any).sessionList; let errors = 0;
		assert.equal(list.allSessions.length, 1);
		list.onError = (message: string) => { assert.match(message, /currently active session/); errors++; };
		selector.handleInput("\u0004");
		assert.equal(errors, 1); assert.equal(list.confirmingDeletePath, null); assert.equal(fs.readFileSync(file, "utf8"), "Fixture\n");
	} finally { selector.dispose(); setKeybindings(previousKeys); }
});

test("session display identity refreshes with the list, while deletion rechecks a retargeted alias", async t => {
	const f = fixture(t), other = join(f.root, "Other"), alias = join(f.root, "Alias"); fs.mkdirSync(other);
	for (const dir of [f.cwd, other]) fs.writeFileSync(join(dir, "session.jsonl"), "Fixture\n");
	fs.symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
	const path = join(alias, "session.jsonl"), entry = { path, id: "fixture", cwd: f.cwd, created: new Date(1), modified: new Date(1), messageCount: 1, firstMessage: "Fixture" };
	const load = async () => [entry], previousKeys = getKeybindings(), keybindings = new KeybindingsManager();
	initTheme("dark"); setKeybindings(keybindings);
	const selector = new SessionSelectorComponent(load, load, () => {}, () => {}, () => {}, () => {}, { agentDir: f.agentDir, keybindings }, join(f.cwd, "session.jsonl"));
	try {
		await nextTurn(); const list = selector.getSessionList() as any; let errors = 0;
		assert.equal(list.currentSessionPaths.has(path), false);
		fs.unlinkSync(alias); fs.symlinkSync(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
		list.onError = () => { errors++; }; selector.handleInput("\u0004");
		assert.equal(errors, 1); assert.equal(list.confirmingDeletePath, null);
		list.setSessions([entry], false); assert.equal(list.currentSessionPaths.has(path), true);
		list.setSessions([], false); assert.equal(list.currentSessionPaths.size, 0);
		list.setSessions([entry], false); selector.dispose(); assert.equal(list.currentSessionPaths.size, 0);
	} finally { selector.dispose(); setKeybindings(previousKeys); }
});

test("configuration mutation refreshes the resource identity after a junction changes", t => {
	const f = fixture(t), other = join(f.root, "Other"), alias = join(f.root, "Alias"); fs.mkdirSync(other);
	for (const dir of [f.cwd, other]) fs.writeFileSync(join(dir, "fixture.md"), "Fixture\n");
	fs.symlinkSync(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
	const path = join(alias, "fixture.md"), settings = SettingsManager.inMemory(); initTheme("dark");
	const component = new ConfigSelectorComponent({
		global: { extensions: [], skills: [{ path, enabled: true, metadata: { source: "local", scope: "user", origin: "top-level", baseDir: f.root } }], prompts: [], themes: [] },
		project: { extensions: [], skills: [], prompts: [], themes: [] },
	}, settings, f.cwd, f.agentDir, () => {}, () => {}, () => {});
	const list = component.getResourceList() as any, item = list.flatItems.find((entry: any) => entry.type === "item").item;
	assert.equal(item.identityKey, `skills:${join(f.cwd, "fixture.md")}`);
	fs.unlinkSync(alias); fs.symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
	list.handleInput(" ");
	assert.equal(item.identityKey, `skills:${join(other, "fixture.md")}`); assert.equal(item.enabled, false);
});

test("trust lookup/update/clear release their maps, including Windows alias conflicts", { skip: !globalThis.gc }, async t => {
	const f = fixture(t);
	fs.writeFileSync(f.trustPath, JSON.stringify({ [f.cwd]: false }));
	const OriginalMap = Map, refs: WeakRef<object>[] = [];
	class ObservedMap extends OriginalMap<unknown, unknown> { constructor(entries?: Iterable<readonly [unknown, unknown]> | null) { super(entries); refs.push(new WeakRef(this)); } }
	try {
		globalThis.Map = ObservedMap as MapConstructor;
		assert.equal(f.store.get(f.cwd), false); f.store.set(f.cwd, false);
		if (process.platform === "win32") {
			fs.writeFileSync(f.trustPath, JSON.stringify({ [f.cwd]: false, [f.cwd.toUpperCase()]: true }));
			assert.throws(() => f.store.get(f.cwd), /Conflicting trust decisions/);
		} else {
			assert.equal(f.store.get(f.cwd), false);
		}
		f.store.set(f.cwd, null); assert.equal(f.store.get(f.cwd), null);
	} finally { globalThis.Map = OriginalMap; }
	assert.ok(refs.length >= 5);
	for (let i = 0; i < 5; i++) { await nextTurn(); globalThis.gc!(); }
	assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0);
	t.diagnostic(`releasedIdentityMaps=${refs.length}`);
});
