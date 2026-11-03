import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CONFIG_DIR_NAME } from "../packages/coding-agent/src/config.ts";
import { DefaultPackageManager } from "../packages/coding-agent/src/core/package-manager.ts";
import { SettingsManager, type PackageSource } from "../packages/coding-agent/src/core/settings-manager.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

function fixture(t: TestContext, local = false) {
	const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "sp-package-identity-")));
	t.diagnostic(`ownedFixture=${root}`); t.after(() => removeOwnedFixture(root));
	const cwd = join(root, "Work"), agentDir = join(root, "Agent"), pkg = join(root, "Packages", "Tool"), other = `${pkg}-other`;
	for (const dir of [join(cwd, CONFIG_DIR_NAME), agentDir, pkg, other]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(join(pkg, "keep.txt"), "Package remains on disk\n");
	const settings = SettingsManager.inMemory(), manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	const base = local ? join(cwd, CONFIG_DIR_NAME) : agentDir;
	const put = (packages: PackageSource[]) => { if (local) settings.setProjectPackages(packages); else settings.setPackages(packages); };
	const get = () => (local ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? [];
	return { root, cwd, agentDir, pkg, other, base, settings, manager, put, get, options: { local } };
}
function link(target: string, alias: string): void { fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir"); }

for (const local of [false, true]) {
	test(`local package removal matches Windows case aliases; projectScope=${local}`, { skip: process.platform !== "win32" }, async t => {
		const f = fixture(t, local); f.put([relative(f.base, f.pkg).toUpperCase(), relative(f.base, f.other)]);
		assert.equal(await f.manager.removeAndPersist(f.pkg.toLowerCase(), f.options), true);
		await f.settings.flush(); assert.deepEqual(f.get(), [relative(f.base, f.other)]);
		assert.equal(fs.readFileSync(join(f.pkg, "keep.txt"), "utf8"), "Package remains on disk\n");
	});
	test(`local removal respects input cwd and settings base through junctions; projectScope=${local}`, async t => {
		const f = fixture(t, local), alias = join(f.cwd, "Alias"); link(f.pkg, alias);
		f.put([relative(f.base, f.pkg), relative(f.base, f.other)]);
		if (local) f.settings.setPackages(["unrelated-global"]); else f.settings.setProjectPackages(["unrelated-project"]);
		assert.equal(await f.manager.removeAndPersist("./Alias", f.options), true);
		await f.settings.flush(); assert.deepEqual(f.get(), [relative(f.base, f.other)]);
		assert.deepEqual((local ? f.settings.getGlobalSettings() : f.settings.getProjectSettings()).packages, [local ? "unrelated-global" : "unrelated-project"]);
		assert.equal(fs.readFileSync(join(alias, "keep.txt"), "utf8"), "Package remains on disk\n");
	});
	test(`adding an alias replaces one configured package and preserves filters; projectScope=${local}`, async t => {
		const f = fixture(t, local), alias = join(f.cwd, "Alias"); link(f.pkg, alias);
		const filters = { autoload: false, skills: ["demo"], extensions: ["!unsafe.ts"] };
		f.put([{ source: relative(f.base, f.pkg), ...filters }, relative(f.base, f.other)]);
		assert.equal(f.manager.addSourceToSettings("./Alias", f.options), true);
		await f.settings.flush(); assert.deepEqual(f.get(), [{ source: relative(f.base, alias), ...filters }, relative(f.base, f.other)]);
		assert.equal(f.manager.addSourceToSettings("./Alias", f.options), false);
	});
}

test("missing local paths retain lexical matching without collapsing different names", async t => {
	const f = fixture(t), missing = join(f.root, "Missing");
	f.put([relative(f.base, missing), relative(f.base, `${missing}-other`)]);
	assert.equal(f.manager.removeSourceFromSettings(missing.toUpperCase()), false);
	assert.equal(f.manager.removeSourceFromSettings(missing), true);
	await f.settings.flush(); assert.deepEqual(f.get(), [relative(f.base, `${missing}-other`)]);
});

test("case-sensitive distinct local package objects remain separate", async t => {
	const f = fixture(t), sensitive = join(f.root, "Sensitive"); fs.mkdirSync(sensitive);
	if (process.platform === "win32") {
		try { execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", sensitive, "enable"], { stdio: "pipe", windowsHide: true }); }
		catch { t.skip("Host cannot enable per-directory case sensitivity"); return; }
	}
	const upper = join(sensitive, "Case"), lower = join(sensitive, "case"); fs.mkdirSync(upper); fs.mkdirSync(lower);
	assert.notEqual(fs.statSync(upper, { bigint: true }).ino, fs.statSync(lower, { bigint: true }).ino);
	f.put([upper, lower]); assert.equal(f.manager.removeSourceFromSettings(upper), true);
	await f.settings.flush(); assert.deepEqual(f.get(), [lower]);
});

test("untrusted project removal refuses before persistence and keeps package files", async t => {
	const f = fixture(t, true); f.put([relative(f.base, f.pkg)]); await f.settings.flush();
	f.settings.setProjectTrusted(false);
	const writes = t.mock.method(f.settings, "setProjectPackages");
	await assert.rejects(f.manager.removeAndPersist(f.pkg, f.options), /Project is not trusted/);
	assert.equal(writes.mock.callCount(), 0); assert.ok(fs.existsSync(join(f.pkg, "keep.txt")));
	f.settings.setProjectTrusted(true); assert.deepEqual(f.get(), [relative(f.base, f.pkg)]);
});

test("npm versions and git refs keep existing package-identity matching without path I/O", async t => {
	const f = fixture(t); f.put(["npm:@fixture/tools@1.0.0", "git:https://github.com/fixture/tools.git@main", "npm:keep@1.0.0"]);
	let calls = 0; const native = fs.realpathSync.native;
	t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { calls++; return native(...args); });
	assert.equal(f.manager.removeSourceFromSettings("npm:@fixture/tools@2.0.0"), true);
	assert.equal(f.manager.removeSourceFromSettings("git:https://github.com/fixture/tools.git@release"), true);
	await f.settings.flush(); assert.deepEqual(f.get(), ["npm:keep@1.0.0"]); assert.equal(calls, 0);
});

for (const operation of ["add", "remove"] as const) for (const size of [1, 100, 1000]) {
	test(`local ${operation} resolves input once across ${size} configured packages`, async t => {
		const f = fixture(t), alias = join(f.cwd, "Alias"); link(f.pkg, alias);
		const packages: string[] = [];
		for (let i = 1; i < size; i++) { const path = join(f.root, `Package-${i}`); fs.mkdirSync(path); packages.push(relative(f.base, path)); }
		packages.push(relative(f.base, f.pkg));
		f.put(packages); await f.settings.flush();
		const native = fs.realpathSync.native; let calls = 0, inputCalls = 0;
		t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { calls++; if (args[0] === alias) inputCalls++; return native(...args); });
		assert.equal(operation === "add" ? f.manager.addSourceToSettings("./Alias") : f.manager.removeSourceFromSettings("./Alias"), true);
		assert.equal(inputCalls, 1); assert.equal(calls, size + 1);
		await f.settings.flush(); assert.equal(f.get().length, operation === "add" ? size : size - 1);
		t.diagnostic(`operation=${operation}; packages=${size}; nativeCalls=${calls}; inputCalls=${inputCalls}`);
	});
}

function observeOldPackages(settings: SettingsManager): WeakRef<object>[] {
	const packages = (settings as any).globalSettings.packages;
	return [new WeakRef(packages), ...packages.map((entry: object) => new WeakRef(entry))];
}
test("replaced package arrays and entries collect after persistence while managers remain live", { skip: !globalThis.gc }, async t => {
	const f = fixture(t), alias = join(f.cwd, "Alias"); link(f.pkg, alias);
	f.put([{ source: relative(f.base, f.pkg), skills: ["demo"] }, { source: relative(f.base, f.other) }]);
	await f.settings.flush(); const refs = observeOldPackages(f.settings);
	assert.equal(f.manager.removeSourceFromSettings("./Alias"), true); await f.settings.flush();
	for (let i = 0; i < 5; i++) { await nextTurn(); globalThis.gc!(); }
	assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0);
	assert.equal(f.get().length, 1); assert.equal(f.manager.removeSourceFromSettings("./Alias"), false);
	t.diagnostic(`releasedOldArrayAndEntries=${refs.length}; managersAlive=true`);
});
