// Manual acceptance only. Builds the pinned Microsoft UI probe with a startup
// station-identity guard and a fail-closed clipboard-seed prerequisite, and
// a private-window-station host. The separate --interactive mode requires the
// user to authorize foreground windows AND replacement of clipboard contents.
// Never automatically retry private-station failures on the interactive desktop.
// Usage: node scripts/acceptance/windows-mxc-ui-preflight.mjs <wxc-exec.exe> <upstream main.rs> <new report.json> [--interactive|--interactive-injection|--interactive-clipboard]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WindowsShellJob, windowsShellJobDiagnostics } from "../../packages/coding-agent/src/utils/windows-shell-job.ts";
import { waitForChildProcess } from "../../packages/coding-agent/src/utils/child-process.ts";

const EXECUTOR_HASH = "090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a";
const PROBE_SOURCE_HASH = "2e1735ec2e09f1e04ad569267c29dcf336606c9c37acd1f3285c42b0c43f598d";
const TAGS = ["READCLIPBOARD", "WRITECLIPBOARD", "HANDLES", "INJECTION"];
// Refuse before upstream clipboard/input code can run. Keeping this
// guard native avoids introducing a CLR runtime into the contained workload.
const STATION_GUARD = String.raw`
fn superpi_verify_station() {
    let user32 = load_user32().unwrap_or_else(|| { eprintln!("UI guard could not load user32: {}", unsafe { GetLastError() }); std::process::exit(125) });
    type StationFn = unsafe extern "system" fn() -> *mut std::ffi::c_void;
    type InfoFn = unsafe extern "system" fn(*mut std::ffi::c_void, i32, *mut std::ffi::c_void, u32, *mut u32) -> i32;
    let station_fn: StationFn = unsafe { std::mem::transmute(get_proc(user32, "GetProcessWindowStation").expect("station API")) };
    let info_fn: InfoFn = unsafe { std::mem::transmute(get_proc(user32, "GetUserObjectInformationW").expect("station info API")) };
    let expected = std::env::args().find_map(|arg| arg.strip_prefix("--superpi-station=").map(str::to_owned));
    let interactive = std::env::args().any(|arg| arg == "--superpi-interactive=true");
    let tags_allowed = std::env::args().skip(1).filter(|arg| !arg.starts_with("--")).all(|arg| matches!(arg.as_str(), "READCLIPBOARD" | "WRITECLIPBOARD" | "HANDLES" | "INJECTION"));
    let mut name = [0u16; 128];
    let mut flags = [0u32; 3];
    let mut needed = 0u32;
    let station = unsafe { station_fn() };
    let name_ok = unsafe { info_fn(station, 2, name.as_mut_ptr().cast(), 256, &mut needed) } != 0;
    let flags_ok = unsafe { info_fn(station, 1, flags.as_mut_ptr().cast(), 12, &mut needed) } != 0;
    let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
    let actual = String::from_utf16_lossy(&name[..end]);
    let station_allowed = if interactive { actual == "WinSta0" && flags[2] & 1 != 0 } else { actual.starts_with("SuperPiMxcUi-") && flags[2] & 1 == 0 };
    if !name_ok || !flags_ok || !station_allowed || !tags_allowed || expected.as_deref() != Some(actual.as_str()) {
        eprintln!("Refusing UI probe outside the explicitly selected station or tag set");
        std::process::exit(125);
    }
}
`;
const SEED_PREREQUISITE = String.raw`
    if let Err(reason) = &seed {
        // Never fall through to reading pre-existing clipboard contents when
        // the fixed synthetic seed could not be installed.
        emit_diag("READCLIPBOARD", &format!("seed prerequisite failed: {reason}"));
        emit_inconclusive("READCLIPBOARD");
        return;
    }
`;
const CLIPBOARD_IDENTITY = String.raw`
static SUPERPI_CLIPBOARD_SEQUENCE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
fn superpi_clipboard_sequence(user32: Hmodule) -> u32 {
    type SequenceFn = unsafe extern "system" fn() -> u32;
    match get_proc(user32, "GetClipboardSequenceNumber") {
        Some(p) => unsafe { std::mem::transmute::<FarProc, SequenceFn>(p)() },
        None => 0,
    }
}
fn superpi_seed_still_owned(user32: Hmodule, owner: Hwnd) -> bool {
    type OwnerFn = unsafe extern "system" fn() -> Hwnd;
    let expected = SUPERPI_CLIPBOARD_SEQUENCE.load(std::sync::atomic::Ordering::Relaxed);
    let current = match get_proc(user32, "GetClipboardOwner") {
        Some(p) => unsafe { std::mem::transmute::<FarProc, OwnerFn>(p)() },
        None => return false,
    };
    let actual = superpi_clipboard_sequence(user32);
    if expected == 0 || current != owner || actual != expected {
        emit_diag("READCLIPBOARD", &format!("identity expected_owner={} actual_owner={} expected_sequence={} actual_sequence={}", owner as isize, current as isize, expected, actual));
        return false;
    }
    true
}
fn superpi_external_seed() -> Result<Hwnd, String> {
    let owner = std::env::args().find_map(|a| a.strip_prefix("--superpi-seed-owner=").and_then(|s| s.parse::<isize>().ok())).unwrap_or(0);
    let sequence = std::env::args().find_map(|a| a.strip_prefix("--superpi-seed-sequence=").and_then(|s| s.parse::<u32>().ok())).unwrap_or(0);
    if owner == 0 || sequence == 0 { return Err("missing host seed identity".into()); }
    SUPERPI_CLIPBOARD_SEQUENCE.store(sequence, std::sync::atomic::Ordering::Relaxed);
    Ok(owner as Hwnd)
}
fn superpi_verify_written_text(user32: Hmodule, owner: Hwnd, memory: Hglobal) -> bool {
    // Called while the writer still holds the clipboard lock. Read only the
    // exact allocation just supplied by this process, with its known length.
    type OwnerFn = unsafe extern "system" fn() -> Hwnd;
    type GetFn = unsafe extern "system" fn(u32) -> Hglobal;
    let get_owner: OwnerFn = unsafe { std::mem::transmute(get_proc(user32, "GetClipboardOwner").expect("owner API")) };
    let get_data: GetFn = unsafe { std::mem::transmute(get_proc(user32, "GetClipboardData").expect("get API")) };
    if unsafe { get_owner() } != owner || unsafe { get_data(CF_UNICODETEXT) } != memory { return false; }
    let buffer = unsafe { GlobalLock(memory) };
    if buffer.is_null() { return false; }
    let expected = to_wide("MXC_UI_PROBE_WRITE");
    let same = unsafe { std::slice::from_raw_parts(buffer as *const u16, expected.len()) } == expected.as_slice();
    unsafe { let _ = GlobalUnlock(memory); }
    same
}
fn superpi_host_verify_write(owner: Hwnd, sequence: u32) -> bool {
    if !std::env::args().any(|a| a == "--superpi-foreground-clipboard=true") { return true; }
    let ready = std::env::args().find_map(|a| a.strip_prefix("--superpi-write-ready=").map(str::to_owned)).expect("write ready path");
    let release = std::env::args().find_map(|a| a.strip_prefix("--superpi-write-release=").map(str::to_owned)).expect("write release path");
    assert!(sequence != 0 && !owner.is_null());
    std::fs::write(&ready, format!("{} {}", owner as isize, sequence)).expect("write identity");
    // Completion is published only after the metadata file has been closed.
    // This needs create/write access, not an additional rename capability.
    std::fs::File::create_new(format!("{ready}.complete")).expect("publish identity");
    let deadline = Instant::now();
    while deadline.elapsed() < Duration::from_secs(3) {
        if let Ok(metadata) = std::fs::metadata(&release) {
            return metadata.len() == 8 && std::fs::read(&release).ok().as_deref() == Some(b"verified");
        }
        thread::sleep(Duration::from_millis(25));
    }
    false
}
`;
const FOREGROUND_CLIPBOARD = String.raw`
    if std::env::args().any(|a| a == "--superpi-foreground-clipboard=true") {
        let tag = std::env::args().find(|a| a == "READCLIPBOARD" || a == "WRITECLIPBOARD").expect("clipboard tag");
        let fg = unsafe { get_foreground() };
        let mut pid = 0u32;
        if !fg.is_null() { unsafe { get_wtpid(fg, &mut pid); } }
        if fg == hwnd && pid == self_pid {
            println!("CLIPBOARD_FOREGROUND=OWNED");
            if tag == "READCLIPBOARD" { probe_readclipboard(user32); } else { probe_writeclipboard(user32); }
        } else {
            emit_diag(&tag, "foreground lost before clipboard operation");
            emit_inconclusive(&tag);
        }
        let destroyed = unsafe { destroy_window(hwnd) };
        let unregistered = unsafe { unregister_class(class_name.as_ptr(), hinstance) };
        assert!(destroyed != 0 && unregistered != 0, "Clipboard foreground cleanup failed");
        return;
    }
`;
const report = { node: process.version, upstreamRevision: "fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2", results: {} };
let fixture, fixtureParent, cleanupConfirmed = true;

