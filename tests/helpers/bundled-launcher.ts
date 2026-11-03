import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Run the real source launcher, intercepting only its final CLI import. */
export function captureBundledArguments(repositoryRoot: string, fixture: string, cases: readonly string[][]): string[][] {
	const cli = pathToFileURL(join(repositoryRoot, "packages/coding-agent/dist/cli.js")).href;
	const launcher = pathToFileURL(join(repositoryRoot, "scripts/superpi.mjs")).href;
	const script = `
		import { registerHooks } from 'node:module';
		registerHooks({ load(url, context, nextLoad) {
			if (url === ${JSON.stringify(cli)}) return { format: 'module', shortCircuit: true, source: '' };
			return nextLoad(url, context);
		} });
		const results = [];
		for (const [index, args] of ${JSON.stringify(cases)}.entries()) {
			process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(launcher))}, ...args];
			await import(${JSON.stringify(launcher)} + '?case=' + index);
			results.push(process.argv.slice(2));
		}
		console.log(JSON.stringify(results));
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: fixture,
		env: { SystemRoot: process.env.SystemRoot, TEMP: fixture, TMP: fixture, TMPDIR: fixture,
			SP_CODING_AGENT_DIR: join(fixture, "agent") },
		encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
	});
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}
