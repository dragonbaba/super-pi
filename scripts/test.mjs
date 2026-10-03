import { existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_TEST_ROOT = resolve(REPOSITORY_ROOT, "tests");
const TEST_FILE_PATTERN = /\.test\.(?:[cm]?[jt]s)$/;
const HOT_TEST_PATTERN = /(?:^|\/)(?:source-invariants|hot-source-invariants|[^/]*hot-paths)\.test\./;

// These offline integration fixtures need an empty working directory as well as
// an isolated home. They used to run twice, once through the standalone probe.
const ISOLATED_CWD_TESTS = new Set([
	"alpha-stream-corpus.test.ts", "alpha-stream-endings.test.ts", "alpha-stream-markers.test.ts",
	"alpha-markdown-ownership.test.ts", "alpha-assistant-update.test.ts", "alpha-retained-active.test.ts",
	"alpha-cli.test.ts", "alpha-active-quit.test.ts", "alpha-compaction-quit.test.ts", "alpha-session-replacement.test.ts",
	"alpha-g2-raw.test.ts", "alpha-ansi.test.ts", "alpha-raw-session.test.ts", "alpha-raw-parallel.test.ts",
	"alpha-image.test.ts", "alpha-upstream-truncation.test.ts", "alpha-footer-scans.test.ts", "alpha-lifecycle.test.ts",
	"alpha-runtime-dispose.test.ts", "alpha-startup-quit.test.ts", "alpha-crash-cleanup.test.ts", "alpha-startup-faults.test.ts",
]);
const GC_TESTS = new Set([
	"alpha-assistant-update.test.ts", "alpha-markdown-ownership.test.ts",
	"alpha-raw-parallel.test.ts", "alpha-startup-quit.test.ts",
]);
// Started first so the longest files do not extend the tail of a parallel run.
// Order only; every discovered file still runs exactly once.
const SLOW_TESTS = [
	"alpha-raw-parallel.test.ts", "alpha-cli.test.ts", "alpha-startup-faults.test.ts",
	"shell-incident-launcher.test.mjs", "tui-frame-queue.test.ts", "alpha-raw-session.test.ts",
	"bash-running-responsiveness.test.ts", "next-phase-task-matrix.test.ts", "codemode-session.test.ts",
];
const MAX_DEFAULT_JOBS = 8;
const MEMORY_LABEL = "@super-pi/memory workspace";

function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeTestPath(value) {
	return value.replaceAll("\\", "/");
}

export function classifyTestFile(file) {
	const normalized = normalizeTestPath(file);
	if (normalized.includes("/provider-contract/") || normalized.startsWith("provider-contract/") || normalized.includes(".contract.test.")) {
		return "contract";
	}
	if (HOT_TEST_PATTERN.test(normalized)) return "hot";
	return "unit";
}

export function discoverTestFiles(root = DEFAULT_TEST_ROOT) {
	const absoluteRoot = resolve(root);
	const discovered = [];
	const pending = [absoluteRoot];

	while (pending.length > 0) {
		const directory = pending.pop();
		const entries = readdirSync(directory, { withFileTypes: true });
		entries.sort((left, right) => compareCodeUnits(left.name, right.name));
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			const absolute = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				pending.push(absolute);
			} else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
				discovered.push(normalizeTestPath(relative(absoluteRoot, absolute)));
			}
		}
	}

	return discovered.sort(compareCodeUnits);
}

function parseJobs(value, source) {
	const jobs = Number(value);
	if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`${source} must be a positive integer`);
	return jobs;
}

export function defaultJobs(env = process.env) {
	if (env.SP_TEST_JOBS !== undefined && env.SP_TEST_JOBS !== "") return parseJobs(env.SP_TEST_JOBS, "SP_TEST_JOBS");
	return Math.max(1, Math.min(availableParallelism(), MAX_DEFAULT_JOBS));
}

function parseArguments(argv) {
	const options = { suite: "all", root: DEFAULT_TEST_ROOT, skipMemory: false, list: false, jobs: undefined };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--suite") {
			options.suite = argv[++index];
		} else if (argument === "--root") {
			options.root = resolve(argv[++index]);
		} else if (argument === "--skip-memory") {
			options.skipMemory = true;
		} else if (argument === "--list") {
			options.list = true;
		} else if (argument === "--jobs") {
			options.jobs = parseJobs(argv[++index], "--jobs");
		} else {
			throw new Error(`Unknown test runner argument: ${argument}`);
		}
	}
	if (!new Set(["all", "unit", "hot", "contract"]).has(options.suite)) {
		throw new Error(`Unknown test suite: ${options.suite}`);
	}
	options.jobs ??= defaultJobs();
	return options;
}