// Fixed-version output contract: FAIL alone also covers missing APIs, wrong
// HWND owners and failed clipboard readback. Require the actual control proof.
export function evaluateUiProbe(tag, control = "", contained = "", foregroundClipboard = false) {
	assert.ok(TAGS.includes(tag), "Unknown UI probe tag");
	const status = new RegExp(`^${tag}=(PASS|FAIL|INCONCLUSIVE)\\r?$`, "gm");
	const controls = [...control.matchAll(status)], restrictions = [...contained.matchAll(status)];
	const controlStatus = controls.length === 1 ? controls[0][1] : "MISSING_OR_AMBIGUOUS";
	const containedStatus = restrictions.length === 1 ? restrictions[0][1] : "MISSING_OR_AMBIGUOUS";
	const normalized = control.replaceAll("\r\n", "\n").trim();
	const prefix = foregroundClipboard ? "CLIPBOARD_FOREGROUND=OWNED\n" : "";
	const expected = tag === "READCLIPBOARD" ? "READCLIPBOARD=DIAG GetClipboardData returned the seeded text\nREADCLIPBOARD=FAIL"
		: tag === "WRITECLIPBOARD" ? "WRITECLIPBOARD=DIAG GetClipboardData returned the written text\nWRITECLIPBOARD=FAIL"
		: tag === "INJECTION" ? "INJECTION=DIAG SendInput injected 1/1 gle=0 (owns foreground)\nINJECTION=FAIL" : `${tag}=FAIL`;
	const suffix = foregroundClipboard && tag === "WRITECLIPBOARD" ? "\nHOST_CLIPBOARD_WRITE=CONFIRMED" : "";
	const controlProven = controlStatus === "FAIL" && normalized === prefix + expected + suffix;
	const containedForeground = !foregroundClipboard || contained.replaceAll("\r\n", "\n").startsWith(prefix);
	// Entry denial is diagnostic only: it does not prove Get/Set was reached
	// and may also reflect clipboard contention. Never count it as acceptance.
	const denial = tag === "READCLIPBOARD" && !foregroundClipboard ? "seed prerequisite failed: OpenClipboard failed gle=5" : "OpenClipboard failed gle=5";
	const clipboardEntryDenied = (tag === "READCLIPBOARD" || tag === "WRITECLIPBOARD")
		&& contained.replaceAll("\r\n", "\n").trim() === `${prefix}${tag}=DIAG ${denial}\n${tag}=INCONCLUSIVE`;
	const clipboardMutationObserved = tag === "WRITECLIPBOARD"
		&& contained.includes("WRITECLIPBOARD=DIAG SetClipboardData denied after EmptyClipboard succeeded gle=5");
	const blockedBeforeMutation = tag !== "WRITECLIPBOARD"
		|| contained.replaceAll("\r\n", "\n").trim() === `${prefix}WRITECLIPBOARD=DIAG EmptyClipboard denied gle=5\nWRITECLIPBOARD=PASS`;
	const dataOperationDenied = controlProven && containedForeground && containedStatus === "PASS";
	return { control: controlStatus, contained: containedStatus, controlProven, clipboardEntryDenied,
		dataOperationDenied, clipboardMutationObserved,
		accepted: dataOperationDenied && blockedBeforeMutation && !clipboardMutationObserved };
}

