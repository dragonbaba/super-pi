import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import ts from "typescript";
import { CONFIG_DIR_NAME } from "../packages/coding-agent/src/config.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { loadSkills } from "../packages/coding-agent/src/core/skills.ts";
import { canonicalizePath, isPathWithin } from "../packages/coding-agent/src/utils/paths.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

function fixture(t: TestContext) {
	const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "sp-resource-source-")));
	t.diagnostic(`ownedFixture=${root}`);
	const cwd = join(root, "Project"), agentDir = join(root, "Agent"), home = join(root, "Home");
	for (const dir of [cwd, agentDir, home]) fs.mkdirSync(dir);
	const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
	process.env.HOME = home; process.env.USERPROFILE = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
		removeOwnedFixture(root);
	});
	return { root, cwd, agentDir };
}
function link(target: string, alias: string): void { fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir"); }
function skillFile(dir: string, name = "demo"): string {
	fs.mkdirSync(dir, { recursive: true }); const path = join(dir, "SKILL.md");
	fs.writeFileSync(path, `---\nname: ${name}\ndescription: Fixture skill\n---\nFixture instructions\n`); return path;
}
async function disposeLoader(loader: DefaultResourceLoader): Promise<void> {
	const runtime = loader.getExtensions().runtime;
	await runtime.nativeFiles?.dispose(); await runtime.nativeTasks?.dispose();
	await runtime.disposeProviderOwners(); runtime.invalidate();
}

for (const scope of ["user", "project"] as const) {
	test(`explicit Skills paths keep ${scope} source through a directory alias`, t => {
		const f = fixture(t), skillsRoot = join(scope === "user" ? f.agentDir : join(f.cwd, CONFIG_DIR_NAME), "skills");
		skillFile(join(skillsRoot, "demo")); const alias = join(f.root, "Alias"); link(skillsRoot, alias);
		for (const input of [join(alias, "demo"), ...(process.platform === "win32" ? [join(skillsRoot.toUpperCase(), "demo"), toNamespacedPath(join(skillsRoot, "demo"))] : [])]) {
			const loaded = loadSkills({ cwd: f.cwd, agentDir: f.agentDir, skillPaths: [input], includeDefaults: false });
			assert.equal(loaded.skills.length, 1); assert.equal(loaded.skills[0].sourceInfo.scope, scope);
			assert.equal(loaded.skills[0].filePath, join(input, "SKILL.md"));
		}
	});
}

test("actual resource reload classifies a factory override path by its existing default root", async t => {
	const f = fixture(t), extensionsRoot = join(f.agentDir, "extensions"); fs.mkdirSync(extensionsRoot);
	const path = join(extensionsRoot, "fixture.ts");
	const alias = join(f.root, "Alias"); link(extensionsRoot, alias); const aliasedPath = join(alias, "fixture.ts");
	const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [pi => { pi.registerCommand("fixture", { description: "Fixture", handler: async () => {} }); }],
		extensionsOverride: result => {
			// Add the file after package discovery to exercise default provenance.
			fs.writeFileSync(path, "export default () => {};\n");
			result.extensions[0].path = aliasedPath; result.extensions[0].resolvedPath = aliasedPath; return result;
		},
	});
	try {
		await loader.reload(); const extension = loader.getExtensions().extensions[0];
		assert.equal(extension.sourceInfo.scope, "user"); assert.equal(extension.sourceInfo.path, aliasedPath);
		assert.equal(extension.commands.get("fixture")?.sourceInfo, extension.sourceInfo);
	} finally { await disposeLoader(loader); }
});