/** Slow files first, in their listed order; everything else keeps discovery order. */
export function scheduleTestFiles(files) {
	const slow = [];
	for (const file of SLOW_TESTS) if (files.includes(file)) slow.push(file);
	if (slow.length === 0) return files;
	const scheduled = slow.slice();
	for (const file of files) if (!SLOW_TESTS.includes(file)) scheduled.push(file);
	return scheduled;
}

// Output is buffered per child and printed as one block, so parallel files never interleave.
function runChild(label, command, args, cwd) {
	const root = mkdtempSync(resolve(tmpdir(), "super-pi-test-"));
	const started = performance.now();
	console.log(`[test] START ${label}`);
	const output = [];
	return new Promise((settle) => {
		let child;
		const finish = (status, signal, error) => {
			let exitCode = 0;
			try {
				// Only remove this invocation's exact, directly-created temporary child.
				if (dirname(root) !== resolve(tmpdir())) throw new Error("temporary root escaped");
				rmSync(root, { recursive: true, force: true });
			} finally {
				for (const [stream, chunk] of output) stream.write(chunk);
				console.log(`[test] END ${label} ms=${Math.round(performance.now() - started)} exit=${status ?? "none"} signal=${signal ?? "none"}`);
				if (error) {
					console.error(`[test] ${label} failed to start: ${error.message}`);
					exitCode = 1;
				} else if (status !== 0) {
					exitCode = status ?? 1;
					console.error(`[test] ${label} failed with exit code ${exitCode}`);
				}
				settle(exitCode);
			}
		};
		try {
			mkdirSync(resolve(root, "agent"));
			mkdirSync(resolve(root, "sessions"));
			child = spawn(command, args, {
				cwd: cwd ?? root, stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
					SP_CODING_AGENT_DIR: resolve(root, "agent"), SP_CODING_AGENT_SESSION_DIR: resolve(root, "sessions"),
					SP_OFFLINE: "1", SP_TUI_WRITE_LOG: "" },
			});
		} catch (error) {
			finish(undefined, undefined, error);
			return;
		}
		child.stdout.on("data", (chunk) => output.push([process.stdout, chunk]));
		child.stderr.on("data", (chunk) => output.push([process.stderr, chunk]));
		let startError;
		child.once("error", (error) => { startError = error; });
		// A failed spawn emits "error" and then "close" with a negative errno status.
		child.once("close", (status, signal) => finish(status, signal, startError));
	});
}

function memoryCommand() {
	const bundledNpmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	const npmCli = process.env.npm_execpath || (existsSync(bundledNpmCli) ? bundledNpmCli : undefined);
	return npmCli
		? { command: process.execPath, args: [npmCli, "test", "--workspace", "@super-pi/memory"] }
		: { command: "npm", args: ["test", "--workspace", "@super-pi/memory"] };
}

export async function run(options) {
	const files = discoverTestFiles(options.root).filter(
		(file) => options.suite === "all" || classifyTestFile(file) === options.suite,
	);
	if (options.list) {
		for (const file of files) console.log(file);
		return 0;
	}

	const units = [];
	for (const file of scheduleTestFiles(files)) {
		const args = ["--experimental-strip-types", "--test", resolve(options.root, file)];
		if (GC_TESTS.has(file)) args.unshift("--expose-gc");
		units.push({ label: file, command: process.execPath, args, cwd: ISOLATED_CWD_TESTS.has(file) ? undefined : REPOSITORY_ROOT });
	}
	const includeMemory = !options.skipMemory && (options.suite === "all" || options.suite === "unit");
	if (includeMemory) units.push({ label: MEMORY_LABEL, ...memoryCommand(), cwd: REPOSITORY_ROOT });
	if (units.length === 0) {
		console.log(`[test] no ${options.suite} tests discovered`);
		return 0;
	}

	// After the first failure no new child starts; running children finish and report.
	const jobs = Math.min(options.jobs ?? defaultJobs(), units.length);
	console.log(`[test] running ${units.length} units with ${jobs} parallel job(s)`);
	let next = 0, firstFailure = 0;
	const worker = async () => {
		while (firstFailure === 0 && next < units.length) {
			const unit = units[next++];
			const exitCode = await runChild(unit.label, unit.command, unit.args, unit.cwd);
			if (exitCode !== 0 && firstFailure === 0) firstFailure = exitCode;
		}
	};
	const workers = [];
	for (let index = 0; index < jobs; index++) workers.push(worker());
	await Promise.all(workers);
	return firstFailure;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
	try {
		process.exitCode = await run(parseArguments(process.argv.slice(2)));
	} catch (error) {
		console.error(`[test] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
