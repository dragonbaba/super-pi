// Explicit Windows acceptance only; never imported by production or the CI test matrix.
// Usage: node scripts/acceptance/windows-mxc-preflight.mjs <official wxc-exec.exe> <new report.json>
//   [--allow-win32k] [--file-entry] [--desktop-shared-clipboard] [--query-ancestors]
//   [--readonly-project=<path> --read-relative=<file>] [--powershell=<pwsh.exe>]
// The desktop profile allows clipboard sharing; this script never calls clipboard APIs.
// Profiles are explicit, never a retry/fallback or a production policy change.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WindowsShellJob, windowsShellJobDiagnostics } from "../../packages/coding-agent/src/utils/windows-shell-job.ts";
import { waitForChildProcess } from "../../packages/coding-agent/src/utils/child-process.ts";

const EXECUTOR_SHA256 = "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a";
const STDIN = "中文标准输入\nsecond line\n";
const ARGUMENT = '空 格 "quoted" & | $() \\';
const OUTPUT_LIMIT = 64 * 1024;
const DEADLINE_MS = 15_000;

// Only this controlled workload runs inside MXC. No credentials or public network access.
const WORKLOAD = String.raw`
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
const [mode, root, port, literal, project, readRelative] = process.argv.slice(1);
const workspace = path.join(root, "工作区 space");
if (mode === "cancel") {
  const ready = path.join(workspace, "descendant-ready");
  const child = spawn(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1],"ready"); setInterval(()=>{},1000)', ready], {stdio:"ignore"});
  child.on("error", error => { console.error(error.code); process.exit(1); });
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10));
  if (!fs.existsSync(ready)) throw new Error("Descendant did not become ready");
  console.log(JSON.stringify({ready:true, childPid:child.pid}));
  setInterval(()=>{},1000);
} else {
  const result = {cwd:process.cwd(), literal, stdin:fs.readFileSync(0,"utf8"), imports:typeof fileImports === "undefined" ? null : fileImports};
  function attempt(name, operation) {
    try { result[name] = {ok:true, value:operation()}; }
    catch(error) { result[name] = {ok:false, code:error.code}; }
  }
  if (project) {
    result.project = { entries:fs.readdirSync(project).length,
      documentBytes:fs.readFileSync(path.join(project,readRelative)).length };
  }
  attempt("workspaceRead", () => fs.readFileSync(path.join(workspace,"中文.txt"),"utf8"));
  attempt("workspaceWrite", () => fs.writeFileSync(path.join(workspace,"中文.txt"),"allowed"));
  attempt("workspaceRenameDelete", () => {
    const before = path.join(workspace,"rename-before"), after = path.join(workspace,"rename-after");
    fs.writeFileSync(before,"owned fixture"); fs.renameSync(before,after); fs.unlinkSync(after); return true;
  });
  attempt("protectedWrite", () => fs.writeFileSync(path.join(workspace,".sp","canary"),"forbidden"));
  attempt("protectedDelete", () => fs.unlinkSync(path.join(workspace,".sp","canary")));
  attempt("protectedRename", () => fs.renameSync(path.join(workspace,".sp"),path.join(workspace,"moved-metadata")));
  attempt("tempWrite", () => fs.writeFileSync(path.join(root,"temporary","scratch"),"allowed"));
  attempt("toolRead", () => fs.readFileSync(path.join(root,"tools","canary"),"utf8"));
  attempt("toolWrite", () => fs.writeFileSync(path.join(root,"tools","canary"),"forbidden"));
  attempt("outsideRead", () => fs.readFileSync(path.join(root,"outside","canary"),"utf8"));
  attempt("outsideWrite", () => fs.writeFileSync(path.join(root,"outside","new"),"forbidden"));
  attempt("ungrantedRead", () => fs.readFileSync(path.join(root,"ungranted","canary"),"utf8"));
  attempt("ungrantedList", () => fs.readdirSync(path.join(root,"ungranted")));
  attempt("ancestorContentRead", () => fs.readFileSync(path.join(root,"ancestor-canary"),"utf8"));
  attempt("ancestorMetadata", () => fs.statSync(root).isDirectory());
  attempt("driveRootMetadata", () => fs.lstatSync(path.parse(root).root).isDirectory());
  attempt("junctionRead", () => fs.readFileSync(path.join(workspace,"escape","canary"),"utf8"));
  result.loopback = await new Promise(resolve => {
    const socket = net.createConnection({host:"127.0.0.1",port:Number(port)});
    function finish(connected,code) { socket.destroy(); resolve({connected,code}); }
    socket.once("connect",()=>finish(true));
    socket.once("error",error=>finish(false,error.code));
    socket.setTimeout(1000,()=>finish(false,"TIMEOUT"));
  });
  console.log(JSON.stringify(result));
}
`;

