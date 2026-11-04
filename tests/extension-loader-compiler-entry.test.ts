import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const repository = new URL("../", import.meta.url);

function fixture(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "extension-compiler-entry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "cache"));
	return root;
}

function run(t: TestContext, root: string, runtime: "src" | "dist", extension: string, reload = false) {
	const report = join(root, "report.json");
	const script = join(root, "run.mjs");
	const loader = new URL(`packages/coding-agent/${runtime}/core/extensions/loader.${runtime === "src" ? "ts" : "js"}`, repository).href;
	writeFileSync(script, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
const loaded=[];
registerHooks({load(url,context,nextLoad){
  loaded.push(url);
  const result=nextLoad(url,context);
  if(url.endsWith('/jiti/lib/jiti.mjs')||url.endsWith('/jiti/lib/jiti-static.mjs')){
    const text=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
    const needle='return _createJiti(id, opts, {';
    assert.equal(text.split(needle).length,2);
    return {...result,source:text.replace(needle,'opts.fsCache = '+JSON.stringify(${JSON.stringify(join(root, "cache"))})+'; '+needle)};
  }
  return result;
}});
process.on('exit',code=>fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({loaded,pid:process.pid,code,tmpdir:tmpdir()})));
const {loadExtensionsCached,clearExtensionCache}=await import(${JSON.stringify(loader)});
const load=()=>loadExtensionsCached([${JSON.stringify(extension)}],${JSON.stringify(root)});
const [a,b]=await Promise.all([load(),load()]);
for(const result of [a,b]){
  assert.deepEqual(result.errors,[]);
  assert.equal(result.extensions[0].flags.get('value').default,'1');
}
if(${reload}){
  fs.writeFileSync(${JSON.stringify(join(root, "dependency.ts"))},'export enum Value { Current = 2 }');
  clearExtensionCache();
  const result=await load();
  assert.deepEqual(result.errors,[]);
  assert.equal(result.extensions[0].flags.get('value').default,'2');
}
clearExtensionCache();
`);
	const started = new Date().toISOString();
	const child = spawnSync(process.execPath, [script], {
		cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
		env: {
			PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
			HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
			SP_CODING_AGENT_DIR: join(root, "agent"), SP_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
			SP_OFFLINE: "1", SP_SKIP_VERSION_CHECK: "1", TMP: root, TEMP: root, TMPDIR: root,
		},
	});
	t.diagnostic(JSON.stringify({ pid: child.pid, started, closed: new Date().toISOString(), code: child.status, signal: child.signal }));
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	const receipt = JSON.parse(readFileSync(report, "utf8")) as { loaded: string[]; pid: number; code: number; tmpdir: string };
	assert.equal(receipt.tmpdir, root);
	assert.equal(receipt.pid, child.pid);
	assert.equal(receipt.code, 0);
	assert.ok(receipt.loaded.some(url => url.endsWith("/jiti/lib/jiti.mjs")));
	assert.equal(receipt.loaded.some(url => url.endsWith("/jiti/lib/jiti-static.mjs")), false);
	return receipt.loaded.filter(url => url.endsWith("/jiti/dist/babel.cjs")).length;
}

for (const runtime of ["src", "dist"] as const) {
	test(`${runtime}: native extensions avoid the compiler and preserve concurrent factory loads`, t => {
		const root = fixture(t), extension = join(root, "extension.mjs");
		writeFileSync(extension, 'export default pi => pi.registerFlag("value", {type:"string",default:"1"});');
		assert.equal(run(t, root, runtime, extension), 0);
	});

	test(`${runtime}: cold TypeScript compiles, warm cache avoids Babel, edited dependencies reload`, t => {
		const root = fixture(t), extension = join(root, "extension.ts");
		writeFileSync(join(root, "dependency.ts"), "export enum Value { Current = 1 }");
		writeFileSync(extension, 'import {Value} from "./dependency.ts"; export default pi => pi.registerFlag("value", {type:"string",default:String(Value.Current)});');
		assert.equal(run(t, root, runtime, extension), 1);
		assert.equal(run(t, root, runtime, extension), 0);
		assert.equal(run(t, root, runtime, extension, true), 1);
	});
}