test("path containment uses complete ancestors and preserves case-sensitive objects", t => {
	const f = fixture(t), sensitive = join(f.root, "Sensitive"); fs.mkdirSync(sensitive);
	if (process.platform === "win32") {
		try { execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", sensitive, "enable"], { stdio: "pipe", windowsHide: true }); }
		catch { t.skip("Host cannot enable per-directory case sensitivity"); return; }
	}
	const upper = join(sensitive, "Case"), lower = join(sensitive, "case"); fs.mkdirSync(upper); fs.mkdirSync(lower);
	const file = skillFile(join(lower, "skills", "demo"));
	assert.notEqual(fs.statSync(upper, { bigint: true }).ino, fs.statSync(lower, { bigint: true }).ino);
	assert.equal(isPathWithin(canonicalizePath(file), canonicalizePath(lower)), true);
	assert.equal(isPathWithin(canonicalizePath(file), canonicalizePath(upper)), false);
	assert.equal(isPathWithin(`${lower}-other`, lower), false);
	assert.equal(isPathWithin(lower, lower), true);
	const loaded = loadSkills({ cwd: f.cwd, agentDir: upper, skillPaths: [file], includeDefaults: false });
	assert.equal(loaded.skills[0].sourceInfo.scope, "temporary");
});

test("similar prefixes and missing Skills paths do not become default sources", t => {
	const f = fixture(t), file = skillFile(join(f.agentDir, "skills-other", "demo"));
	const loaded = loadSkills({ cwd: f.cwd, agentDir: f.agentDir, skillPaths: [file, join(f.root, "Missing")], includeDefaults: false });
	assert.equal(loaded.skills.length, 1); assert.equal(loaded.skills[0].sourceInfo.scope, "temporary");
	assert.ok(loaded.diagnostics.some(entry => entry.message === "skill path does not exist"));
});

for (const size of [1, 100, 1000]) {
	test(`Skills classification resolves its two roots once for ${size} files`, t => {
		const f = fixture(t), paths: string[] = [];
		for (let i = 0; i < size; i++) paths.push(skillFile(join(f.root, `skill-${i}`), `skill-${i}`));
		const native = fs.realpathSync.native, calls = new Map<string, number>();
		t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { const path = String(args[0]); calls.set(path, (calls.get(path) ?? 0) + 1); return native(...args); });
		const loaded = loadSkills({ cwd: f.cwd, agentDir: f.agentDir, skillPaths: paths, includeDefaults: false });
		assert.equal(loaded.skills.length, size);
		assert.equal(calls.get(join(f.agentDir, "skills")), 1); assert.equal(calls.get(join(f.cwd, CONFIG_DIR_NAME, "skills")), 1);
		for (const path of paths) assert.equal(calls.get(path), 2, "one classification + existing same-file deduplication");
		assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), size * 2 + 2);
		t.diagnostic(`skills=${size}; roots=2; classification=${size}; existingDedup=${size}`);
	});
}

function overrideLoader(f: ReturnType<typeof fixture>, paths: string[]): DefaultResourceLoader {
	return new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: paths.map(() => () => {}),
		extensionsOverride: result => { for (let i = 0; i < paths.length; i++) { result.extensions[i].path = paths[i]; result.extensions[i].resolvedPath = paths[i]; } return result; },
	});
}
for (const size of [1, 100, 1000]) {
	test(`default provenance resolves eight roots once for ${size} resources`, async t => {
		const f = fixture(t), paths: string[] = [];
		for (let i = 0; i < size; i++) { const path = join(f.root, `resource-${i}.ts`); fs.writeFileSync(path, "Fixture\n"); paths.push(path); }
		const loader = overrideLoader(f, paths), native = fs.realpathSync.native, calls = new Map<string, number>();
		t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { const path = String(args[0]); calls.set(path, (calls.get(path) ?? 0) + 1); return native(...args); });
		try {
			await loader.reload();
			assert.equal(loader.getExtensions().extensions.length, size);
			assert.ok(loader.getExtensions().extensions.every(extension => extension.sourceInfo.scope === "temporary"));
			for (const base of [f.agentDir, join(f.cwd, CONFIG_DIR_NAME)]) for (const kind of ["skills", "prompts", "themes", "extensions"]) assert.equal(calls.get(join(base, kind)), 1);
			for (const path of paths) assert.equal(calls.get(path), 1);
			assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), size + 8);
			t.diagnostic(`resources=${size}; roots=8; resourceIdentity=${size}`);
		} finally { await disposeLoader(loader); }
	});
}

test("a later resource pass observes a retargeted junction and virtual sources perform no path I/O", async t => {
	const f = fixture(t), root = join(f.agentDir, "extensions"), other = join(f.root, "Outside"), alias = join(f.root, "Alias");
	fs.mkdirSync(root); fs.mkdirSync(other);
	for (const dir of [root, other]) fs.writeFileSync(join(dir, "fixture.ts"), "Fixture\n");
	link(root, alias); const paths = [join(alias, "fixture.ts")], loader = overrideLoader(f, paths);
	try {
		await loader.reload(); assert.equal(loader.getExtensions().extensions[0].sourceInfo.scope, "user");
		fs.unlinkSync(alias); link(other, alias);
		await loader.reload(); assert.equal(loader.getExtensions().extensions[0].sourceInfo.scope, "temporary");
		paths[0] = "<inline:fixture>";
		let calls = 0; const native = fs.realpathSync.native;
		t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { calls++; return native(...args); });
		await loader.reload(); assert.equal(loader.getExtensions().extensions[0].sourceInfo.source, "inline");
		// Package discovery still owns the real default extension file; isolate the resolver below.
		const before = calls; (loader as any).createSourceInfoResolver()("<inline:fixture>"); assert.equal(calls, before);
	} finally { await disposeLoader(loader); }
});

