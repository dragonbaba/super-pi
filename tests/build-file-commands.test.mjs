import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const shx = join(dirname(require.resolve("shx/package.json")), "lib/cli.js");

function fixture(t) {
	const parent = resolve(tmpdir());
	const root = mkdtempSync(join(parent, "super-pi-build files-"));
	t.after(() => {
		assert.equal(dirname(root), parent);
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

function run(root, ...args) {
	// Pass globs literally, as npm does on Windows; shx must expand them itself.
	const result = spawnSync(process.execPath, [shx, ...args], {
		cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null);
	return result;
}

function succeed(root, ...args) {
	const result = run(root, ...args);
	assert.equal(result.status, 0, result.stderr);
}

test("build file commands replace recursive provider data without retaining stale files", (t) => {
	const root = fixture(t);
	mkdirSync(join(root, "src/providers/data/nested"), { recursive: true });
	writeFileSync(join(root, "src/providers/data/nested/model.json"), '{"id":"fixture"}');
	mkdirSync(join(root, "dist/providers/data"), { recursive: true });
	writeFileSync(join(root, "dist/providers/data/stale.json"), "stale");
	writeFileSync(join(root, "dist/providers/index.js"), "preserve sibling");
	succeed(root, "rm", "-rf", "dist/providers/data");
	succeed(root, "cp", "-r", "src/providers/data", "dist/providers/data");
	assert.equal(readFileSync(join(root, "dist/providers/data/nested/model.json"), "utf8"), '{"id":"fixture"}');
	assert.equal(existsSync(join(root, "dist/providers/data/stale.json")), false);
	assert.equal(readFileSync(join(root, "dist/providers/index.js"), "utf8"), "preserve sibling");
	const output = resolve(root, "dist");
	assert.equal(dirname(output), root);
	succeed(root, "rm", "-rf", output);
	succeed(root, "rm", "-rf", output);
	assert.equal(existsSync(output), false);
	assert.equal(existsSync(join(root, "src/providers/data/nested/model.json")), true);
});

test("asset copy expands globs and handles multiple sources and paths with spaces", (t) => {
	const root = fixture(t);
	mkdirSync(join(root, "source assets"));
	for (const [name, value] of [["dark.json", "dark"], ["light.json", "light"], ["logo.png", "image"],
		["template.html", "html"], ["template.css", "css"], ["template.js", "js"]]) {
		writeFileSync(join(root, "source assets", name), value);
	}
	succeed(root, "mkdir", "-p", "dist/theme", "dist/assets", "dist/export/vendor");
	succeed(root, "mkdir", "-p", "dist/theme");
	succeed(root, "cp", "source assets/*.json", "dist/theme/");
	succeed(root, "cp", "source assets/*.png", "dist/assets/");
	succeed(root, "cp", "source assets/template.html", "source assets/template.css", "source assets/template.js", "dist/export/");
	succeed(root, "cp", "source assets/*.js", "dist/export/vendor/");
	assert.deepEqual(readdirSync(join(root, "dist/theme")).sort(), ["dark.json", "light.json"]);
	assert.equal(readFileSync(join(root, "dist/theme/dark.json"), "utf8"), "dark");
	assert.equal(readFileSync(join(root, "dist/assets/logo.png"), "utf8"), "image");
	for (const [extension, value] of [["html", "html"], ["css", "css"], ["js", "js"]]) {
		assert.equal(readFileSync(join(root, `dist/export/template.${extension}`), "utf8"), value);
	}
	assert.equal(readFileSync(join(root, "dist/export/vendor/template.js"), "utf8"), "js");
	assert.notEqual(run(root, "cp", "source assets/missing-*.json", "dist/theme/").status, 0);
});

test("CLI build marks both entry points executable and reports missing inputs", (t) => {
	const root = fixture(t);
	mkdirSync(join(root, "dist"));
	for (const name of ["cli.js", "rpc-entry.js"]) {
		writeFileSync(join(root, "dist", name), "#!/usr/bin/env node\n", { mode: 0o644 });
	}
	succeed(root, "chmod", "+x", "dist/cli.js", "dist/rpc-entry.js");
	for (const name of ["cli.js", "rpc-entry.js"]) {
		assert.equal(readFileSync(join(root, "dist", name), "utf8"), "#!/usr/bin/env node\n");
		if (process.platform !== "win32") assert.equal(statSync(join(root, "dist", name)).mode & 0o111, 0o111);
	}
	assert.notEqual(run(root, "chmod", "+x", "dist/missing.js").status, 0);
});