const report = { version: "mxc-1.0.1-preflight", node: process.version, nodePath: process.execPath, checks: [] };
let fixture;
let fixtureParent;
let server;
let cleanupConfirmed = true;
let connections = 0;
let junctionCreated = false;

function check(name, operation) {
	operation();
	report.checks.push(name);
}

async function invoke(executor, args, cwd, env, cancelWhenReady = false) {
	cleanupConfirmed = false;
	const job = await WindowsShellJob.spawn(executor, args, cwd, env, true);
	const observation = { started: false, exitCode: null, signal: null, outputDrained: false };
	const waiting = waitForChildProcess(job.child, observation);
	// Observe early rejection even while a deadline is unwinding the native owner.
	const observed = waiting.then(code => ({ code }), error => ({ error }));
	let output = "", errors = "", bytes = 0, overflow = false, expired = false, canceled = false, protocolError;
	let descendantPid;
	function onData(chunk) {
		bytes += Buffer.byteLength(chunk, "utf8");
		if (bytes > OUTPUT_LIMIT) { overflow = true; void job.stop(); return; }
		output += chunk;
		if (cancelWhenReady && !canceled && output.includes("\n")) {
			try {
				const ready = JSON.parse(output.trim());
				if (ready.ready === true && Number.isSafeInteger(ready.childPid) && ready.childPid > 0) {
					descendantPid = ready.childPid; canceled = true; void job.stop();
				}
			} catch (error) { protocolError = error; void job.stop(); }
		}
	}
	function onErrorData(chunk) {
		bytes += Buffer.byteLength(chunk, "utf8");
		if (bytes > OUTPUT_LIMIT) { overflow = true; void job.stop(); return; }
		errors += chunk;
	}
	function onInputError(error) { if (error.code !== "EPIPE") errors += String(error).slice(0, 1000); }
	job.child.stdout.setEncoding("utf8");
	job.child.stderr.setEncoding("utf8");
	job.child.stdout.on("data", onData);
	job.child.stderr.on("data", onErrorData);
	job.child.stdin.on("error", onInputError);
	job.child.stdin.end(STDIN);
	let timer;
	try {
		const deadline = new Promise(resolve => { timer = setTimeout(() => { expired = true; void job.stop(); resolve({}); }, DEADLINE_MS); });
		const outcome = await Promise.race([observed, deadline]);
		if (outcome.error) throw outcome.error;
		if (protocolError) throw protocolError;
		return { code: outcome.code, output, errors, expired, overflow, canceled, descendantPid, observation };
	} finally {
		clearTimeout(timer);
		const failure = await job.stop();
		job.child.stdout.removeListener("data", onData);
		job.child.stderr.removeListener("data", onErrorData);
		if (failure) {
			throw new Error(failure);
		}
		cleanupConfirmed = true;
		assert.equal(job.launchError, undefined);
		assert.equal(job.dispatchError, undefined);
	}
}

function requireSuccess(result) {
	assert.equal(result.expired, false, "Executor deadline reached");
	assert.equal(result.overflow, false, "Executor output limit reached");
	assert.equal(result.code, 0, result.errors || result.output);
	assert.equal(result.observation.outputDrained, true, "Output drain was not confirmed");
	assert.equal(result.errors, "", "Unexpected executor diagnostics: " + result.errors);
	return JSON.parse(result.output);
}

function denied(result) {
	assert.equal(result.ok, false);
	assert.ok(["EACCES", "EPERM", "ENOENT"].includes(result.code), "Unexpected denial: " + result.code);
}