test("source resolvers and root maps release on success and failure while the loader remains live", { skip: !globalThis.gc }, async t => {
	const f = fixture(t), file = join(f.root, "fixture.ts"); fs.writeFileSync(file, "Fixture\n");
	const paths = [file], loader = overrideLoader(f, paths), resolverRefs: WeakRef<object>[] = [], mapRefs: WeakRef<Map<unknown, unknown>>[] = [];
	const OriginalMap = Map, originalFactory = (loader as any).createSourceInfoResolver;
	class ObservedMap extends OriginalMap<unknown, unknown> { constructor(entries?: Iterable<readonly [unknown, unknown]> | null) { super(entries); mapRefs.push(new WeakRef(this)); } }
	(loader as any).createSourceInfoResolver = function (...args: unknown[]) { const resolver = originalFactory.apply(this, args); resolverRefs.push(new WeakRef(resolver)); return resolver; };
	let rootRefs: typeof mapRefs;
	try {
		globalThis.Map = ObservedMap as MapConstructor;
		await loader.reload(); paths[0] = join(f.root, "Missing.ts");
		await assert.rejects(loader.reload(), /ENOENT/);
		rootRefs = mapRefs.filter(ref => ref.deref()?.get(join(f.agentDir, "skills")) === join(f.agentDir, "skills"));
	} finally { globalThis.Map = OriginalMap; (loader as any).createSourceInfoResolver = originalFactory; }
	assert.equal(rootRefs.length, 2); assert.ok(resolverRefs.length >= 5);
	for (let i = 0; i < 5; i++) { await nextTurn(); globalThis.gc!(); }
	assert.equal(rootRefs.filter(ref => ref.deref() !== undefined).length, 0);
	assert.equal(resolverRefs.filter(ref => ref.deref() !== undefined).length, 0);
	assert.equal(loader.getExtensions().extensions.length, 1);
	await disposeLoader(loader);
	t.diagnostic(`releasedResolvers=${resolverRefs.length}; releasedRootMaps=${rootRefs.length}; loaderAlive=true`);
});

test("explicit extension metadata survives a Skills override using an alias", async t => {
	const f = fixture(t), skillsRoot = join(f.agentDir, "skills"); skillFile(join(skillsRoot, "demo"));
	const alias = join(f.root, "Alias"); link(skillsRoot, alias); const aliasedPath = join(alias, "demo", "SKILL.md");
	const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		skillsOverride: result => ({ ...result, skills: result.skills.map(skill => ({ ...skill, filePath: aliasedPath })) }),
	});
	try {
		await loader.reload();
		loader.extendResources({ skillPaths: [
			{ path: skillsRoot, metadata: { source: "declared-fixture", scope: "temporary", origin: "package", baseDir: skillsRoot } },
			{ path: join(skillsRoot, "demo", "SKILL.md"), metadata: { source: "later-specific", scope: "user", origin: "top-level" } },
		] });
		const loaded = loader.getSkills().skills;
		assert.equal(loaded.length, 1); assert.equal(loaded[0].sourceInfo.scope, "temporary");
		assert.equal(loaded[0].sourceInfo.source, "declared-fixture"); assert.equal(loaded[0].sourceInfo.origin, "package");
	} finally { await disposeLoader(loader); }
});

