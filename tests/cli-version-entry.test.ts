import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isStandaloneVersionQuery } from "../packages/coding-agent/src/cli/version-query.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repository, "packages/coding-agent/dist/cli.js");
const launcher = join(repository, "scripts/superpi.mjs");
const version = JSON.parse(readFileSync(join(repository, "packages/coding-agent/package.json"), "utf8")).version;

function fixture(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "cli-version-entry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function run(t: TestContext, root: string, entry: string, args: string[], stubMain = false) {
	const report = join(root, "report.json");
	const probe = join(root, "probe.mjs");
	writeFileSync(probe, `
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({load(url, context, nextLoad) {
  loaded.push(url);
  if (${stubMain} && url === ${JSON.stringify(pathToFileURL(join(dirname(cli), "main.js")).href)}) {
    return {format:'module',shortCircuit:true,source:'export function main(args) { console.log(JSON.stringify({fallback:args})); }'};
  }
  return nextLoad(url, context);
}});
process.on('exit', code => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({loaded,pid:process.pid,code,tmpdir:tmpdir()})));
`);
	const started = new Date().toISOString();
	const child = spawnSync(process.execPath, ["--import", pathToFileURL(probe).href, entry, ...args], {
		cwd: root,
		env: {
			PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
			HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
			SP_CODING_AGENT_DIR: join(root, "agent"), SP_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
			SP_OFFLINE: "1", SP_SKIP_VERSION_CHECK: "1", TMP: root, TEMP: root, TMPDIR: root,
		},
		encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
	});
	t.diagnostic(JSON.stringify({ pid: child.pid, root, started, closed: new Date().toISOString(), code: child.status, signal: child.signal }));
	assert.ifError(child.error);
	assert.ok(existsSync(report), child.stderr || "entry probe did not produce an exit receipt");
	const receipt = JSON.parse(readFileSync(report, "utf8")) as { loaded: string[]; pid: number; code: number; tmpdir: string };
	assert.equal(receipt.tmpdir, root);
	assert.equal(receipt.pid, child.pid);
	assert.equal(receipt.code, child.status);
	return { ...child, loaded: receipt.loaded };
}

test("standalone version predicate excludes command, option-value, terminator and mixed-flag cases", () => {
	for (const args of [["--version"], ["-v"], ["--offline", "--version"], ["-v", "--offline", "--version"]]) {
		assert.equal(isStandaloneVersionQuery(args), true, JSON.stringify(args));
	}
	for (const args of [[], ["--offline"], ["--", "-v"], ["--version", "--help"], ["--model", "--version"],
		["--api-key", "-v"], ["--extension", "--version"], ["--session", "-v"], ["auth", "--version"],
		["config", "--version"], ["install", "-v"], ["hello", "--version"], ["--version=true"], ["--unknown", "-v"]]) {
		assert.equal(isStandaloneVersionQuery(args), false, JSON.stringify(args));
	}
});

for (const entry of [cli, launcher]) test(`version entry excludes runtime modules: ${entry === cli ? "direct" : "source"}`, t => {
	const root = fixture(t);
	for (const args of [["--version"], ["-v", "--offline"]]) {
		const result = run(t, root, entry, args);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), version);
		assert.equal(result.stderr, "");
		assert.ok(result.loaded.some(url => url.endsWith("/dist/config.js")));
		for (const fragment of ["/dist/main.js", "/dist/cli/args.js", "/dist/core/http-dispatcher.js", "/dist/core/settings-manager.js", "/undici/", "/tui/"]) {
			assert.equal(result.loaded.some(url => url.includes(fragment)), false, fragment);
		}
		assert.equal(existsSync(join(root, "agent")), false, "metadata query must not initialize user settings");
		t.diagnostic(JSON.stringify({ pid: result.pid, entry, args, loaded: result.loaded.length, code: result.status }));
	}
	const config = join(root, "agent", "config");
	mkdirSync(config, { recursive: true });
	const settings = join(config, "settings.json");
	writeFileSync(settings, '{"quietStartup":');
	const result = run(t, root, entry, ["--version"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), version);
	assert.equal(readFileSync(settings, "utf8"), '{"quietStartup":');
});

test("mixed invocations reach main with their exact arguments without executing auth or package operations", t => {
	const root = fixture(t);
	for (const args of [["--", "-v"], ["--model", "--version"], ["--api-key", "-v"], ["--extension", "--version"],
		["auth", "--version"], ["config", "-v"], ["install", "--version"], ["--version", "--help"]]) {
		const result = run(t, root, cli, args, true);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).fallback, args);
		assert.ok(result.loaded.some(url => url.endsWith("/dist/main.js")));
	}
});

test("full parser keeps version/help priority and diagnostic errors", t => {
	const root = fixture(t);
	const combined = run(t, root, launcher, ["--version", "--help"]);
	assert.equal(combined.status, 0, combined.stderr);
	assert.equal(combined.stdout.trim(), version);
	assert.ok(combined.loaded.some(url => url.endsWith("/dist/main.js")));
	const invalid = run(t, root, launcher, ["--version", "--execution-environment", "invalid"]);
	assert.equal(invalid.status, 1);
	assert.match(invalid.stderr, /--execution-environment requires sandbox or trusted-host/);
	assert.equal(invalid.stdout.trim(), "");
});

test("extended help still loads explicit extension flags", t => {
	const root = fixture(t), extension = join(root, "help.mjs");
	writeFileSync(extension, 'export default function(pi) { pi.registerFlag("pf02-help-marker", { description: "PF02 help marker", type: "boolean" }); }');
	const result = run(t, root, launcher, ["--help", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--no-tools", "--extension", extension]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /--pf02-help-marker/);
});

test("source version preserves missing dist, malformed bundle settings and missing resource errors", t => {
	const root = fixture(t), fake = join(root, "repository"), scripts = join(fake, "scripts");
	mkdirSync(scripts, { recursive: true });
	writeFileSync(join(fake, "package.json"), '{"type":"module"}');
	const entry = join(scripts, "superpi.mjs");
	writeFileSync(entry, readFileSync(launcher));
	let result = run(t, root, entry, ["--version"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Super Pi CLI is not built/);
	const dist = join(fake, "packages/coding-agent/dist");
	mkdirSync(join(dist, "cli"), { recursive: true });
	writeFileSync(join(dist, "cli.js"), 'throw new Error("bundle validation was skipped")');
	writeFileSync(join(dist, "cli/version-query.js"), readFileSync(join(dirname(cli), "cli/version-query.js")));
	const config = join(fake, ".sp/config");
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "settings.json"), '{"packages":');
	result = run(t, root, entry, ["--version"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /SyntaxError/);
	writeFileSync(join(config, "settings.json"), '{"packages":["../../packages/fixture"]}');
	const pkg = join(fake, "packages/fixture");
	mkdirSync(pkg);
	writeFileSync(join(pkg, "package.json"), '{"pi":{"extensions":["missing.js"]}}');
	result = run(t, root, entry, ["--version"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Bundled Super Pi resource is missing/);
	assert.doesNotMatch(result.stderr, /bundle validation was skipped/);
});