async function main() {
	assert.equal(process.platform, "win32");
	assert.equal(process.arch, "x64", "Only the pinned Windows x64 artifact is reviewed");
	const options = new Set(process.argv.slice(4));
	assert.ok(process.argv.length >= 4 && options.size === process.argv.length - 4 && [...options].every(option => ["--allow-win32k", "--file-entry", "--desktop-shared-clipboard", "--query-ancestors"].includes(option)
		|| ["--readonly-project=", "--read-relative=", "--powershell="].some(prefix => option.startsWith(prefix))), "Invalid acceptance options");
	function optionValue(prefix) {
		const found = [...options].filter(option => option.startsWith(prefix));
		assert.ok(found.length <= 1, "Repeated " + prefix);
		return found.length ? found[0].slice(prefix.length) : "";
	}
	const desktopSharedClipboard = options.has("--desktop-shared-clipboard");
	const queryAncestors = options.has("--query-ancestors");
	const allowWin32k = options.has("--allow-win32k") || desktopSharedClipboard;
	const projectOption = optionValue("--readonly-project="), readRelative = optionValue("--read-relative=");
	const project = projectOption ? fs.realpathSync(projectOption) : "";
	if (project) assert.ok(fs.statSync(project).isDirectory(), "Read-only project must be a directory");
	assert.equal(Boolean(project), Boolean(readRelative), "Pair --readonly-project with --read-relative");
	if (project) {
		const relative = path.relative(project, fs.realpathSync(path.resolve(project, readRelative)));
		assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "Read target must stay inside project");
	}
	const powershellOption = optionValue("--powershell="), powershell = powershellOption ? fs.realpathSync(powershellOption) : "";
	const fileEntry = options.has("--file-entry");
	report.profile = desktopSharedClipboard ? "desktop-shared-clipboard" : allowWin32k ? "win32k-compatible" : "no-win32k";
	report.nodeEntry = fileEntry ? "file-with-preserve-symlinks-flags" : "controlled-inline-module";
	const executor = fs.realpathSync(process.argv[2]);
	const reportPath = path.resolve(process.argv[3]);
	assert.equal(fs.existsSync(reportPath), false, "Refusing to overwrite an earlier report");
	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(executor)) hash.update(chunk);
	assert.equal(hash.digest("hex"), EXECUTOR_SHA256, "Executor differs from the reviewed official artifact");
	report.executorSha256 = EXECUTOR_SHA256;
	fixtureParent = fs.realpathSync(os.tmpdir());
	fixture = fs.mkdtempSync(path.join(fixtureParent, "superpi-mxc-"));
	report.fixture = fixture;
	const workspace = path.join(fixture, "工作区 space");
	const temporary = path.join(fixture, "temporary");
	const state = path.join(fixture, "dacl-state");
	const tools = path.join(fixture, "tools");
	for (const directory of [workspace, temporary, state, tools, path.join(fixture, "outside"), path.join(fixture, "ungranted")]) fs.mkdirSync(directory);
	// Stop Node's package-scope discovery inside the granted fixture. A fixture
	// under a repository must not need access to that repository's package.json.
	fs.writeFileSync(path.join(tools, "package.json"), '{"type":"module"}');
	fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"commonjs"}');
	const protectedDirectory = path.join(workspace, ".sp");
	fs.mkdirSync(protectedDirectory);
	fs.writeFileSync(path.join(protectedDirectory, "canary"), "unchanged");
	for (const directory of [tools, path.join(fixture, "outside"), path.join(fixture, "ungranted")]) fs.writeFileSync(path.join(directory, "canary"), "unchanged");
	fs.writeFileSync(path.join(workspace, "中文.txt"), "initial");
	fs.writeFileSync(path.join(fixture, "ancestor-canary"), "unreadable-parent-content");
	fs.symlinkSync(path.join(fixture, "outside"), path.join(workspace, "escape"), "junction");
	junctionCreated = true;
	const enumeratePaths = [];
	if (queryAncestors) {
		// Directory queries let ordinary Node loaders walk ancestors. This grants
		// metadata/listing, not file contents or writes, and never scans a tree.
		const ancestors = new Set();
		for (const directory of [workspace, temporary, tools, path.dirname(process.execPath), ...(powershell ? [path.dirname(powershell)] : [])]) {
			for (let parent = path.dirname(directory);;) {
				ancestors.add(parent); const next = path.dirname(parent); if (next === parent) break; parent = next;
			}
		}
		enumeratePaths.push(...ancestors);
	}
	const workload = path.join(tools, "中文 entry.mjs");
	if (fileEntry) {
		fs.mkdirSync(path.join(tools, "nested"));
		fs.writeFileSync(path.join(tools, "nested", "module.mjs"), 'export const marker = "esm-loaded";');
		fs.writeFileSync(path.join(tools, "nested", "module.cjs"), 'module.exports = "commonjs-loaded";');
		const imports = 'import { marker } from "./nested/module.mjs";\nimport { createRequire } from "node:module";\nconst fileImports = [marker, createRequire(import.meta.url)("./nested/module.cjs")];\n';
		fs.writeFileSync(workload, imports + WORKLOAD.replace("process.argv.slice(1)", "process.argv.slice(2)"));
	}
	report.enumeratePaths = enumeratePaths;
	// Node's maintained loader flags avoid ancestor realpath walks without adding
	// recursive directory-enumeration grants. Scoped to this controlled worker only.
	const nodeEntryArguments = fileEntry ? queryAncestors ? [workload] : ["--preserve-symlinks", "--preserve-symlinks-main", workload] : ["--input-type=module", "-e", WORKLOAD, "--"];
	if (fileEntry && queryAncestors) report.nodeEntry = "ordinary-file-entry";
	const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, COMSPEC: `${process.env.SystemRoot}\\System32\\cmd.exe`, PATHEXT: ".COM;.EXE;.BAT;.CMD", LOCALAPPDATA: temporary, TEMP: temporary, TMP: temporary, TMPDIR: temporary, PATH: `${path.dirname(process.execPath)};${process.env.SystemRoot}\\System32`, MXC_DACL_STATE_DIR: state };
	assert.ok(env.SystemRoot, "SYSTEMROOT is required");
	server = net.createServer(socket => { connections++; socket.destroy(); });
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const port = server.address().port;
	await new Promise((resolve, reject) => {
		const control = net.createConnection({ host: "127.0.0.1", port });
		control.once("error", reject);
		control.setTimeout(1000, () => { control.destroy(); reject(new Error("Host loopback positive control timed out")); });
		control.once("connect", () => { control.destroy(); resolve(); });
	});
	check("host-loopback-positive-control", () => assert.equal(connections, 1));
	const policy = {
		version: "1.0.0", containment: "processcontainer", containerId: path.basename(fixture),
		fallback: { allowDaclMutation: false }, telemetry: { enabled: false },
		lifecycle: { destroyOnExit: true, preservePolicy: false },
		process: { commandLine: "node --version", cwd: workspace, timeout: 10_000, env: Object.entries(env).filter(([key]) => key !== "MXC_DACL_STATE_DIR").map(([key, value]) => `${key}=${value}`), inheritDefaultEnv: false },
		filesystem: { readwritePaths: [workspace, temporary], readonlyPaths: [tools, path.dirname(process.execPath), protectedDirectory, ...(project ? [project] : []), ...(powershell ? [path.dirname(powershell)] : [])], deniedPaths: [path.join(fixture, "outside")] },
		network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
		ui: { disable: !allowWin32k, clipboard: desktopSharedClipboard ? "all" : "none", injection: false },
		processContainer: { capabilities: desktopSharedClipboard ? ["registryRead"] : [], filesystem: { enumeratePaths }, ui: { isolation: desktopSharedClipboard ? "desktop" : "container", desktopSystemControl: false, systemSettings: "none", ime: false } },
	};
	const config = path.join(fixture, "policy.json");
	{
		fs.writeFileSync(config, JSON.stringify(policy));
		const probe = requireSuccess(await invoke(executor, ["--probe", config], workspace, env));
		report.probe = probe;
		check("request-probe-base-container-without-dacl", () => {
			assert.equal(probe.error, undefined);
			assert.equal(probe.tier, "base-container");
			assert.equal(probe.needsDaclAugmentation, false);
			assert.deepEqual(probe.warnings, []);
		});
		for (const mode of ["write", "plan"]) {
			if (mode === "plan") { policy.filesystem.readwritePaths = [temporary]; policy.filesystem.readonlyPaths.push(workspace); }
			fs.writeFileSync(config, JSON.stringify(policy));
			const started = performance.now();
			const result = requireSuccess(await invoke(executor, [config, "--", process.execPath, ...nodeEntryArguments, mode, fixture, String(port), ARGUMENT, project, readRelative], workspace, env));
			result.elapsedMs = Math.round(performance.now() - started);
			report[mode] = result;
			check(mode + "-files-argv-stdio-loopback", () => {
				assert.equal(result.cwd, workspace); assert.equal(result.literal, ARGUMENT); assert.equal(result.stdin, STDIN);
				assert.equal(result.workspaceRead.ok, true); assert.equal(result.toolRead.value, "unchanged"); assert.equal(result.tempWrite.ok, true);
				if (mode === "write") { assert.equal(result.workspaceWrite.ok, true); assert.equal(result.workspaceRenameDelete.ok, true); }
				else { denied(result.workspaceWrite); denied(result.workspaceRenameDelete); }
				for (const field of ["protectedWrite", "protectedDelete", "protectedRename", "toolWrite", "outsideRead", "outsideWrite", "ungrantedRead", "ancestorContentRead", "junctionRead"]) denied(result[field]);
				if (queryAncestors) assert.deepEqual(result.ungrantedList, { ok: true, value: ["canary"] });
				else denied(result.ungrantedList);
				if (fileEntry) assert.deepEqual(result.imports, ["esm-loaded", "commonjs-loaded"]);
				if (queryAncestors) assert.equal(result.driveRootMetadata.ok, true);
				else denied(result.driveRootMetadata);
				assert.equal(result.loopback.connected, false); assert.equal(connections, 1);
				assert.equal(fs.readFileSync(path.join(workspace, "中文.txt"), "utf8"), "allowed");
				assert.equal(fs.readFileSync(path.join(tools, "canary"), "utf8"), "unchanged");
				assert.equal(fs.readFileSync(path.join(fixture, "outside", "canary"), "utf8"), "unchanged");
				assert.equal(fs.readFileSync(path.join(protectedDirectory, "canary"), "utf8"), "unchanged");
				assert.equal(fs.existsSync(path.join(fixture, "outside", "new")), false);
				if (project) {
					assert.equal(result.project.entries, fs.readdirSync(project).length);
					assert.equal(result.project.documentBytes, fs.statSync(path.join(project, readRelative)).size);
				}
			});
		}
		policy.filesystem.readwritePaths = [workspace, temporary];
		policy.filesystem.readonlyPaths.pop();
		fs.writeFileSync(config, JSON.stringify(policy));
		if (powershell) {
			// Ordinary shell and package launcher, not a specially rewritten command.
			// Check output AND stderr: PowerShell can exit 0 after a script error.
			const script = path.join(tools, "shell-check.ps1");
			fs.writeFileSync(script, '$ErrorActionPreference="Stop"; if ($PSVersionTable.PSVersion.Major -ne 7) { throw "PowerShell 7 required" }; @{ok=$true; edition=$PSVersionTable.PSEdition} | ConvertTo-Json -Compress');
			const started = performance.now();
			const shell = requireSuccess(await invoke(executor, [config, "--", powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], workspace, env));
			check("ordinary-powershell-7", () => assert.deepEqual(shell, { ok: true, edition: "Core" }));
			report.powershellMs = Math.round(performance.now() - started);
			const npmStarted = performance.now();
			const npm = await invoke(executor, [config, "--", powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "npm --version"], workspace, env);
			check("ordinary-npm-launcher", () => {
				assert.equal(npm.expired, false); assert.equal(npm.overflow, false); assert.equal(npm.code, 0);
				assert.equal(npm.errors, ""); assert.equal(npm.observation.outputDrained, true);
				assert.match(npm.output.trim(), /^\d+\.\d+\.\d+$/);
			});
			report.npm = { version: npm.output.trim(), elapsedMs: Math.round(performance.now() - npmStarted) };
		}
		const canceled = await invoke(executor, [config, "--", process.execPath, ...nodeEntryArguments, "cancel", fixture, String(port)], workspace, env, true);
		check("nested-job-descendant-cancel-and-drain", () => {
			assert.equal(canceled.canceled, true); assert.equal(canceled.expired, false); assert.equal(canceled.overflow, false);
			assert.equal(canceled.errors, ""); assert.equal(canceled.observation.outputDrained, true);
		});
		report.canceledDescendantPid = canceled.descendantPid;
		report.jobs = windowsShellJobDiagnostics();
		check("no-owned-handles-or-dacl-state", () => {
			assert.equal(report.jobs.handles, 0); assert.equal(report.jobs.processHandles, 0);
			assert.equal(report.jobs.created, powershell ? 6 : 4); assert.ok(report.jobs.cleanupChecks >= report.jobs.created);
			assert.deepEqual(fs.readdirSync(state), []);
		});
		report.passed = true;
	}
}

try { await main(); }
catch (error) { report.passed = false; report.error = String(error).slice(0, 4000); process.exitCode = 1; }
finally {
	if (server?.listening) await new Promise(resolve => server.close(resolve));
	report.jobs = windowsShellJobDiagnostics();
	report.cleanupConfirmed = cleanupConfirmed;
	// Delete only our recorded fixture after the exact owner confirmed cleanup.
	try {
		if (fixture && cleanupConfirmed) {
			assert.equal(path.dirname(fs.realpathSync(fixture)), fixtureParent);
			assert.equal(fs.lstatSync(fixture).isSymbolicLink(), false);
			if (junctionCreated) fs.unlinkSync(path.join(fixture, "工作区 space", "escape"));
			fs.rmSync(fixture, { recursive: true });
			report.fixtureRemoved = !fs.existsSync(fixture);
		}
	} catch (error) { report.cleanupError = String(error).slice(0, 1000); report.passed = false; process.exitCode = 1; }
	// Never overwrite a prior result, even after a failed precondition.
	if (process.argv[3] && !fs.existsSync(path.resolve(process.argv[3]))) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(report, null, 2), { flag: "wx" });
	console.log(JSON.stringify(report, null, 2));
}