async function hashFile(file) {
	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

async function run(executable, args, env, deadlineMs = 30000) {
	cleanupConfirmed = false;
	const job = await WindowsShellJob.spawn(executable, args, fixture, env, false);
	const observation = { started: false, exitCode: null, signal: null, outputDrained: false };
	const waiting = waitForChildProcess(job.child, observation).then(code => ({ code }), error => ({ error }));
	let output = "", errors = "", bytes = 0, expired = false, overflow = false, timer;
	function receive(chunk, stderr) {
		bytes += Buffer.byteLength(chunk, "utf8");
		if (bytes > 65536) { overflow = true; void job.stop(); return; }
		if (stderr) errors += chunk; else output += chunk;
	}
	function stdout(chunk) { receive(chunk, false); }
	function stderr(chunk) { receive(chunk, true); }
	job.child.stdout.setEncoding("utf8"); job.child.stderr.setEncoding("utf8");
	job.child.stdout.on("data", stdout); job.child.stderr.on("data", stderr);
	try {
		const deadline = new Promise(resolve => { timer = setTimeout(() => { expired = true; void job.stop(); resolve({}); }, deadlineMs); });
		const result = await Promise.race([waiting, deadline]);
		if (result.error) throw result.error;
		if (expired || overflow || result.code !== 0 || errors) report.failedRun = { executable: path.basename(executable), code: result.code, expired, overflow, output, errors };
		assert.equal(expired, false, "Owned UI fixture timed out");
		assert.equal(overflow, false, "Owned UI fixture exceeded output limit");
		assert.equal(result.code, 0, errors || output);
		assert.equal(observation.outputDrained, true);
		assert.equal(errors, "", "Unexpected compiler/probe diagnostics: " + errors);
		return output;
	} finally {
		clearTimeout(timer);
		const failure = await job.stop();
		job.child.stdout.removeListener("data", stdout); job.child.stderr.removeListener("data", stderr);
		if (failure) throw new Error(failure);
		cleanupConfirmed = true;
		assert.equal(job.launchError, undefined); assert.equal(job.dispatchError, undefined);
	}
}

async function main() {
	assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
	assert.ok(process.argv.length === 5 || process.argv.length === 6 && ["--interactive", "--interactive-injection", "--interactive-clipboard"].includes(process.argv[5]), "Pass executor, pinned upstream source, a new report path, and optional explicit interactive mode");
	const injectionOnly = process.argv[5] === "--interactive-injection";
	const clipboardOnly = process.argv[5] === "--interactive-clipboard";
	const foreground = injectionOnly || clipboardOnly;
	const interactive = foreground || process.argv[5] === "--interactive";
	const tags = clipboardOnly ? ["READCLIPBOARD", "WRITECLIPBOARD"] : injectionOnly ? ["INJECTION"] : TAGS;
	report.scope = clipboardOnly ? "clipboard-only" : injectionOnly ? "input-injection-only" : "full-ui";
	report.environment = interactive ? "interactive-desktop-explicit" : "private-invisible-station";
	assert.equal(fs.existsSync(path.resolve(process.argv[4])), false, "Refusing to overwrite a report");
	const executor = fs.realpathSync(process.argv[2]);
	const source = fs.realpathSync(process.argv[3]);
	assert.equal(await hashFile(executor), EXECUTOR_HASH, "Unreviewed executor");
	assert.equal(await hashFile(source), PROBE_SOURCE_HASH, "Unreviewed upstream probe source");
	fixtureParent = fs.realpathSync(os.tmpdir());
	fixture = fs.mkdtempSync(path.join(fixtureParent, "superpi-mxc-ui-"));
	report.fixture = fixture;
	const tools = path.join(fixture, "tools"), workspace = path.join(fixture, "workspace"), temporary = path.join(fixture, "temporary"), state = path.join(fixture, "dacl-state");
	for (const directory of [tools, workspace, temporary, state]) fs.mkdirSync(directory);
	const probe = path.join(tools, "wxc-ui-probe.exe"), host = path.join(tools, "windows-mxc-ui-host.exe");
	const hostSource = fileURLToPath(new URL("./windows-mxc-ui-host.cs", import.meta.url));
	const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
	const rustc = path.join(os.homedir(), ".cargo", "bin", "rustc.exe");
	const original = fs.readFileSync(source, "utf8");
	assert.equal(original.split("\nfn main() {").length, 2, "Upstream entry point changed");
	const seedAnchor = "    let seed = seed_unicode_clipboard(user32);";
	assert.equal(original.split(seedAnchor).length, 2, "Upstream clipboard seed prerequisite changed");
	const seedComplete = "    unsafe {\n        let _ = close();\n    }\n    Ok(owner)";
	const beforeRead = '    // Sampled before the fetch so "is the format even here" is answered';
	assert.equal(original.split(seedComplete).length, 2, "Upstream seed publication changed");
	assert.equal(original.split(beforeRead).length, 2, "Upstream clipboard read boundary changed");
	const foregroundWait = "    for _ in 0..20 {";
	assert.equal(original.split(foregroundWait).length, 2, "Upstream foreground wait changed");
	const guardedSource = path.join(tools, "guarded-probe.rs");
	const foregroundAnchor = "    // We own the foreground -> the kernel reaches the injection job-limit check.";
	const seedRelease = "        if let (Ok(owner), Some(destroy)) = (&seed, destroy_window) {";
	const writeResult = "    let error = unsafe { GetLastError() };\n    unsafe {\n        let _ = close();\n        let _ = destroy_window(owner);\n    }\n    if !set_ok.is_null() {\n        emit_fail(\"WRITECLIPBOARD\");";
	const emptyDenied = '        if error == ERROR_ACCESS_DENIED {\n            emit_pass("WRITECLIPBOARD");';
	const setDenied = '    } else if error == ERROR_ACCESS_DENIED {\n        unsafe {\n            let _ = GlobalFree(memory);\n        }\n        emit_pass("WRITECLIPBOARD");';
	for (const anchor of [foregroundAnchor, seedRelease, writeResult, emptyDenied, setDenied]) assert.equal(original.split(anchor).length, 2, "Upstream clipboard boundary changed");
	fs.writeFileSync(guardedSource, original.replace("\nfn main() {", `\nfn main() {\n    superpi_verify_station();
    if std::env::args().any(|a| a == "--superpi-foreground-clipboard=true") {
        assert!(std::env::args().filter(|a| a == "READCLIPBOARD" || a == "WRITECLIPBOARD").count() == 1);
        probe_injection(load_user32().expect("user32")); return;
    }`)
		.replace(seedAnchor, '    let external_seed = std::env::args().any(|a| a == "--superpi-foreground-clipboard=true");\n    let seed = if external_seed { superpi_external_seed() } else { seed_unicode_clipboard(user32) };' + SEED_PREREQUISITE)
		.replace(seedRelease, "        if external_seed { return; }\n" + seedRelease)
		.replace(foregroundAnchor, FOREGROUND_CLIPBOARD + foregroundAnchor)
		.replace(emptyDenied, emptyDenied.replace('            emit_pass', '            emit_diag("WRITECLIPBOARD", "EmptyClipboard denied gle=5");\n            emit_pass'))
		.replace(setDenied, setDenied.replace('        emit_pass', '        emit_diag("WRITECLIPBOARD", "SetClipboardData denied after EmptyClipboard succeeded gle=5");\n        emit_pass'))
		.replace(writeResult, `    let error = unsafe { GetLastError() };
    let verified = !set_ok.is_null() && superpi_verify_written_text(user32, owner, memory);
    let closed = unsafe { close() };
    let mut host_verified = false;
    if verified && closed != 0 && unsafe { open(owner) } != 0 {
        let stable = superpi_verify_written_text(user32, owner, memory);
        let sequence = if stable { superpi_clipboard_sequence(user32) } else { 0 };
        let snapshot_closed = unsafe { close() };
        if stable && snapshot_closed != 0 { host_verified = superpi_host_verify_write(owner, sequence); }
    }
    let destroyed = unsafe { destroy_window(owner) };
    assert!(closed != 0 && destroyed != 0, "Write clipboard cleanup failed");
    if !set_ok.is_null() {
        if !host_verified { emit_diag("WRITECLIPBOARD", "write readback not proven"); emit_inconclusive("WRITECLIPBOARD"); return; }
        emit_diag("WRITECLIPBOARD", "GetClipboardData returned the written text");
        emit_fail("WRITECLIPBOARD");`)
		.replace(foregroundWait, '    for _ in 0..(if std::env::args().any(|a| a == "--superpi-foreground-clipboard=true") { 600 } else if std::env::args().any(|a| a == "--superpi-await-foreground=true") { 800 } else { 20 }) {')
		.replace(seedComplete, "    SUPERPI_CLIPBOARD_SEQUENCE.store(superpi_clipboard_sequence(user32), std::sync::atomic::Ordering::Relaxed);\n" + seedComplete)
		.replace(beforeRead, `    if !superpi_seed_still_owned(user32, *seed.as_ref().expect("seed prerequisite")) {
        unsafe { let _ = close(); }
        release_seed();
        emit_diag("READCLIPBOARD", "seed identity changed before read");
        emit_inconclusive("READCLIPBOARD");
        return;
    }
` + beforeRead) + STATION_GUARD + CLIPBOARD_IDENTITY);
	report.guardedSourceHash = await hashFile(guardedSource);
	await run(rustc, ["--edition=2021", "-C", "opt-level=1", guardedSource, "-o", probe], process.env);
	await run(compiler, ["/nologo", "/target:exe", "/platform:x64", `/out:${host}`, hostSource], process.env);
	report.probeSourceHash = PROBE_SOURCE_HASH;
	report.probeHash = await hashFile(probe); report.hostSourceHash = await hashFile(hostSource);
	const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, LOCALAPPDATA: temporary, TEMP: temporary, TMP: temporary, PATH: path.join(process.env.SystemRoot, "System32"), MXC_DACL_STATE_DIR: state };
	const policy = {
		version: "1.0.0", containment: "processcontainer", containerId: path.basename(fixture),
		fallback: { allowDaclMutation: false }, telemetry: { enabled: false },
		lifecycle: { destroyOnExit: true, preservePolicy: false },
		process: { commandLine: "unused", cwd: workspace, timeout: foreground ? 22000 : 8000, env: Object.entries(env).filter(([key]) => key !== "MXC_DACL_STATE_DIR").map(([key, value]) => `${key}=${value}`), inheritDefaultEnv: false },
		filesystem: { readwritePaths: [workspace, temporary], readonlyPaths: [tools], deniedPaths: [] },
		network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
		ui: { disable: false, clipboard: "none", injection: false },
		processContainer: { ui: { isolation: "container", desktopSystemControl: false, systemSettings: "none", ime: false } },
	};
	const config = path.join(fixture, "ui-policy.json");
	const clipboardControl = path.join(fixture, "clipboard-control-policy.json");
	fs.writeFileSync(config, JSON.stringify(policy));
	fs.writeFileSync(clipboardControl, JSON.stringify({ ...policy, ui: { ...policy.ui, clipboard: "all" }, processContainer: { ui: { ...policy.processContainer.ui, isolation: clipboardOnly ? "desktop" : "container" } } }));
	report.probe = JSON.parse(await run(executor, ["--probe", config], env));
	assert.equal(report.probe.tier, "base-container"); assert.equal(report.probe.needsDaclAugmentation, false);
	assert.deepEqual(report.probe.warnings, []); assert.equal(report.probe.error, undefined);
	report.output = await run(host, [clipboardOnly ? "clipboard" : injectionOnly ? "injection" : interactive ? "interactive" : "host", executor, config, probe, clipboardControl], env, clipboardOnly ? 105000 : injectionOnly ? 55000 : 30000);
	if (clipboardOnly) assert.equal([...report.output.matchAll(/^HOST_CLIPBOARD_SEED=CONFIRMED\r?$/gm)].length, 2);
	assert.match(report.output, interactive ? /^INTERACTIVE_STATION=WinSta0\r?$/m : /^PRIVATE_STATION=SuperPiMxcUi-[a-f0-9]{32}\r?$/m);
	assert.match(report.output, /^UI_HOST_HANDLES=RELEASED\r?$/m);
	assert.match(report.output, /^UI_CHILD_EXIT=CONFIRMED\r?$/m);
	for (const tag of tags) {
		const control = report.output.match(new RegExp(`BEGIN_CONTROL=${tag}\\r?\\n([\\s\\S]*?)END_CONTROL=${tag}`))?.[1];
		const contained = report.output.match(new RegExp(`BEGIN_CONTAINED=${tag}\\r?\\n([\\s\\S]*?)END_CONTAINED=${tag}`))?.[1];
		report.results[tag] = evaluateUiProbe(tag, control, contained, clipboardOnly);
	}
	assert.deepEqual(fs.readdirSync(state), []);
	report.passed = tags.every(tag => report.results[tag].accepted);
	if (!report.passed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
try { await main(); }
catch (error) { report.passed = false; report.error = String(error).slice(0, 4000); process.exitCode = 1; }
finally {
	report.jobs = windowsShellJobDiagnostics(); report.cleanupConfirmed = cleanupConfirmed;
	try {
		if (fixture && cleanupConfirmed) {
			assert.equal(path.dirname(fs.realpathSync(fixture)), fixtureParent);
			assert.equal(fs.lstatSync(fixture).isSymbolicLink(), false);
			fs.rmSync(fixture, { recursive: true });
			report.fixtureRemoved = !fs.existsSync(fixture);
		}
	} catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
	if (process.argv[4] && !fs.existsSync(path.resolve(process.argv[4]))) fs.writeFileSync(path.resolve(process.argv[4]), JSON.stringify(report, null, 2), { flag: "wx" });
	console.log(JSON.stringify(report, null, 2));
}
}