test("extendResources preserves declared provenance for linked descendants outside its root", async t => {
	const f = fixture(t), registered = join(f.root, "Registered"), outside = join(f.root, "Outside");
	fs.mkdirSync(registered); skillFile(outside); link(outside, join(registered, "linked"));
	const displayedPath = join(registered, "linked", "SKILL.md");
	const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
	});
	try {
		await loader.reload();
		const native = fs.realpathSync.native, calls = new Map<string, number>();
		t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { const path = String(args[0]); calls.set(path, (calls.get(path) ?? 0) + 1); return native(...args); });
		loader.extendResources({ skillPaths: [
			{ path: registered, metadata: { source: "declared-linked", scope: "temporary", origin: "package", baseDir: registered } },
			{ path: displayedPath, metadata: { source: "later-specific", scope: "user", origin: "top-level" } },
		] });
		const loaded = loader.getSkills().skills;
		assert.equal(loaded.length, 1); assert.equal(loaded[0].filePath, displayedPath);
		assert.equal(loaded[0].sourceInfo.source, "declared-linked");
		assert.equal(loaded[0].sourceInfo.scope, "temporary"); assert.equal(loaded[0].sourceInfo.origin, "package");
		assert.equal(loaded[0].sourceInfo.baseDir, registered);
		assert.equal(calls.get(registered), 2, "existing merge and Skills classification only");
		assert.equal(calls.get(displayedPath), 4, "existing merge, Skills classification, and two dedup checks only");
		assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), 8, "declared ancestor matching adds no native calls");
		t.diagnostic("linkedDescendantNative=8; existingMergeAndSkills=8; sourceResolver=0");
	} finally { await disposeLoader(loader); }
});

test("reload preserves CLI directory metadata for linked descendants outside its root", async t => {
	const f = fixture(t), registered = join(f.root, "Registered"), outside = join(f.root, "Outside");
	fs.mkdirSync(registered); fs.writeFileSync(join(registered, "index.ts"), "export default () => {};\n");
	skillFile(outside); link(outside, join(registered, "linked"));
	const displayedPath = join(registered, "linked", "SKILL.md");
	const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: [registered], additionalSkillPaths: [registered],
	});
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const loaded = loader.getSkills().skills;
		assert.equal(loaded.length, 1); assert.equal(loaded[0].filePath, displayedPath);
		assert.equal(loaded[0].sourceInfo.source, "cli"); assert.equal(loaded[0].sourceInfo.scope, "temporary");
		assert.equal(loaded[0].sourceInfo.origin, "top-level");
	} finally { await disposeLoader(loader); }
});

for (const size of [1, 100, 1000]) {
	test(`explicit source root resolves once during a ${size}-resource extend pass`, async t => {
		const f = fixture(t), skillsRoot = join(f.agentDir, "skills"), alias = join(f.root, "Alias");
		const files: string[] = [], aliases: string[] = [];
		for (let i = 0; i < size; i++) { files.push(skillFile(join(skillsRoot, `skill-${i}`), `skill-${i}`)); aliases.push(join(alias, `skill-${i}`, "SKILL.md")); }
		link(skillsRoot, alias);
		const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory(),
			noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			skillsOverride: result => ({ ...result, skills: result.skills.map(skill => ({ ...skill, filePath: join(alias, skill.name, "SKILL.md") })) }),
		});
		try {
			await loader.reload();
			const native = fs.realpathSync.native, calls = new Map<string, number>();
			t.mock.method(fs.realpathSync, "native", (...args: Parameters<typeof native>) => { const path = String(args[0]); calls.set(path, (calls.get(path) ?? 0) + 1); return native(...args); });
			loader.extendResources({ skillPaths: [{ path: skillsRoot, metadata: { source: "declared", scope: "temporary", origin: "package", baseDir: skillsRoot } }] });
			assert.equal(loader.getSkills().skills.length, size);
			assert.ok(loader.getSkills().skills.every(skill => skill.sourceInfo.source === "declared" && skill.sourceInfo.scope === "temporary"));
			assert.equal(calls.get(skillsRoot), 4, "merge + Skills root + Skills input + resolver source root, once at each boundary");
			assert.equal(calls.get(join(f.cwd, CONFIG_DIR_NAME, "skills")), 1);
			for (const path of [...files, ...aliases]) assert.equal(calls.get(path), 1);
			assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), size * 2 + 5);
			t.diagnostic(`extendResources=${size}; totalNative=${size * 2 + 5}; sourceRoot=1; priorLoadRootsAndMerge=4`);
		} finally { await disposeLoader(loader); }
	});
}

test("canonical containment helper only walks dirname without I/O, callbacks or containers", () => {
	const source = ts.createSourceFile("paths.ts", fs.readFileSync(new URL("../packages/coding-agent/src/utils/paths.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "isPathWithin")!;
	function walk(node: ts.Node) {
		assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isNewExpression(node) && !ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node) && !ts.isAwaitExpression(node));
		if (ts.isCallExpression(node)) assert.equal(node.expression.getText(source), "dirname");
		ts.forEachChild(node, walk);
	}
	walk(fn.body!);
});
